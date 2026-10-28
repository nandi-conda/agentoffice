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
import WebSocket from 'ws';
import { DESKS, SEATS, findPath, zoneAt } from '../public/js/map.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AgentClient extends EventEmitter {
  constructor({ url = 'ws://localhost:8080/ws', name = 'agent', handle = null, note = '' } = {}) {
    super();
    Object.assign(this, { url, name, handle, note });
    this.peers = new Map();
    this.desks = {};
    this.me = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => this.send({ t: 'hello', kind: 'agent', name: this.name, handle: this.handle, note: this.note }));
      this.ws.on('error', reject);
      this.ws.on('close', () => this.emit('close'));
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        this.track(m);
        if (m.t === 'welcome') resolve(this);
        this.emit(m.t, m);
        if (m.t === 'chat' && m.id !== this.me?.id && this.mentions(m.text)) this.emit('mention', m);
      });
    });
  }

  mentions(text) {
    const tags = [...text.matchAll(/@([\w.-]+)/g)].map((x) => x[1].toLowerCase());
    return tags.includes(this.name.toLowerCase().replace(/\s+/g, '')) || (this.handle && tags.includes(this.handle.toLowerCase()));
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
  }

  send(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  say(text) { this.send({ t: 'chat', text }); }
  shout(text) { this.send({ t: 'chat', text: `/shout ${text}` }); }
  status(status, note) { this.send({ t: 'status', status, note }); }
  emote(name, ms = 3000) { this.send({ t: 'emote', name }); setTimeout(() => this.send({ t: 'emote', name: null }), ms); }

  get zone() { return this.me && zoneAt(this.me.x, this.me.y); }

  // Walk along the shared A* path at roughly human speed.
  async walkTo(x, y) {
    if (this.me.seat) this.send({ t: 'sit', seat: null });
    const path = findPath(this.me.x, this.me.y, x, y);
    if (!path) return false;
    const speed = 4; // tiles per second
    for (const step of path.slice(1)) {
      const dx = step.x - this.me.x, dy = step.y - this.me.y;
      const dist = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(dist / (speed / 10)));
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0;
      for (let i = 1; i <= n; i++) {
        this.me.x += dx / n; this.me.y += dy / n;
        this.send({ t: 'move', x: +this.me.x.toFixed(3), y: +this.me.y.toFixed(3), dir, moving: true });
        await sleep(100);
      }
    }
    this.send({ t: 'move', x: this.me.x, y: this.me.y, dir: 0, moving: false });
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

  close() { this.ws?.close(); }
}
