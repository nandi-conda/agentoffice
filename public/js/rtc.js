// Proximity voice, plus video and screen share in A/V rooms. Each pair of
// people who can hear each other (and both have audio on) gets a direct
// WebRTC connection; volume falls off with distance in open areas and is
// full inside a private room. Inside an A/V room the same connection also
// carries camera and screen tracks, but only to people in that room. A
// screen put up on a desk monitor goes to whoever stands within DESK_VIEW.

import { canHear, zoneAt, HEAR_RADIUS } from './map.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
export const DESK_VIEW = 4;

export function createVoice({ send, myId, onMedia = () => {} }) {
  let local = null;
  let actx = null;
  const conns = new Map(); // peerId -> { pc, audio, analyser, data, senders, kinds, remote }
  let muted = false;
  let cam = null, screen = null; // local MediaStreams while on

  // `silent` joins without a mic (listen and watch only) if the mic is refused.
  async function enable({ silent = false } = {}) {
    if (local) return true;
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (!silent) return false;
      local = new MediaStream();
    }
    actx = new AudioContext();
    if (local.getAudioTracks().length) {
      const src = actx.createMediaStreamSource(local);
      const an = actx.createAnalyser(); an.fftSize = 256;
      src.connect(an);
      local.analyser = an; local.data = new Uint8Array(an.frequencyBinCount);
    }
    return true;
  }

  function disable() {
    stopCam(); stopScreen();
    for (const id of [...conns.keys()]) hangup(id);
    local?.getTracks().forEach((t) => t.stop());
    local = null;
    actx?.close(); actx = null;
  }

  function setMuted(m) {
    muted = m;
    local?.getAudioTracks().forEach((t) => (t.enabled = !m));
  }

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
  function update(me, peers, deafened, { deskScreen = false } = {}) {
    const out = { meSpeaking: false, speaking: new Set() };
    if (!local) return out;
    out.meSpeaking = !muted && level(local.analyser, local.data) > 18;
    const myZone = zoneAt(me.x, me.y);
    const avRoom = myZone?.av ? myZone : null;
    for (const p of peers) {
      if (p.id === me.id) continue;
      const near = p.audio && canHear(me, p);
      const keep = conns.has(p.id) && p.audio && (canHear(me, p) || Math.hypot(me.x - p.x, me.y - p.y) < HEAR_RADIUS + 1.5);
      // The lower id starts the call; the other side answers.
      if (near && !conns.has(p.id) && myId() < p.id) create(p.id);
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
    startCam, stopCam, startScreen, stopScreen,
    get on() { return !!local; }, get muted() { return muted; },
    get cam() { return cam; }, get screen() { return screen; },
  };
}
