// A tiny SDK for putting software agents in the office.
//
// Agents speak the same WebSocket protocol as the browser client: they
// appear on the map with an AGENT badge, walk (using the shared pathfinder),
// sit at desks, claim them with a goal, chat, and get @mentions from
// anywhere in the office.
//
//   import { AgentClient } from './agent-sdk.mjs';
//   const bot = new AgentClient({ url: 'ws://localhost:8080/ws', name: 'BuildBot' });
//   bot.on('mention', (m) => bot.say(`on it, ${m.name}`));
//   await bot.connect();
//   await bot.takeDesk('watching CI');

import { EventEmitter } from 'node:events';
import { DESKS, SEATS, findPath, zoneAt, applyWing } from '../public/js/map.js';
import { mentionTags, mentionsPeer } from '../public/js/mentions.js';
import { facing } from '../public/js/sprites.js';
import { ROOMS, roomStatus } from '../public/js/rooms.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AgentClient extends EventEmitter {
  // `grant` is a one-time AT Protocol sign-in grant from /api/agent/verify or
  // /api/agent/roost-signin (see server/agentauth.js); it makes the agent
  // join as that DID. `socket` swaps the WebSocket for any ws-shaped object
  // (the MCP server uses an in-process pair).
  constructor({ url = 'ws://localhost:8080/ws', name = 'agent', note = '', grant = null, socket = null } = {}) {
    super();
    Object.assign(this, { url, name, note, grant, socket });
    this.walkId = 0;
    this.peers = new Map();
    this.desks = {};
    this.bookings = [];
    this.pending = new Map(); // booking request ref -> { resolve, reject }
    this.refs = 0;
    this.me = null;
  }

  async connect() {
    // `ws` is loaded lazily so the SDK also runs where it isn't installed
    // (the MCP server inside a Worker always passes `socket`).
    const WebSocket = this.socket ? null : (await import('ws')).default;
    const url = this.grant ? `${this.url}${this.url.includes('?') ? '&' : '?'}grant=${encodeURIComponent(this.grant)}` : this.url;
    return new Promise((resolve, reject) => {
      this.ws = this.socket ? this.socket() : new WebSocket(url);
      this.ws.on('open', () => this.send({ t: 'hello', kind: 'agent', name: this.name, note: this.note }));
      this.ws.on('error', reject);
      this.ws.on('close', () => { clearInterval(this.pinger); this.emit('close'); });
      // Over a real socket, ping so the office doesn't take a quiet agent for a ghost.
      if (!this.socket) this.pinger = setInterval(() => this.send({ t: 'ping' }), 30000);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        this.track(m);
        if (m.t === 'welcome') resolve(this);
        // An unheard 'error' event would throw; office errors are just messages.
        if (m.t !== 'error' || this.listenerCount('error')) this.emit(m.t, m);
        if (m.t === 'chat' && m.id !== this.me?.id && this.mentions(m.text)) this.emit('mention', m);
      });
    });
  }

  // By name, full handle or its first label (see public/js/mentions.js).
  mentions(text) {
    return mentionsPeer(mentionTags(text), { name: this.name, ...(this.me || {}) });
  }

  track(m) {
    if (m.t === 'welcome') {
      this.me = m.you;
      this.desks = m.desks;
      for (const p of m.peers) this.peers.set(p.id, p);
    } else if (m.t === 'join') this.peers.set(m.peer.id, m.peer);
    else if (m.t === 'leave') this.peers.delete(m.id);
    else if (m.t === 'move' || m.t === 'peer') {
      const p = this.peers.get(m.id);
      if (p) Object.assign(p, m);
    } else if (m.t === 'desks') this.desks = m.desks;
    if (m.t === 'welcome' || m.t === 'notes') this.notes = m.notes;
    if (m.t === 'welcome' || m.t === 'bookings') this.bookings = m.bookings || [];
    // Channel rooms off the hallway reshape the map; paths need to know.
    if (m.t === 'welcome' || m.t === 'wing') { this.wing = (m.t === 'wing' ? m.rooms : m.wing) || []; applyWing(this.wing); }
    // A locked room turned us away (or showed us out): stop walking, stand where the server says.
    if (m.t === 'bounce' && this.me) { this.walkId++; Object.assign(this.me, { x: m.x, y: m.y, seat: null }); }
    const wait = m.ref !== undefined && this.pending.get(m.ref);
    if (wait && (m.t === 'booked' || m.t === 'chan' || m.t === 'error')) {
      this.pending.delete(m.ref);
      if (m.t === 'booked') wait.resolve(m.booking); else if (m.t === 'chan') wait.resolve(m.result ?? m.room); else wait.reject(new Error(m.message));
    }
  }

  send(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  say(text) { this.send({ t: 'chat', text }); }
  shout(text) { this.send({ t: 'chat', text: `/shout ${text}` }); }
  status(status, note) { this.send({ t: 'status', status, note }); }
  emote(name, ms = 3000) { this.send({ t: 'emote', name }); setTimeout(() => this.send({ t: 'emote', name: null }), ms); }

  get zone() { return this.me && zoneAt(this.me.x, this.me.y); }

  // Run along the shared A* path at the browsers' auto-path speed. A newer walkTo
  // cancels an older one. `onStep(done, total)` reports progress.
  async walkTo(x, y, onStep = null) {
    const id = ++this.walkId;
    if (this.me.seat) { this.send({ t: 'sit', seat: null }); this.me.seat = null; }
    const path = findPath(this.me.x, this.me.y, x, y);
    if (!path) return false;
    let done = 0;
    const speed = 11; // tiles per second, the same run browsers use for auto-paths
    for (const step of path.slice(1)) {
      const dx = step.x - this.me.x, dy = step.y - this.me.y;
      const dist = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(dist / (speed / 10)));
      const dir = this.me.dir = facing(this.me.dir ?? 0, dx, dy);
      for (let i = 1; i <= n; i++) {
        this.me.x += dx / n; this.me.y += dy / n;
        this.send({ t: 'move', x: +this.me.x.toFixed(3), y: +this.me.y.toFixed(3), dir, moving: true });
        await sleep(100);
        if (id !== this.walkId || this.ws?.readyState !== 1) return false;
      }
      onStep?.(++done, path.length - 1);
    }
    this.send({ t: 'move', x: this.me.x, y: this.me.y, dir: this.me.dir ?? 0, moving: false });
    return true;
  }

  async walkToPeer(id) {
    const p = this.peers.get(id);
    if (p) await this.walkTo(p.x, p.y);
  }

  freeDesk(prefix = 'desk-') {
    const taken = new Set(Object.keys(this.desks));
    const sitting = new Set([...this.peers.values()].map((p) => p.seat));
    return DESKS.find((d) => d.id.startsWith(prefix) && !taken.has(d.id) && !sitting.has(`${d.id}-chair`));
  }

  async sit(seatId) {
    const seat = SEATS.find((s) => s.id === seatId);
    if (!seat) return false;
    await this.walkTo(seat.x, seat.y);
    this.send({ t: 'sit', seat: seat.id });
    this.me.seat = seat.id;
    return true;
  }

  // Find (or reuse) a desk, walk over, sit down and put a goal on it.
  async takeDesk(goal = '') {
    const key = this.me.did || `agent:${this.name}`;
    const mine = Object.entries(this.desks).find(([, v]) => v.owner === key);
    const desk = mine ? DESKS.find((d) => d.id === mine[0]) : this.freeDesk();
    if (!desk) return null;
    await this.sit(`${desk.id}-chair`);
    this.send({ t: 'desk', action: 'claim', desk: desk.id, goal });
    return desk.id;
  }

  // ---- meeting rooms --------------------------------------------------------
  // Rooms with their live status: { id, name, av, seats, state: free|soon|busy, current, next }.
  rooms(now = Date.now()) {
    return ROOMS.map((r) => ({ id: r.id, name: r.name, av: r.av, seats: r.seats, ...roomStatus(this.bookings, r.id, now) }));
  }

  // Send a booking op and wait for the server's answer (resolves the booking, rejects with its reason).
  bookOp(op, args = {}) {
    const ref = `a${++this.refs}`;
    return new Promise((resolve, reject) => {
      this.pending.set(ref, { resolve, reject });
      this.send({ t: 'book', op, ref, ...args });
      setTimeout(() => { if (this.pending.delete(ref)) reject(new Error('no answer from the office')); }, 10000);
    });
  }

  // book({ room: 'board', start: Date|ms|ISO|'now', minutes: 30 | end, title, invitees: ['ada.bsky.social'], lock, autoRelease })
  book({ start = 'now', end, ...rest } = {}) {
    const t = (v) => (v instanceof Date ? v.getTime() : v);
    return this.bookOp('create', { ...rest, start: t(start), ...(end !== undefined ? { end: t(end) } : {}) });
  }
  cancelBooking(id) { return this.bookOp('cancel', { id }); }
  extendBooking(id, minutes = 15) { return this.bookOp('extend', { id, minutes }); }
  endBooking(id) { return this.bookOp('end', { id }); }
  updateBooking(id, changes) { return this.bookOp('update', { id, ...changes }); }

  // Channel rooms off the hallway. Their doors hold agents to the same access
  // policy as people: check first, accept the rules if that's what it asks.
  chanOp(op, args = {}) {
    const ref = `c${++this.refs}`;
    return new Promise((resolve, reject) => {
      this.pending.set(ref, { resolve, reject });
      this.send({ t: 'chan', op, ref, ...args });
      setTimeout(() => { if (this.pending.delete(ref)) reject(new Error('no answer from the office')); }, 10000);
    });
  }
  openRoom(name, access = 'open', rules) { return this.chanOp('open', { name, access, rules }); }
  checkRoom(room) { return this.chanOp('check', { room }); }
  acceptRules(room, hash) { return this.chanOp('accept', { room, hash }); }
  knock(room) { return this.chanOp('knock', { room }); }

  close() { this.ws?.close(); }
}
