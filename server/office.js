// The office hub: presence, proximity chat, desks, pomodoro, whiteboard,
// notice board, arcade scores and WebRTC signalling relay.

import { randomUUID } from 'node:crypto';
import { SPAWN, DESKS, SEATS, zoneAt, canHear, isBlocked, ZONES } from '../public/js/map.js';

const POMO_ZONES = ZONES.filter((z) => z.kind === 'quiet').map((z) => z.id);
const STATUSES = new Set(['available', 'focus', 'meeting', 'away', 'coffee']);
const MAX_STROKES = 3000;
const MAX_NOTES = 40;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, d = lo) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

export class Office {
  constructor(saved = {}, { onChange = () => {}, loadActor = null, now = () => Date.now() } = {}) {
    this.peers = new Map();
    this.onChange = onChange;
    this.loadActor = loadActor;
    this.now = now;
    this.desks = saved.desks || {};
    this.strokes = saved.strokes || [];
    this.notes = saved.notes || [];
    this.scores = saved.scores || [];
    this.counters = { coffees: 0, pomodoros: 0, waves: 0, ...(saved.counters || {}) };
    this.pomo = {};
    for (const z of POMO_ZONES) this.pomo[z] = { phase: 'idle', endsAt: 0, round: 0, focusMin: 25, breakMin: 5 };
    this.shouts = [];
  }

  persisted() {
    return { desks: this.desks, strokes: this.strokes, notes: this.notes, scores: this.scores, counters: this.counters };
  }

  summary() {
    return {
      online: [...this.peers.values()].filter((p) => p.ready).map((p) => this.publicPeer(p)),
      desks: this.desks,
      counters: this.counters,
    };
  }

  publicPeer(p) {
    return {
      id: p.id, name: p.name, handle: p.handle, did: p.did, kind: p.kind,
      actor: p.actor, x: p.x, y: p.y, dir: p.dir, moving: p.moving,
      status: p.status, note: p.note, seat: p.seat, emote: p.emote, audio: p.audio,
      cup: p.cup, joinedAt: p.joinedAt,
    };
  }

