// Proximity voice, plus video and screen share in A/V rooms. Each pair of
// people who can hear each other (and both have audio on) gets a direct
// WebRTC connection; volume falls off with distance in open areas and is
// full inside a private room. Inside an A/V room the same connection also
// carries camera and screen tracks, but only to people in that room. A
// screen put up on a desk monitor goes to whoever stands within DESK_VIEW.
//
// Inside an A/V room everyone is connected, mic or not: people who haven't
// turned voice on join listen-only (listen()), so they still get the room's
// voices, cameras and screen shares without being asked for a microphone.

import { canHear, zoneAt, HEAR_RADIUS } from './map.js';

// STUN until /api/ice answers; with Cloudflare TURN configured it also
// returns relay servers (short-lived credentials), refetched before they expire.
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
let iceUntil = 0, iceLoading = null;
function loadIce() {
  if (iceLoading || Date.now() < iceUntil) return iceLoading;
  iceLoading = fetch('/api/ice').then((r) => r.ok ? r.json() : null).then((d) => {
    if (d?.iceServers?.length) { ICE = d.iceServers; iceUntil = Date.now() + Math.max(60, d.ttl || 0) * 1000; }
  }).catch(() => {}).finally(() => { iceLoading = null; });
  return iceLoading;
}
export const DESK_VIEW = 4;

