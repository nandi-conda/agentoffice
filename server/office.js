// The World: the office hub that holds everyone's socket. Movement,
// presence, proximity chat, sitting, emotes, A/V flags and the WebRTC
// signalling relay happen here, because they need to be fast. Everything
// else with its own state is an entity (server/entities): each actor, each
// meeting room, each desk, each pomodoro timer, the whiteboard, the notice
// board, the arcade and the coffee machine. The World hands them requests,
// mirrors what they show (so a welcome is one message, with no round trips),
// and carries out the effects they send back (Office.apply).

import { mentionTags, mentionsPeer } from '../public/js/mentions.js';
import { SPAWN, DESKS, SEATS, FURNITURE, PLUGIN_OBJECTS, zoneAt, canHear, isBlocked } from '../public/js/map.js';
import { cleanRequest } from './plugins.js';
import { ROOMS, roomById, lockedOut, activeBooking, fmtTime } from '../public/js/rooms.js';
import { LocalRuntime, parse } from './entities/runtime.js';
import { KINDS, MIRRORED, POMO_ZONES, nextRoomEvent } from './entities/kinds.js';
import { str, int, arr, obj, WHO, describeKind, paramList } from './entities/schema.js';

// What entities may call on the World ('world:main'), in the same shape as
// an entity's `static api` (see entities/schema.js), for the API docs.
export const WORLD = {
  doc: 'The office itself (OfficeRoom): everyone\'s socket, movement, presence, proximity chat, sitting, emotes, A/V flags and the WebRTC relay. It hands entities requests, mirrors what they show, and carries out the effects they send back.',
  api: {
    apply: {
      doc: 'Carry out effects: { op: "mirror", value | push+max, except?, quiet? } (what the sender shows changed), { op: "send", to: peerId, msg }, { op: "broadcast", msg, except? }, { op: "showOut", to: peerId, room, text }. Entities call it through this.emit() and this.mirror().',
      params: { effects: arr({ type: 'object', description: '{ op, from, ... }' }, 'Effects') }, mutates: true, internal: true,
    },
    presence: { doc: 'Who is in the office now.', returns: arr(WHO, 'People'), internal: true },
    deliver: { doc: 'A protocol message for an actor, to each of their open connections. Returns how many got it.', params: { key: str('Owner key'), msg: { type: 'object', description: 'Protocol message { t, ... }' } }, returns: int('Connections reached', 0), internal: true },
    summary: { doc: 'The public office summary (/api/office).', returns: obj({ online: arr(obj({}), 'People'), desks: obj({}), counters: obj({}) }), internal: true },
  },
  events: {
    publishes: {
      'zone:<id>': '{ type: "enter" | "exit", who } when someone walks in or out of a zone',
      office: '{ type: "join" | "leave", who } when someone comes in or goes',
    },
  },
};

const STATUSES = new Set(['available', 'focus', 'meeting', 'away', 'coffee']);
const IDLE_POMO = { phase: 'idle', endsAt: 0, round: 0, focusMin: 25, breakMin: 5 };
// Close code for a connection replaced by a newer one for the same identity
// (public/js/net.js doesn't reconnect after it).
export const REPLACED = 4001;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, d = lo) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

export class Office {
  // runtime: where the entities live (a LocalRuntime in this process by
  // default; the Worker passes one backed by Durable Objects).
  // mirror/onMirror: a saved copy of the mirror, and a hook for keeping it,
  // so a Durable Object waking from hibernation doesn't ask every entity again.
  constructor(saved = {}, { onChange = () => {}, loadActor = null, now = () => Date.now(), runtime = null, mirror = null, onMirror = () => {} } = {}) {
    this.peers = new Map();
    this.onChange = onChange;
    this.loadActor = loadActor;
    this.now = now;
    this.runtime = runtime || new LocalRuntime({ kinds: KINDS, now, services: { loadActor } });
    this.runtime.setWorld?.(this.worldApi());
    this.mirror = new Map(mirror || []); // entity address -> what it shows
    this.onMirror = onMirror;
    this.waves = saved.counters?.waves || saved.waves || 0;
    this.shouts = [];
    // When this copy of the office started; a recent time means a restart
    // (deploy or eviction) wiped what lives only in memory.
    this.upSince = this.now();
    // With a saved mirror the office is ready at once and refreshes behind.
    const booting = this.boot(saved.migrated ? null : saved, !!mirror?.length);
    this.ready = mirror?.length ? Promise.resolve() : booting;
  }