  connect(ws) {
    const p = {
      id: randomUUID().slice(0, 8), ws, ready: false, name: 'guest', handle: null, did: null,
      kind: 'human', actor: null, x: SPAWN.x, y: SPAWN.y, dir: 0, moving: false,
      status: 'available', note: '', seat: null, emote: null, audio: false, cup: false,
      chatTimes: [], joinedAt: this.now(),
    };
    this.peers.set(p.id, p);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      Promise.resolve(this.handle(p, msg)).catch((e) => this.sendTo(p, { t: 'error', message: e.message }));
    });
    ws.on('close', () => this.leave(p));
    ws.on('error', () => this.leave(p));
    return p;
  }

  sendTo(p, msg) {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, except = null) {
    const s = JSON.stringify(msg);
    for (const q of this.peers.values()) if (q.ready && q !== except && q.ws.readyState === 1) q.ws.send(s);
  }

  leave(p) {
    if (!this.peers.has(p.id)) return;
    this.peers.delete(p.id);
    if (p.ready) this.broadcast({ t: 'leave', id: p.id });
  }

  ownerKey(p) { return p.did || `${p.kind}:${p.name}`; }

  async handle(p, m) {
    if (m.t === 'hello') return this.hello(p, m);
    if (!p.ready) return;
    switch (m.t) {
      case 'move': return this.move(p, m);
      case 'chat': return this.chat(p, m);
      case 'status': return this.setStatus(p, m);
      case 'emote': return this.emote(p, m);
      case 'sit': return this.sit(p, m);
      case 'desk': return this.desk(p, m);
      case 'pomo': return this.pomodoro(p, m);
      case 'wb': return this.whiteboard(p, m);
      case 'note': return this.noticeboard(p, m);
      case 'coffee': return this.coffee(p);
      case 'score': return this.score(p, m);
      case 'wave': return this.wave(p, m);
      case 'audio': p.audio = !!m.on; return this.broadcast({ t: 'peer', id: p.id, audio: p.audio });
      case 'rtc': return this.rtc(p, m);
      case 'ping': return this.sendTo(p, { t: 'pong', ts: m.ts });
    }
  }

  async hello(p, m) {
    if (p.ready) return;
    p.kind = m.kind === 'agent' ? 'agent' : 'human';
    p.name = clip(m.name, 32) || (p.kind === 'agent' ? 'agent' : 'guest');
    if (m.handle && this.loadActor) {
      try {
        // The server loads the character itself so clients can't inject
        // arbitrary sprite URLs for someone else.
        const a = await this.loadActor(clip(m.handle, 253));
        p.did = a.did; p.handle = a.handle;
        p.actor = { sprite: a.sprite, stats: a.stats, displayName: a.displayName, description: a.description };
        p.name = clip(m.name, 32) || a.displayName || a.handle;
      } catch (e) {
        this.sendTo(p, { t: 'error', message: `couldn't load @${m.handle}: ${e.message}` });
      }
    }
    if (m.status && STATUSES.has(m.status)) p.status = m.status;
    p.note = clip(m.note, 80);
    p.ready = true;
    this.sendTo(p, {
      t: 'welcome', id: p.id, now: this.now(), you: this.publicPeer(p),
      peers: [...this.peers.values()].filter((q) => q.ready && q !== p).map((q) => this.publicPeer(q)),
      desks: this.desks, strokes: this.strokes, notes: this.notes, pomo: this.pomoState(),
      scores: this.scores.slice(0, 10), counters: this.counters, shouts: this.shouts.slice(-20),
    });
    this.broadcast({ t: 'join', peer: this.publicPeer(p) }, p);
    this.touchDesk(p);
  }

  move(p, m) {
    const x = num(m.x, 0, 48, p.x), y = num(m.y, 0, 32, p.y);
    if (isBlocked(Math.floor(x), Math.floor(y)) && !p.seat) return;
    // Guard against teleport hacks beyond a generous per-message step.
    if (Math.hypot(x - p.x, y - p.y) > 6 && !m.teleport) return;
    p.x = x; p.y = y; p.dir = num(m.dir, 0, 3, 0) | 0; p.moving = !!m.moving;
    if (p.seat && m.moving) p.seat = null;
    this.broadcast({ t: 'move', id: p.id, x, y, dir: p.dir, moving: p.moving, seat: p.seat }, p);
  }

  chat(p, m) {
    const text = clip(m.text, 500);
    if (!text) return;
    const t = this.now();
    p.chatTimes = p.chatTimes.filter((ts) => t - ts < 5000);
    if (p.chatTimes.length >= 6) return this.sendTo(p, { t: 'error', message: 'slow down a little' });
    p.chatTimes.push(t);
    const shout = text.startsWith('/shout ');
    const msg = { t: 'chat', id: p.id, name: p.name, text: shout ? text.slice(7) : text, ts: t };
    if (shout) {
      msg.scope = 'office';
      this.shouts.push(msg);
      if (this.shouts.length > 50) this.shouts.shift();
      return this.broadcast(msg);
    }
    const zone = zoneAt(p.x, p.y);
    msg.scope = zone && zone.kind !== 'open' ? zone.name : 'nearby';
    // Mentions reach the person anywhere, which is how you tap someone on
    // the shoulder across the office (and how agents get asked things).
    const mentioned = new Set([...text.matchAll(/@([\w.-]+)/g)].map((x) => x[1].toLowerCase()));
    for (const q of this.peers.values()) {
      if (!q.ready) continue;
      const hit = q === p || canHear(p, q);
      const ment = mentioned.has(q.name.toLowerCase().replace(/\s+/g, '')) || (q.handle && mentioned.has(q.handle.toLowerCase()));
      if (hit || ment) this.sendTo(q, { ...msg, mention: !hit && ment });
    }
  }

  setStatus(p, m) {
    if (m.status && STATUSES.has(m.status)) p.status = m.status;
    if (m.note !== undefined) p.note = clip(m.note, 80);
    this.broadcast({ t: 'peer', id: p.id, status: p.status, note: p.note });
  }

  emote(p, m) {
    p.emote = m.name ? clip(m.name, 24) : null;
    this.broadcast({ t: 'peer', id: p.id, emote: p.emote });
  }

  sit(p, m) {
    if (m.seat === null) {
      p.seat = null;
      return this.broadcast({ t: 'peer', id: p.id, seat: null });
    }
    const seat = SEATS.find((s) => s.id === m.seat);
    if (!seat || Math.hypot(seat.x - p.x, seat.y - p.y) > 2.5) return;
    for (const q of this.peers.values()) if (q.seat === seat.id && q !== p) return this.sendTo(p, { t: 'error', message: 'someone is sitting there' });
    p.seat = seat.id; p.x = seat.x; p.y = seat.y;
    p.dir = { down: 0, left: 1, right: 2, up: 3 }[seat.facing] ?? 0;
    p.moving = false;
    this.broadcast({ t: 'move', id: p.id, x: p.x, y: p.y, dir: p.dir, moving: false, seat: p.seat });
  }

  desk(p, m) {
    const d = DESKS.find((x) => x.id === m.desk);
    if (!d) return;
    const key = this.ownerKey(p);
    const cur = this.desks[d.id];
    if (m.action === 'claim') {
      const stale = cur && this.now() - (cur.seen || 0) > 12 * 3600 * 1000;
      const ownerOnline = cur && [...this.peers.values()].some((q) => q.ready && this.ownerKey(q) === cur.owner);
      if (cur && cur.owner !== key && (ownerOnline || !stale)) {
        return this.sendTo(p, { t: 'error', message: `${cur.name}'s desk` });
      }
      for (const [id, v] of Object.entries(this.desks)) if (v.owner === key && id !== d.id) delete this.desks[id];
      this.desks[d.id] = { owner: key, name: p.name, handle: p.handle, goal: clip(m.goal, 80), since: cur?.owner === key ? cur.since : this.now(), seen: this.now() };
    } else if (m.action === 'goal' && cur?.owner === key) {
      cur.goal = clip(m.goal, 80);
    } else if (m.action === 'release' && cur?.owner === key) {
      delete this.desks[d.id];
    } else return;
    this.onChange();
    this.broadcast({ t: 'desks', desks: this.desks });
  }

  touchDesk(p) {
    const key = this.ownerKey(p);
    for (const v of Object.values(this.desks)) if (v.owner === key) { v.seen = this.now(); this.onChange(); }
  }

  pomoState() {
    const out = {};
    for (const [k, v] of Object.entries(this.pomo)) { const { timer, ...rest } = v; out[k] = rest; }
    return out;
  }

  pomodoro(p, m) {
    const zone = zoneAt(p.x, p.y);
    const st = zone && this.pomo[zone.id];
    if (!st) return;
    if (m.action === 'start') {
      st.focusMin = num(m.focusMin, 1, 90, 25) | 0;
      st.breakMin = num(m.breakMin, 1, 30, 5) | 0;
      st.round = 1; st.startedBy = p.name;
      this.setPhase(zone.id, 'focus');
    } else if (m.action === 'stop') {
      clearTimeout(st.timer);
      st.phase = 'idle'; st.endsAt = 0; st.round = 0;
      this.broadcastPomo();
    }
  }

  setPhase(zoneId, phase) {
    const st = this.pomo[zoneId];
    clearTimeout(st.timer);
    st.phase = phase;
    const mins = phase === 'focus' ? st.focusMin : st.breakMin;
    st.endsAt = this.now() + mins * 60000;
    st.timer = setTimeout(() => {
      if (phase === 'focus') {
        this.counters.pomodoros++;
        this.onChange();
        this.setPhase(zoneId, 'break');
      } else {
        st.round++;
        this.setPhase(zoneId, 'focus');
      }
    }, mins * 60000);
    st.timer.unref?.();
    this.broadcastPomo();
  }

  broadcastPomo() {
    this.broadcast({ t: 'pomo', pomo: this.pomoState(), counters: this.counters, now: this.now() });
  }

  whiteboard(p, m) {
    if (m.op === 'clear') {
      this.strokes = [];
    } else if (m.op === 'stroke' && Array.isArray(m.points) && m.points.length >= 2) {
      const points = m.points.slice(0, 400).map((pt) => [num(pt[0], 0, 1), num(pt[1], 0, 1)]);
      const color = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#1f2937';
      const stroke = { points, color, size: num(m.size, 1, 24, 3), by: p.name };
      this.strokes.push(stroke);
      if (this.strokes.length > MAX_STROKES) this.strokes.shift();
      this.broadcast({ t: 'wb', op: 'stroke', stroke }, p);
      return this.onChange();
    } else return;
    this.onChange();
    this.broadcast({ t: 'wb', op: 'clear' });
  }

  noticeboard(p, m) {
    if (m.op === 'add') {
      const text = clip(m.text, 200);
      if (!text) return;
      const colors = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#ddd6fe'];
      this.notes.unshift({ id: randomUUID().slice(0, 8), text, by: p.name, owner: this.ownerKey(p), ts: this.now(), color: colors[(Math.random() * colors.length) | 0] });
      this.notes = this.notes.slice(0, MAX_NOTES);
    } else if (m.op === 'remove') {
      const n = this.notes.find((x) => x.id === m.id);
      if (!n || n.owner !== this.ownerKey(p)) return;
      this.notes = this.notes.filter((x) => x !== n);
    } else return;
    this.onChange();
    this.broadcast({ t: 'notes', notes: this.notes });
  }

  coffee(p) {
    p.cup = true;
    clearTimeout(p.cupTimer);
    p.cupTimer = setTimeout(() => { p.cup = false; this.broadcast({ t: 'peer', id: p.id, cup: false }); }, 5 * 60000);
    p.cupTimer.unref?.();
    this.counters.coffees++;
    this.onChange();
    this.broadcast({ t: 'peer', id: p.id, cup: true });
    this.broadcast({ t: 'counters', counters: this.counters });
    // Tell anyone nearby that a coffee chat is brewing.
    for (const q of this.peers.values()) {
      if (q !== p && q.ready && canHear(p, q)) this.sendTo(q, { t: 'toast', text: `☕ ${p.name} grabbed a coffee nearby. Coffee chat?` });
    }
  }

  score(p, m) {
    const score = num(m.score, 0, 10000, 0) | 0;
    if (!score) return;
    this.scores.push({ name: p.name, score, ts: this.now() });
    this.scores.sort((a, b) => b.score - a.score);
    this.scores = this.scores.slice(0, 20);
    this.onChange();
    this.broadcast({ t: 'scores', scores: this.scores.slice(0, 10) });
  }

  wave(p, m) {
    const q = this.peers.get(m.to);
    if (!q || !q.ready) return;
    this.counters.waves++;
    this.sendTo(q, { t: 'wave', from: p.id, name: p.name, kind: m.kind === 'knock' ? 'knock' : 'wave' });
    this.broadcast({ t: 'peer', id: p.id, emote: 'wave' });
  }

  rtc(p, m) {
    const q = this.peers.get(m.to);
    if (!q || !q.ready) return;
    this.sendTo(q, { t: 'rtc', from: p.id, data: m.data });
  }
}