export function createVoice({ send, myId, onMedia = () => {}, prefs = {} }) {
  loadIce();
  let local = null; // what we send: the mic after the gain stage (or empty when silent)
  let raw = null;   // the mic itself
  let actx = null;
  let mic = null;   // { src, gain, analyser, data, dest }
  const conns = new Map(); // peerId -> { pc, audio, analyser, data, senders, kinds, remote }
  let muted = false;
  let cam = null, screen = null; // local MediaStreams while on
  let deviceId = prefs.deviceId || '';
  let gain = prefs.gain ?? 1;
  let lvl = 0, loudSince = 0, quietSince = 0;
  let listening = false; // connected listen-only, without having turned voice on

  const getMic = (id) => navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, ...(id ? { deviceId: { exact: id } } : {}) },
  });

  // Receive-only: no mic, nothing asked of the browser. enable() upgrades it.
  function listen() {
    if (local) return;
    actx = new AudioContext();
    actx.resume?.().catch(() => {});
    local = new MediaStream();
    listening = true;
  }

  // `silent` joins without a mic (listen and watch only) if the mic is refused.
  async function enable({ silent = false } = {}) {
    if (local && !listening) return true;
    try {
      raw = await getMic(deviceId).catch((e) => (deviceId && e.name === 'OverconstrainedError' ? getMic('') : Promise.reject(e)));
    } catch (e) {
      if (!silent) return false;
      raw = null;
    }
    if (listening) {
      // Already connected listen-only: keep the calls, add the mic to them.
      listening = false;
      if (!raw) return true;
    } else {
      actx = new AudioContext();
      actx.resume?.().catch(() => {});
    }
    if (raw) {
      // mic -> gain -> (analyser, outgoing track). The analyser sits before the
      // mute switch, so it can still tell when you talk while muted.
      const g = actx.createGain(); g.gain.value = gain;
      const an = actx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0;
      const dest = actx.createMediaStreamDestination();
      g.connect(an); g.connect(dest);
      mic = { src: null, gain: g, analyser: an, data: new Float32Array(an.fftSize), dest };
      plug(raw);
      local = dest.stream;
      local.getAudioTracks().forEach((t) => (t.enabled = !muted));
      for (const c of conns.values()) local.getTracks().forEach((t) => { try { c.pc.addTrack(t, local); } catch (e) { console.warn('rtc', e); } });
    } else {
      local = new MediaStream();
    }
    return true;
  }

  function plug(stream) {
    mic.src?.disconnect();
    mic.src = actx.createMediaStreamSource(stream);
    mic.src.connect(mic.gain);
    deviceId = stream.getAudioTracks()[0]?.getSettings?.().deviceId || deviceId;
  }

  // Switch microphones without renegotiating: only the source feeding the
  // gain stage changes, the outgoing track stays the same.
  async function setDevice(id) {
    deviceId = id;
    if (!raw || !mic) return true;
    let next;
    try { next = await getMic(id); } catch { return false; }
    raw.getTracks().forEach((t) => t.stop());
    raw = next;
    plug(raw);
    return true;
  }

  function setGain(v) {
    gain = v;
    if (mic) mic.gain.gain.setTargetAtTime(v, actx.currentTime, 0.05);
  }

  async function devices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { return []; }
  }

  function disable() {
    stopCam(); stopScreen();
    for (const id of [...conns.keys()]) hangup(id);
    raw?.getTracks().forEach((t) => t.stop());
    local?.getTracks().forEach((t) => t.stop());
    raw = null; local = null; mic = null; lvl = 0; listening = false;
    actx?.close(); actx = null;
  }

  function setMuted(m) {
    muted = m;
    local?.getAudioTracks().forEach((t) => (t.enabled = !m));
  }

  // Mic input level, 0..1 on a -60..0 dBFS scale, fast attack and slow release
  // like a VU meter. Read once per frame by update().
  function readMic(now) {
    if (!mic) { lvl = 0; return; }
    mic.analyser.getFloatTimeDomainData(mic.data);
    let s = 0; for (const v of mic.data) s += v * v;
    const db = 10 * Math.log10(s / mic.data.length + 1e-10);
    const v = Math.max(0, Math.min(1, (db + 60) / 60));
    lvl = v > lvl ? v : lvl * 0.85 + v * 0.15;
    // Speech has gaps between words, so a run of talking only ends after
    // half a second of quiet.
    if (lvl > TALK) { loudSince ||= now; quietSince = 0; } else if ((quietSince ||= now) && now - quietSince > 500) loudSince = 0;
  }
  const TALK = 0.42; // about -35 dBFS

  async function startCam() {
    if (cam) return true;
    try {
      cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { max: 24 } } });
    } catch { return false; }
    onMedia();
    return true;
  }
  function stopCam() { cam?.getTracks().forEach((t) => t.stop()); cam = null; onMedia(); }

  async function startScreen() {
    if (screen) return true;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 15 } }, audio: false });
    } catch { return false; }
    // The browser's own "Stop sharing" button ends the track.
    screen.getVideoTracks()[0].addEventListener('ended', () => { screen = null; onMedia(true); });
    onMedia();
    return true;
  }
  function stopScreen() { screen?.getTracks().forEach((t) => t.stop()); screen = null; onMedia(); }

  // Tell the other side which of our streams is the camera and which is the
  // screen, so it can lay them out. Sent alongside every description.
  const kinds = () => Object.fromEntries([[cam?.id, 'cam'], [screen?.id, 'screen']].filter(([k]) => k));

  function create(id) {
    loadIce();
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const c = {
      pc, audio: new Audio(), analyser: null, data: null, makingOffer: false, polite: myId() > id,
      senders: { cam: null, screen: null }, kinds: {}, remote: { cam: null, screen: null },
    };
    c.audio.autoplay = true;
    local.getTracks().forEach((t) => pc.addTrack(t, local));
    pc.onicecandidate = (e) => e.candidate && send({ t: 'rtc', to: id, data: { ice: e.candidate } });
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      if (e.track.kind === 'audio') {
        c.audio.srcObject = stream;
        c.audio.play().catch(() => {});
        if (actx) {
          const src = actx.createMediaStreamSource(stream);
          c.analyser = actx.createAnalyser(); c.analyser.fftSize = 256;
          src.connect(c.analyser);
          c.data = new Uint8Array(c.analyser.frequencyBinCount);
        }
        return;
      }
      const kind = c.kinds[stream.id] || 'cam';
      c.remote[kind] = stream;
      const gone = () => { if (c.remote[kind] === stream && !stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted)) { c.remote[kind] = null; onMedia(); } };
      stream.onremovetrack = gone;
      e.track.onended = gone;
      e.track.onmute = gone;
      e.track.onunmute = () => { c.remote[kind] = stream; onMedia(); };
      onMedia();
    };
    pc.onnegotiationneeded = async () => {
      try {
        c.makingOffer = true;
        await pc.setLocalDescription();
        send({ t: 'rtc', to: id, data: { sdp: pc.localDescription, kinds: kinds() } });
      } catch (e) { console.warn('rtc', e); } finally { c.makingOffer = false; }
    };
    conns.set(id, c);
    return c;
  }

  function hangup(id) {
    const c = conns.get(id);
    if (!c) return;
    c.pc.close();
    c.audio.srcObject = null;
    conns.delete(id);
    if (c.remote.cam || c.remote.screen) onMedia();
  }

  // Perfect-negotiation pattern so either side can start.
  async function onSignal(from, data) {
    if (!local) return;
    let c = conns.get(from) || create(from);
    const pc = c.pc;
    try {
      if (data.kinds) c.kinds = data.kinds;
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && (c.makingOffer || pc.signalingState !== 'stable');
        if (collision && !c.polite) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription();
          send({ t: 'rtc', to: from, data: { sdp: pc.localDescription, kinds: kinds() } });
        }
      } else if (data.ice) {
        await pc.addIceCandidate(data.ice).catch(() => {});
      }
    } catch (e) { console.warn('rtc', e); }
  }

  // Add, swap or drop one of our video tracks on a connection. Changing the
  // set of tracks renegotiates through onnegotiationneeded.
  function syncTrack(c, kind, stream) {
    const track = stream?.getVideoTracks()[0] || null;
    const s = c.senders[kind];
    if (s && s.track === track) return;
    try {
      if (s) { c.pc.removeTrack(s); c.senders[kind] = null; }
      if (track) c.senders[kind] = c.pc.addTrack(track, stream);
    } catch (e) { console.warn('rtc', e); }
  }

  const level = (an, data) => {
    if (!an) return 0;
    an.getByteFrequencyData(data);
    let s = 0; for (const v of data) s += v;
    return s / data.length;
  };

  // Called every frame with my position and everyone else's.
  // deskScreen: I'm sharing my screen to my desk monitor (not in an A/V room).
  // skip(p): someone reached another way (both of us on a freeq call, freeq-av.js).
  function update(me, peers, deafened, { deskScreen = false, skip = () => false } = {}) {
    const out = { meSpeaking: false, mutedTalking: false, speaking: new Set() };
    if (!local) return out;
    const now = performance.now();
    readMic(now);
    out.meSpeaking = !muted && lvl > TALK;
    // Talking for a moment while muted: worth a nudge.
    out.mutedTalking = muted && loudSince > 0 && now - loudSince > 350;
    const myZone = zoneAt(me.x, me.y);
    const avRoom = myZone?.av ? myZone : null;
    // Something to send means we should start the call ourselves; a
    // listen-only peer has no tracks, so it would never make an offer.
    const sending = !!(mic || cam || screen);
    for (const p of peers) {
      if (p.id === me.id) continue;
      if (skip(p)) { if (conns.has(p.id)) hangup(p.id); continue; }
      // Reachable: voice on, or (mic or not) in the same A/V room as me.
      const linked = p.audio || (avRoom && p.kind !== 'agent' && zoneAt(p.x, p.y) === avRoom);
      const near = linked && canHear(me, p);
      const keep = conns.has(p.id) && linked && (canHear(me, p) || Math.hypot(me.x - p.x, me.y - p.y) < HEAR_RADIUS + 1.5);
      // The lower id starts the call and the other side answers, unless only
      // one side has anything to send; perfect negotiation sorts out overlaps.
      if (near && !conns.has(p.id) && (myId() < p.id || sending)) create(p.id);
      if (!keep && conns.has(p.id) && !near) hangup(p.id);
      const c = conns.get(p.id);
      if (c) {
        const d = Math.hypot(me.x - p.x, me.y - p.y);
        const vol = !canHear(me, p) ? 0 : myZone && myZone.kind === 'room' ? 1 : Math.max(0, Math.min(1, 1.25 - d / HEAR_RADIUS));
        c.audio.volume = deafened ? 0 : vol;
        if (level(c.analyser, c.data) > 14 && vol > 0) out.speaking.add(p.id);
        // Video only flows between people in the same A/V room.
        const share = avRoom && zoneAt(p.x, p.y) === avRoom;
        syncTrack(c, 'cam', share ? cam : null);
        syncTrack(c, 'screen', share || (deskScreen && d <= DESK_VIEW) ? screen : null);
      }
    }
    for (const id of conns.keys()) if (!peers.some((p) => p.id === id)) hangup(id);
    return out;
  }

  // Remote camera / screen streams for one peer, if they're sending any.
  const remote = (id) => conns.get(id)?.remote || { cam: null, screen: null };

  return {
    enable, disable, setMuted, onSignal, update, conns, remote,
    setDevice, setGain, devices,
    startCam, stopCam, startScreen, stopScreen,
    listen, get listening() { return listening; },
    get on() { return !!local; }, get muted() { return muted; }, get hasMic() { return !!mic; },
    get level() { return lvl; }, get deviceId() { return deviceId; }, get gain() { return gain; },
    get cam() { return cam; }, get screen() { return screen; },
  };
}