  ref(address) { return this.runtime.ref(address); }

  // Background entity calls (publishing, touching desks…): never let one
  // failing take a message down with it.
  bg(promise) { promise.catch((e) => console.error('entity call', e.message)); }

  // First start after the move to entities: hand the old single-object
  // state to the entities that own it now. Then pull what everyone shows.
  async boot(legacy, cached = false) {
    if (legacy && ['desks', 'strokes', 'notes', 'scores', 'bookings', 'counters'].some((k) => legacy[k])) {
      const c = legacy.counters || {};
      await Promise.all([
        ...Object.entries(legacy.desks || {}).map(([id, h]) => this.ref(`desk:${id}`).seed(h)),
        ...ROOMS.map((r) => this.ref(`room:${r.id}`).seed(legacy.bookings || [])),
        this.ref('whiteboard:main').seed(legacy.strokes || []),
        this.ref('noticeboard:main').seed(legacy.notes || []),
        this.ref('arcade:main').seed(legacy.scores || []),
        this.ref('coffee:main').seed(c.coffees || 0),
        this.ref(`pomodoro:${POMO_ZONES[0]}`).seed(c.pomodoros || 0),
      ]);
      this.migrated = true;
      this.onChange();
    }
    this.migrated = true;
    if (cached) return;
    // Anything an entity pushes meanwhile is newer than the view it answered.
    const pushed = (this.pushed = new Set());
    const views = await Promise.allSettled(MIRRORED.map((a) => this.ref(a).view()));
    this.pushed = null;
    views.forEach((r, i) => {
      if (pushed.has(MIRRORED[i])) return;
      if (r.status === 'fulfilled') { this.mirror.set(MIRRORED[i], r.value); this.onMirror(MIRRORED[i]); }
      else console.error(`${MIRRORED[i]} view`, r.reason?.message);
    });
    // Uploaded objects aren't in MIRRORED (people add them): pull what each shows.
    await Promise.allSettled(this.gallery.map(async (f) => {
      const v = await this.ref(`uobj:${f.id}`).view();
      if (!this.mirror.has(`uobj:${f.id}`)) { this.mirror.set(`uobj:${f.id}`, v); this.onMirror(`uobj:${f.id}`); }
    }));
  }

  persisted() {
    return { migrated: true, counters: { waves: this.waves } };
  }

  // ---- what the entities show, from the mirror ---------------------------
  get desks() {
    const out = {};
    for (const d of DESKS) { const v = this.mirror.get(`desk:${d.id}`); if (v) out[d.id] = v; }
    return out;
  }
  get bookings() { return ROOMS.flatMap((r) => this.mirror.get(`room:${r.id}`) || []).sort((a, b) => a.start - b.start); }
  get strokes() { return this.mirror.get('whiteboard:main') || []; }
  get notes() { return this.mirror.get('noticeboard:main') || []; }
  get scores() { return this.mirror.get('arcade:main') || []; }
  get counters() {
    const pomodoros = POMO_ZONES.reduce((n, z) => n + (this.mirror.get(`pomodoro:${z}`)?.count || 0), 0);
    return { coffees: this.mirror.get('coffee:main')?.count || 0, pomodoros, waves: this.waves };
  }
  pomoState() {
    const out = {};
    for (const z of POMO_ZONES) out[z] = this.mirror.get(`pomodoro:${z}`)?.state || { ...IDLE_POMO };
    return out;
  }

