// Proximity voice. Each pair of people who can hear each other (and both
// have audio on) gets a direct WebRTC audio connection; volume falls off
// with distance in open areas and is full inside a private room.

import { canHear, zoneAt, HEAR_RADIUS } from './map.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createVoice({ send, myId }) {
  let local = null;
  let actx = null;
  const conns = new Map(); // peerId -> { pc, audio, analyser, data }
  let muted = false;

  async function enable() {
    if (local) return true;
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      return false;
    }
    actx = new AudioContext();
    const src = actx.createMediaStreamSource(local);
    const an = actx.createAnalyser(); an.fftSize = 256;
    src.connect(an);
    local.analyser = an; local.data = new Uint8Array(an.frequencyBinCount);
    return true;
  }

  function disable() {
    for (const id of [...conns.keys()]) hangup(id);
    local?.getTracks().forEach((t) => t.stop());
    local = null;
    actx?.close(); actx = null;
  }

  function setMuted(m) {
    muted = m;
    local?.getAudioTracks().forEach((t) => (t.enabled = !m));
  }

  function create(id) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const c = { pc, audio: new Audio(), analyser: null, data: null, makingOffer: false, polite: myId() > id };
    c.audio.autoplay = true;
    local.getTracks().forEach((t) => pc.addTrack(t, local));
    pc.onicecandidate = (e) => e.candidate && send({ t: 'rtc', to: id, data: { ice: e.candidate } });
    pc.ontrack = (e) => {
      c.audio.srcObject = e.streams[0];
      c.audio.play().catch(() => {});
      if (actx) {
        const src = actx.createMediaStreamSource(e.streams[0]);
        c.analyser = actx.createAnalyser(); c.analyser.fftSize = 256;
        src.connect(c.analyser);
        c.data = new Uint8Array(c.analyser.frequencyBinCount);
      }
    };
    pc.onnegotiationneeded = async () => {
      try {
        c.makingOffer = true;
        await pc.setLocalDescription();
        send({ t: 'rtc', to: id, data: { sdp: pc.localDescription } });
      } finally { c.makingOffer = false; }
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
  }

  // Perfect-negotiation pattern so either side can start.
  async function onSignal(from, data) {
    if (!local) return;
    let c = conns.get(from) || create(from);
    const pc = c.pc;
    try {
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && (c.makingOffer || pc.signalingState !== 'stable');
        if (collision && !c.polite) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription();
          send({ t: 'rtc', to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.ice) {
        await pc.addIceCandidate(data.ice).catch(() => {});
      }
    } catch (e) { console.warn('rtc', e); }
  }

  const level = (an, data) => {
    if (!an) return 0;
    an.getByteFrequencyData(data);
    let s = 0; for (const v of data) s += v;
    return s / data.length;
  };

  // Called every frame with my position and everyone else's.
  function update(me, peers, deafened) {
    const out = { meSpeaking: false, speaking: new Set() };
    if (!local) return out;
    out.meSpeaking = !muted && level(local.analyser, local.data) > 18;
    for (const p of peers) {
      if (p.id === me.id) continue;
      const near = p.audio && canHear(me, p);
      const keep = conns.has(p.id) && p.audio && (canHear(me, p) || Math.hypot(me.x - p.x, me.y - p.y) < HEAR_RADIUS + 1.5);
      // The lower id starts the call; the other side answers.
      if (near && !conns.has(p.id) && myId() < p.id) create(p.id);
      if (!keep && conns.has(p.id) && !near) hangup(p.id);
      const c = conns.get(p.id);
      if (c) {
        const z = zoneAt(me.x, me.y);
        const d = Math.hypot(me.x - p.x, me.y - p.y);
        const vol = !canHear(me, p) ? 0 : z && z.kind === 'room' ? 1 : Math.max(0, Math.min(1, 1.25 - d / HEAR_RADIUS));
        c.audio.volume = deafened ? 0 : vol;
        if (level(c.analyser, c.data) > 14 && vol > 0) out.speaking.add(p.id);
      }
    }
    for (const id of conns.keys()) if (!peers.some((p) => p.id === id)) hangup(id);
    return out;
  }

  return { enable, disable, setMuted, onSignal, update, conns, get on() { return !!local; }, get muted() { return muted; } };
}