  // ---- generated API calls ------------------------------------------------
  // An entity method from its `static api`, called on behalf of peer p (null
  // for a read-only observer). The same checks for every generated MCP tool:
  // internal methods never, anything acting or naming the caller needs
  // someone in the office, inZone needs them standing in the entity's zone.
  // The World fills in `who` and `ctx`, so callers only pass the params.
  async call(p, address, method, args = []) {
    const { kind, name } = parse(address);
    const spec = KINDS[kind] && describeKind(kind, KINDS[kind]).api[method];
    if (!spec || spec.internal) throw new Error(`${address} has no public method ${method}`);
    if ((spec.who || spec.mutates || spec.inZone || spec.near) && !p?.ready) throw new Error('join the office first');
    if (spec.inZone && zoneAt(p.x, p.y)?.id !== name) throw new Error(`walk to ${name} first`);
    if (spec.near) {
      // Same rule as the browser: walk up to it (its nearest edge) first.
      const f = FURNITURE.find((x) => x.id === name) || DESKS.find((x) => x.id === name) || this.uploaded(name);
      if (!f) throw new Error(`${address} isn't on the map`);
      const cx = Math.max(f.x, Math.min(p.x, f.x + (f.w || 1))), cy = Math.max(f.y, Math.min(p.y, f.y + (f.h || 1)));
      if (Math.hypot(cx - p.x, cy - p.y) > spec.near) throw new Error(`you're too far from the ${f.name || name}: walk_to ${name} first (within ${spec.near} tiles)`);
    }
    if (method === 'view' && this.mirror.has(address)) return this.mirror.get(address);
    const params = paramList(spec).map((_, i) => args[i]);
    while (params.length && params.at(-1) === undefined) params.pop();
    if (spec.ctx) params.length = paramList(spec).length;
    return this.ref(address)[method](...(spec.who ? [this.who(p)] : []), ...params, ...(spec.ctx ? [{ all: this.bookings, presence: this.presence() }] : []));
  }

  // ---- what entities may call on the World --------------------------------
  worldApi() {
    return {
      apply: (effects) => this.apply(effects),
      presence: () => this.presence(),
      deliver: (key, msg) => this.deliver(key, msg),
      summary: () => this.summary(),
    };
  }

  // Who's in the office, as entities see them.
  presence() {
    return [...this.peers.values()].filter((q) => q.ready && q.kind !== 'freeq').map((q) => this.who(q));
  }

  who(p) {
    return { id: p.id, key: this.ownerKey(p), name: p.name, handle: p.handle, did: p.did, kind: p.kind, zone: zoneAt(p.x, p.y)?.id || null, x: p.x, y: p.y };
  }

  // A message for an actor: to each of their open connections. Returns how
  // many got it, so the actor can keep it for later when nobody did.
  deliver(key, msg) {
    let n = 0;
    for (const q of this.peers.values()) {
      if (q.ready && q.ws.readyState === 1 && this.ownerKey(q) === key) { this.sendTo(q, msg); n++; }
    }
    return n;
  }

  // Effects from entities:
  //   { op: 'mirror', from, value | push+max, except?, quiet? }  what `from` shows changed
  //   { op: 'send', to: peerId, msg }   { op: 'broadcast', msg, except? }
  //   { op: 'showOut', to: peerId, room, text }
  apply(effects) {
    for (const e of effects || []) {
      if (e.op === 'mirror') this.mirrored(e);
      else if (e.op === 'send') { const q = this.peers.get(e.to); if (q?.ready) this.sendTo(q, e.msg); }
      else if (e.op === 'broadcast') this.broadcast(e.msg, this.peers.get(e.except) || null);
      else if (e.op === 'showOut') { const q = this.peers.get(e.to), room = roomById(e.room); if (q?.ready && room) this.showOut(q, room, e.text); }
    }
    return true;
  }

  mirrored({ from, value, push, max, except, quiet }) {
    if (push !== undefined) {
      const list = this.mirror.get(from) || [];
      list.push(push);
      while (list.length > max) list.shift();
      this.mirror.set(from, list);
    } else this.mirror.set(from, value);
    this.pushed?.add(from);
    this.onMirror(from);
    if (quiet) return;
    switch (parse(from).kind) {
      case 'desk': return this.broadcast({ t: 'desks', desks: this.desks });
      case 'room': return this.broadcast({ t: 'bookings', bookings: this.bookings });
      case 'whiteboard': return this.broadcast(push !== undefined ? { t: 'wb', op: 'stroke', stroke: push } : { t: 'wb', op: 'clear' }, this.peers.get(except) || null);
      case 'noticeboard': return this.broadcast({ t: 'notes', notes: this.notes });
      case 'arcade': return this.broadcast({ t: 'scores', scores: this.scores.slice(0, 10) });
      case 'coffee': return this.broadcast({ t: 'counters', counters: this.counters });
      case 'plugin': case 'uobj': return this.broadcast({ t: 'obj', id: parse(from).name, display: value?.display || null });
      case 'gallery': return this.broadcast({ t: 'gallery', items: this.gallery });
      case 'pomodoro': return this.broadcastPomo();
    }
  }

  // Publish to a topic, but only if something listens (the World mirrors
  // subscriber counts for the topics it publishes to).
  publish(topic, ev) {
    if (this.mirror.get(`topic:${topic}`) > 0) this.bg(this.ref(`topic:${topic}`).publish(ev, 'world:main'));
  }

  summary() {
    return {
      online: [...this.peers.values()].filter((p) => p.ready).map((p) => this.publicPeer(p)),
      desks: this.desks,
      counters: this.counters,
      bookings: this.bookings,
      upSince: this.upSince,
      freeq: this.freeq?.status() || null,
      // How each plugin object was last reached: binding, builtin or offline.
      objects: Object.fromEntries(PLUGIN_OBJECTS.map((f) => [f.id, this.mirror.get(`plugin:${f.id}`)?.via || 'unused'])),
      // Uploaded objects and how each last ran (dynamic-worker, worker-thread, offline).
      uploads: Object.fromEntries(this.gallery.map((f) => [f.id, this.mirror.get(`uobj:${f.id}`)?.via || 'unused'])),
    };
  }

  publicPeer(p) {
    return {
      id: p.id, name: p.name, handle: p.handle, did: p.did, kind: p.kind,
      actor: p.actor, x: p.x, y: p.y, dir: p.dir, moving: p.moving,
      status: p.status, note: p.note, seat: p.seat, emote: p.emote, audio: p.audio,
      video: p.video, screen: p.screen, cup: p.cup, joinedAt: p.joinedAt,
    };
  }

  // Transport-neutral entry points: open() a peer for a socket, feed it
  // message() and close(). connect() wires them to a Node `ws` socket; the
  // Cloudflare Durable Object calls them from its hibernation handlers.
  // `did` is only ever a DID the visitor proved via OAuth (see auth.js).
  open(ws, { did = null, restored = null } = {}) {
    const p = {
      id: crypto.randomUUID().slice(0, 8), ready: false, name: 'guest', handle: null, did: null, authDid: did,
      kind: 'human', actor: null, x: SPAWN.x, y: SPAWN.y, dir: 0, moving: false,
      status: 'available', note: '', seat: null, emote: null, audio: false, video: false, screen: false, cup: false,
      chatTimes: [], joinedAt: this.now(),
      ...restored, ws,
    };
    this.peers.set(p.id, p);
    return p;
  }

  message(p, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return Promise.resolve(); }
    if (!msg || typeof msg.t !== 'string') return Promise.resolve();
    return Promise.resolve(this.handle(p, msg)).catch((e) => this.sendTo(p, { t: 'error', message: e.message }));
  }

  // The parts of a peer worth keeping across a Durable Object hibernation.
  snapshot(p) {
    const { ws, cupTimer, ...rest } = p;
    return rest;
  }

  connect(ws, { did = null } = {}) {
    const p = this.open(ws, { did });
    ws.on('message', (raw) => this.message(p, raw));
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
    if (p.kind !== 'freeq') { this.freeq?.leave(p); this.freeq?.presence(); }
    if (!p.ready || p.kind === 'freeq') return;
    const key = this.actorKey(p);
    if (key) this.bg(this.ref(`actor:${key}`).depart());
    const zone = zoneAt(p.x, p.y);
    if (zone) this.publish(`zone:${zone.id}`, { type: 'exit', who: this.who(p) });
    this.publish('office', { type: 'leave', who: this.who(p) });
  }

  // The actor entity for a peer: their DID, or the agent's name. Guests have none.
  actorKey(p) { return p.did || (p.kind === 'agent' ? `agent:${p.name}` : null); }

  // ---- people from outside (the freeq bridge, see freeq.js) ----------------
  // They have no socket: they're drawn, can be heard and mentioned, and never
  // send anything themselves.
  addRemote(fields) {
    const p = this.open({ readyState: 3, send() {} }, { restored: { ...fields } });
    p.ready = true;
    this.broadcast({ t: 'join', peer: this.publicPeer(p) });
    return p;
  }

  removeRemote(p) { this.leave(p); }

  moveRemote(p, x, y) {
    p.x = x; p.y = y; p.moving = false; p.seat = null;
    this.broadcast({ t: 'move', id: p.id, x, y, dir: p.dir, moving: false, seat: null });
  }

  noteRemote(p, note) {
    p.note = clip(note, 80);
    this.broadcast({ t: 'peer', id: p.id, note: p.note });
  }

  renameRemote(p, name) {
    p.name = clip(name, 32);
    this.broadcast({ t: 'leave', id: p.id });
    this.broadcast({ t: 'join', peer: this.publicPeer(p) });
  }

  // freeq accounts are AT Protocol DIDs, so they can wear their rpg.actor character too.
  async identifyRemote(p, did) {
    p.did = did;
    if (!this.loadActor) return;
    try {
      const a = await this.ref(`actor:${did}`).profile();
      if (!a || !this.peers.has(p.id)) return;
      p.handle = a.handle;
      p.actor = { sprite: a.sprite, stats: a.stats, displayName: a.displayName, description: a.description };
      this.broadcast({ t: 'leave', id: p.id });
      this.broadcast({ t: 'join', peer: this.publicPeer(p) });
    } catch { /* no character: keep the default look */ }
  }

  // A line from a freeq channel, heard by everyone in the area it's attached to.
  // `backfill` lines were said while the office wasn't listening (`ts` is when).
  remoteChat({ zoneId, channel, peer, name, text, ts = null, backfill = false }) {
    const msg = { t: 'chat', id: peer?.id || `freeq:${name}`, name: clip(name, 32), text: clip(text, 500), ts: ts || this.now(), scope: channel, freeq: true, ...(backfill ? { backfill: true } : {}) };
    const tags = mentionTags(msg.text);
    for (const q of this.peers.values()) {
      if (!q.ready || q.kind === 'freeq') continue;
      const hit = zoneAt(q.x, q.y)?.id === zoneId;
      const ment = mentionsPeer(tags, q);
      if (hit || ment) this.sendTo(q, { ...msg, mention: ment, far: !hit && ment });
    }
  }

  ownerKey(p) { return p.did || `${p.kind}:${p.name}`; }

  async handle(p, m) {
    await this.ready;
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
      case 'use': return this.use(p, m);
      case 'gallery': return this.galleryOp(p, m);
      case 'wave': return this.wave(p, m);
      case 'audio': p.audio = !!m.on; return this.broadcast({ t: 'peer', id: p.id, audio: p.audio });
      case 'av': return this.av(p, m);
      case 'book': return this.book(p, m);
      case 'rtc': return this.rtc(p, m);
      case 'ping': return this.sendTo(p, { t: 'pong', ts: m.ts });
    }
  }

  async hello(p, m) {
    if (p.ready || p.greeting) return;
    p.greeting = true;
    p.kind = m.kind === 'agent' ? 'agent' : 'human';
    p.name = clip(m.name, 32) || (p.kind === 'agent' ? 'agent' : 'guest');
    let arrival = null;
    if (p.authDid) {
      // Identity comes from the signed-in DID only, never from the hello
      // message, so nobody can walk in wearing someone else's handle.
      p.did = p.authDid;
    } else if (m.handle) {
      this.sendTo(p, { t: 'error', message: `sign in to use @${clip(m.handle, 253)}; walking in as a guest` });
    }
    // Their actor entity has their character, last status and notes kept for them.
    const key = this.actorKey(p);
    if (key) arrival = await this.ref(`actor:${key}`).arrive().catch((e) => ({ error: e.message }));
    if (arrival?.profile) {
      const a = arrival.profile;
      p.handle = a.handle;
      p.actor = { sprite: a.sprite, stats: a.stats, displayName: a.displayName, description: a.description };
      p.name = clip(m.name, 32) || a.displayName || a.handle || p.name;
    } else if (p.did && arrival?.error && this.loadActor) {
      this.sendTo(p, { t: 'error', message: `couldn't load your character: ${arrival.error}` });
    }
    if (m.status && STATUSES.has(m.status)) p.status = m.status;
    else if (STATUSES.has(arrival?.status)) p.status = arrival.status;
    p.note = clip(m.note ?? arrival?.note ?? '', 80);
    p.ready = true;
    this.replaceOlder(p);
    this.sendTo(p, {
      t: 'welcome', id: p.id, now: this.now(), you: this.publicPeer(p),
      peers: [...this.peers.values()].filter((q) => q.ready && q !== p).map((q) => this.publicPeer(q)),
      desks: this.desks, strokes: this.strokes, notes: this.notes, pomo: this.pomoState(),
      scores: this.scores.slice(0, 10), counters: this.counters, shouts: this.shouts.slice(-20),
      bookings: this.bookings, freeq: this.freeq?.state() || {}, objects: this.objects(),
      gallery: this.gallery,
    });
    for (const msg of arrival?.inbox || []) this.sendTo(p, msg);
    this.broadcast({ t: 'join', peer: this.publicPeer(p) }, p);
    this.touchDesk(p);
    const zone = zoneAt(p.x, p.y);
    if (zone) this.publish(`zone:${zone.id}`, { type: 'enter', who: this.who(p) });
    this.publish('office', { type: 'join', who: this.who(p) });
    this.freeq?.presence();
  }

  // One avatar per identity: a newer connection for the same DID (another
  // tab, a phone, a reconnect whose old socket never closed) replaces the
  // older ones. They're told why and their client doesn't reconnect.
  replaceOlder(p) {
    if (!p.did) return;
    for (const q of [...this.peers.values()]) {
      if (q === p || q.did !== p.did || q.kind === 'freeq') continue;
      this.sendTo(q, { t: 'replaced', text: 'You opened the office somewhere else, so this window was signed out of it.' });
      try { q.ws.close(REPLACED, 'opened elsewhere'); } catch { /* already gone */ }
      this.leave(q);
    }
  }

  move(p, m) {
    const x = num(m.x, 0, 48, p.x), y = num(m.y, 0, 32, p.y);
    if (isBlocked(Math.floor(x), Math.floor(y)) && !p.seat) return;
    // Guard against teleport hacks beyond a generous per-message step.
    if (Math.hypot(x - p.x, y - p.y) > 6 && !m.teleport) return;
    // A locked booking keeps everyone but its holders out of the room.
    const from = zoneAt(p.x, p.y), to = zoneAt(x, y);
    if (to?.bookable && to !== from && lockedOut(this.bookings, to.id, p, this.now())) {
      const b = activeBooking(this.bookings, to.id, this.now());
      return this.sendTo(p, { t: 'bounce', x: p.x, y: p.y, room: to.id, text: `🔒 ${to.name} is booked for “${b.title}” until ${fmtTime(b.end)}. Knock to be let in.` });
    }
    p.x = x; p.y = y; p.dir = num(m.dir, 0, 3, 0) | 0; p.moving = !!m.moving;
    if (p.seat && m.moving) p.seat = null;
    this.broadcast({ t: 'move', id: p.id, x, y, dir: p.dir, moving: p.moving, seat: p.seat }, p);
    // Areas are topics: rooms (and anything else) can react to people coming and going.
    if (to !== from) {
      const who = this.who(p);
      if (from) this.publish(`zone:${from.id}`, { type: 'exit', who });
      if (to) this.publish(`zone:${to.id}`, { type: 'enter', who });
    }
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
    // An area attached to a freeq channel is one conversation: the whole
    // area hears it, and it goes to the channel as the speaker.
    const bridged = zone && this.freeq?.bindings.get(zone.id);
    if (bridged) {
      msg.scope = bridged.channel;
      this.freeq.relay(p, zone.id, msg.text).then((note) => {
        // The same note again within a minute (a guest chatting away) isn't news.
        if (note && (note !== p.freeqNote || this.now() - p.freeqNoteAt > 60000)) this.sendTo(p, { t: 'freeq-note', text: note, ok: false });
        if (note) { p.freeqNote = note; p.freeqNoteAt = this.now(); }
      });
    }
    const hears = (q) => (bridged ? zoneAt(q.x, q.y) === zone : canHear(p, q));
    // Mentions reach the person anywhere, which is how you tap someone on
    // the shoulder across the office (and how agents get asked things).
    // `mention` means "addressed to you"; `far` means you only got it
    // because of the mention.
    const tags = mentionTags(text);
    for (const q of this.peers.values()) {
      if (!q.ready) continue;
      const hit = q === p || hears(q);
      const ment = q !== p && mentionsPeer(tags, q);
      if (hit || ment) this.sendTo(q, { ...msg, mention: ment, far: !hit && ment });
    }
  }

  setStatus(p, m) {
    if (m.status && STATUSES.has(m.status)) p.status = m.status;
    if (m.note !== undefined) p.note = clip(m.note, 80);
    this.broadcast({ t: 'peer', id: p.id, status: p.status, note: p.note });
    const key = this.actorKey(p);
    if (key) this.bg(this.ref(`actor:${key}`).remember({ status: p.status, note: p.note }));
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

  // ---- items: each is its own entity -------------------------------------
  async desk(p, m) {
    const d = DESKS.find((x) => x.id === m.desk);
    if (!d) return;
    const desk = this.ref(`desk:${d.id}`), who = this.who(p);
    if (m.action === 'claim') {
      const r = await desk.claim(who, m.goal);
      if (r?.error) this.sendTo(p, { t: 'error', message: r.error });
    } else if (m.action === 'goal') await desk.goal(who, m.goal);
    else if (m.action === 'release') await desk.release(who);
  }

  touchDesk(p) {
    const key = this.ownerKey(p);
    for (const [id, v] of Object.entries(this.desks)) if (v.owner === key) this.bg(this.ref(`desk:${id}`).touch(key));
  }

  async pomodoro(p, m) {
    const zone = zoneAt(p.x, p.y);
    if (!zone || !POMO_ZONES.includes(zone.id)) return;
    const timer = this.ref(`pomodoro:${zone.id}`);
    if (m.action === 'start') await timer.start(this.who(p), { focusMin: m.focusMin, breakMin: m.breakMin });
    else if (m.action === 'stop') await timer.stop();
  }

  broadcastPomo() {
    this.broadcast({ t: 'pomo', pomo: this.pomoState(), counters: this.counters, now: this.now() });
  }

  async whiteboard(p, m) {
    const board = this.ref('whiteboard:main');
    if (m.op === 'clear') await board.clear();
    else if (m.op === 'stroke') await board.stroke(this.who(p), { points: m.points, color: m.color, size: m.size });
  }

  async noticeboard(p, m) {
    const board = this.ref('noticeboard:main');
    if (m.op === 'add') await board.add(this.who(p), m.text);
    else if (m.op === 'remove') await board.remove(this.who(p), m.id);
  }

  async coffee(p) {
    p.cup = true;
    clearTimeout(p.cupTimer);
    p.cupTimer = setTimeout(() => { p.cup = false; this.broadcast({ t: 'peer', id: p.id, cup: false }); }, 5 * 60000);
    p.cupTimer.unref?.();
    this.broadcast({ t: 'peer', id: p.id, cup: true });
    await this.ref('coffee:main').brew();
    // Tell anyone nearby that a coffee chat is brewing.
    for (const q of this.peers.values()) {
      if (q !== p && q.ready && canHear(p, q)) this.sendTo(q, { t: 'toast', text: `☕ ${p.name} grabbed a coffee nearby. Coffee chat?` });
    }
  }

  score(p, m) {
    return this.ref('arcade:main').score(this.who(p), m.score);
  }

  // Using a plugin object (jukebox, vending machine…): its entity calls the
  // plugin and answers with effects (see entities/plugin.js).
  async use(p, m) {
    const f = PLUGIN_OBJECTS.find((x) => x.id === m.id) || this.uploaded(m.id);
    if (!f) return;
    const cx = Math.max(f.x, Math.min(p.x, f.x + f.w)), cy = Math.max(f.y, Math.min(p.y, f.y + f.h));
    if (Math.hypot(cx - p.x, cy - p.y) > 3) return this.sendTo(p, { t: 'objui', id: f.id, ui: null, toast: `Walk up to the ${f.name} to use it.` });
    return this.ref(`${f.plugin === 'upload' ? 'uobj' : 'plugin'}:${f.id}`).interact(this.who(p), cleanRequest(m));
  }

  objects() {
    const out = {};
    for (const f of PLUGIN_OBJECTS) { const v = this.mirror.get(`plugin:${f.id}`); if (v?.display) out[f.id] = v.display; }
    for (const f of this.gallery) { const v = this.mirror.get(`uobj:${f.id}`); if (v?.display) out[f.id] = v.display; }
    return out;
  }

  // Objects people uploaded (gallery:main), as map objects.
  get gallery() { return this.mirror.get('gallery:main') || []; }
  uploaded(id) {
    const i = this.gallery.find((x) => x.id === id);
    return i && { ...i, w: 1, h: 1, plugin: 'upload' };
  }

  // Uploading and removing objects from the web UI: the same calls as the
  // MCP tools gallery_upload / gallery_remove, answered as { t: 'galleryres', rid, result }.
  async galleryOp(p, m) {
    const method = m.op === 'remove' ? 'remove' : m.op === 'upload' ? 'upload' : null;
    if (!method) return;
    let result;
    try { result = await this.call(p, 'gallery:main', method, [m.req || {}]); }
    catch (e) { result = { error: clip(e.message, 200) }; }
    this.sendTo(p, { t: 'galleryres', rid: m.rid, result });
  }

  wave(p, m) {
    const q = this.peers.get(m.to);
    if (!q || !q.ready) return;
    this.waves++;
    this.onChange();
    this.sendTo(q, { t: 'wave', from: p.id, name: p.name, kind: m.kind === 'knock' ? 'knock' : 'wave' });
    this.broadcast({ t: 'peer', id: p.id, emote: 'wave' });
  }

  rtc(p, m) {
    const q = this.peers.get(m.to);
    if (!q || !q.ready) return;
    this.sendTo(q, { t: 'rtc', from: p.id, data: m.data });
  }

  // ---- A/V rooms ----------------------------------------------------------
  // Camera and screen share flags. The media itself is peer to peer; these
  // just let everyone draw who's on camera. Only meaningful in an A/V room.
  av(p, m) {
    const ok = !!zoneAt(p.x, p.y)?.av;
    p.video = ok && !!m.video;
    p.screen = ok && !!m.screen;
    this.broadcast({ t: 'peer', id: p.id, video: p.video, screen: p.screen });
  }

  // ---- meeting room bookings: each room is its own entity -----------------
  // { t: 'book', op: 'create' | 'cancel' | 'extend' | 'end' | 'update' | 'admit', ref? }
  // Replies { t: 'booked', ref, booking } or { t: 'error', ref, message }.
  async book(p, m) {
    const ref = typeof m.ref === 'string' || typeof m.ref === 'number' ? m.ref : undefined;
    const fail = (message) => this.sendTo(p, { t: 'error', message, ref });
    if (m.op === 'create' && !p.did && p.kind !== 'agent') return fail('sign in to book a room');
    const room = m.op === 'create' ? roomById(m.room)?.id : this.bookings.find((b) => b.id === m.id)?.room;
    if (!room) return fail(m.op === 'create' ? 'no such room' : 'no such booking');
    const r = await this.ref(`room:${room}`).book(this.who(p), m, { all: this.bookings, presence: this.presence() });
    if (r.error) return fail(r.error);
    this.sendTo(p, { t: 'booked', ref, booking: r.booking });
  }

  // Rooms keep their own alarms; this nudges them all now (tests, catch-up).
  tickRooms() {
    const presence = this.presence();
    return Promise.all(ROOMS.map((r) => this.ref(`room:${r.id}`).tick({ presence })));
  }

  nextRoomEvent() { return nextRoomEvent(this.bookings, this.now()); }

  showOut(q, room, text) {
    q.x = room.door.x; q.y = room.door.y; q.seat = null; q.moving = false;
    q.video = false; q.screen = false;
    this.sendTo(q, { t: 'bounce', x: q.x, y: q.y, room: room.id, text });
    this.broadcast({ t: 'move', id: q.id, x: q.x, y: q.y, dir: q.dir, moving: false, seat: null }, q);
    this.broadcast({ t: 'peer', id: q.id, video: false, screen: false });
  }
}
