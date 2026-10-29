// The World: the office hub that holds everyone's socket. Movement,
// presence, proximity chat, sitting, emotes, A/V flags and the WebRTC
// signalling relay happen here, because they need to be fast. Everything
// else with its own state is an entity (server/entities): each actor, each
// meeting room, each desk, each pomodoro timer, the whiteboard, the notice
// board, the arcade and the coffee machine. The World hands them requests,
// mirrors what they show (so a welcome is one message, with no round trips),
// and carries out the effects they send back (Office.apply).

import { mentionTags, mentionsPeer } from '../public/js/mentions.js';
import { SPAWN, DESKS, SEATS, FURNITURE, PLUGIN_OBJECTS, zoneAt, canHear, isBlocked, applyWing } from '../public/js/map.js';
import * as map from '../public/js/map.js';
import { cleanRequest } from './plugins.js';
import { ROOMS, roomById, lockedOut, activeBooking } from '../public/js/rooms.js';
import { stamp } from '../public/js/time.js';
import { LocalRuntime, EntityHost, MemoryStorage, parse } from './entities/runtime.js';
import { KINDS, MIRRORED, POMO_ZONES, ITEM, nextRoomEvent } from './entities/kinds.js';
import { str, int, arr, obj, opt, WHO, describeKind, paramList } from './entities/schema.js';
import { GUEST_SLOTS, PICKUP_RANGE, GIVE_RANGE, ITEMS, applyChange, cleanItem, label, useLine } from '../public/js/items.js';
import { mayEnter } from './entities/channels.js';
import { summary as accessSummary } from '../public/js/policy.js';

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
    inventoryOf: { doc: 'What someone in the office carries (their actor\'s inventory, or a guest\'s for this visit). Plugin objects pass it to their plugin.', params: { peer: str('Peer id') }, returns: arr(ITEM, 'Item stacks'), internal: true },
    invApply: { doc: 'Take and give items for someone in the office, all or nothing, and tell them. Plugin objects call it with what their plugin gives and takes.', params: { peer: str('Peer id'), change: { type: 'object', description: '{ take?, give?, from? } as actor.invApply' } }, returns: { type: 'object', description: '{ items, taken } or { error }' }, mutates: true, internal: true },
  },
  events: {
    publishes: {
      'zone:<id>': '{ type: "enter" | "exit", who } when someone walks in or out of a zone',
      office: '{ type: "join" | "leave", who } when someone comes in or goes',
    },
  },
};

// What people carry, served by the World because only it knows where
// everyone stands (proximity) and who's a guest. Described like an entity
// (address inventory:me, always the caller's own) so the docs and the MCP
// tools (inventory_view, inventory_use…) come from it. Signed-in people and
// agents keep theirs on their actor; a guest's lasts as long as the visit.
export const INVENTORY = {
  doc: 'What you carry. Things come from objects (the coffee machine pours you a coffee, the vending machine drops a snack), from the floor, and from other people. Use them (eat, drink, show off), put them down where you stand, or hand them to someone within 3 tiles. Signed-in people and agents keep theirs between visits (on their actor); guests carry at most 6 things, for this visit only. Served by the World, always for the caller.',
  api: {
    view: { doc: 'What you carry.', who: true, returns: arr(ITEM, 'Item stacks') },
    use: { doc: 'Use one of your things: eat it, drink it, or show it off. Everyone who can hear you sees it; things like snacks are used up.', who: true, mutates: true, params: { id: str('Stack id (from inventory_view)', 16) }, returns: obj({ items: arr(ITEM, 'What you carry now'), did: str('What it looked like') }) },
    drop: { doc: 'Put something down where you stand. Anyone can pick it up; it is cleared away after a day.', who: true, mutates: true, params: { id: str('Stack id', 16), qty: opt(int('How many (default all of the stack)', 1, 20)) }, returns: obj({ items: arr(ITEM, 'What you carry now'), floor: str('Floor id') }) },
    give: { doc: 'Hand something to a person within 3 tiles.', who: true, mutates: true, params: { id: str('Stack id', 16), to: str('Their peer id, name or handle', 253), qty: opt(int('How many (default 1)', 1, 20)) }, returns: obj({ items: arr(ITEM, 'What you carry now'), to: str('Who got it') }) },
    pickup: { doc: 'Pick something up off the floor (floor_view lists it). You must be within 1.5 tiles of it: walk_to it first.', who: true, mutates: true, params: { id: str('Floor id', 16) }, returns: obj({ items: arr(ITEM, 'What you carry now') }) },
  },
};

const STATUSES = new Set(['available', 'focus', 'meeting', 'away', 'coffee']);
const IDLE_POMO = { phase: 'idle', endsAt: 0, round: 0, focusMin: 25, breakMin: 5 };
// Close code for a connection replaced by a newer one for the same identity
// (public/js/net.js doesn't reconnect after it).
export const REPLACED = 4001;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, d = lo) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
// How far someone stands from a piece of furniture (its nearest edge).
const distTo = (f, p) => Math.hypot(Math.max(f.x, Math.min(p.x, f.x + (f.w || 1))) - p.x, Math.max(f.y, Math.min(p.y, f.y + (f.h || 1))) - p.y);

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
    // The channel wing, as last mirrored (a hibernation wake has it at once).
    this.layout(this.mirror.get('wing:main'), false);
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
    this.layout(this.mirror.get('wing:main'), false);
  }

  // ---- the channel wing (entities/channels.js, public/js/wing.js) ----------
  // Rebuild the map around the wing's rooms and tell everyone.
  layout(rooms, announce = true) {
    rooms = Array.isArray(rooms) ? rooms : [];
    applyWing(rooms);
    // The World only publishes to topics it knows have listeners; a new
    // room's topic gets its listener (the room) as it's made.
    // Same for each room's door, which the World checks at the threshold.
    for (const r of rooms) {
      for (const t of [`topic:zone:${r.id}`, `chan:${r.id}`]) {
        if (!this.mirror.has(t)) this.bg(this.ref(t).view().then((v) => { if (!this.mirror.has(t)) { this.mirror.set(t, v); this.onMirror(t); } }));
      }
    }
    if (announce) this.broadcast({ t: 'wing', rooms });
  }

  get wing() { return this.mirror.get('wing:main') || []; }

  // A channel room's door rule for p. Until the door's own view arrives, the
  // wing's copy of the policy stands in (closed rather than open).
  door(zoneId, p) {
    const door = this.mirror.get(`chan:${zoneId}`) || { policy: this.wing.find((r) => r.id === zoneId)?.policy || null };
    return mayEnter(door, this.who(p));
  }

  // A channel source (the freeq bridge, or anything else that knows of
  // channels) offers what it has: [{ name, members, topic }]. Each gets a
  // room off the hallway. Returns channel ('#name', lowercase) -> zone id.
  async offerChannels(source, channels) {
    const zones = await this.ref('wing:main').offer(source, channels);
    // The mirror push normally got here first; this covers a slow one.
    const ids = new Set(map.ZONES.map((z) => z.id));
    if (Object.values(zones).some((id) => !ids.has(id))) this.layout(await this.ref('wing:main').view());
    return zones;
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
  get floor() { return this.mirror.get('floor:main') || []; }
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
  // `self` entities (workstations) are always the caller's own, whatever the
  // address said; `atDesk` needs the caller sitting at a desk.
  async call(p, address, method, args = [], { internal = false } = {}) {
    let { kind, name } = parse(address);
    const spec = kind === 'inventory' ? INVENTORY.api[method] : KINDS[kind] && describeKind(kind, KINDS[kind]).api[method];
    if (!spec || (spec.internal && !internal)) throw new Error(`${address} has no public method ${method}`);
    if ((spec.who || spec.mutates || spec.inZone || spec.near || spec.self) && !p?.ready) throw new Error('join the office first');
    let target = null;
    if (spec.self) {
      const key = this.actorKey(p);
      if (key) { address = `${kind}:${key}`; name = key; } else target = this.guestStation(p, kind);
    }
    if (spec.atDesk && !this.deskOf(p)) throw new Error('sit at a desk first (take_desk, or sit on a desk-N-chair)');
    if (spec.inZone && zoneAt(p.x, p.y)?.id !== name) throw new Error(`walk to ${name} first`);
    if (spec.near) {
      // Same rule as the browser: walk up to it (its nearest edge) first.
      const f = FURNITURE.find((x) => x.id === name) || DESKS.find((x) => x.id === name) || this.uploaded(name);
      if (!f) throw new Error(`${address} isn't on the map`);
      const cx = Math.max(f.x, Math.min(p.x, f.x + (f.w || 1))), cy = Math.max(f.y, Math.min(p.y, f.y + (f.h || 1)));
      if (Math.hypot(cx - p.x, cy - p.y) > spec.near) throw new Error(`you're too far from the ${f.name || name}: walk_to ${name} first (within ${spec.near} tiles)`);
    }
    if (kind === 'inventory') return this.inventoryCall(p, method, args);
    if (method === 'view' && this.mirror.has(address)) return this.mirror.get(address);
    const params = paramList(spec).map((_, i) => args[i]);
    while (params.length && params.at(-1) === undefined) params.pop();
    if (spec.ctx) params.length = paramList(spec).length;
    const all = [...(spec.who ? [this.who(p)] : []), ...params, ...(spec.ctx ? [{ all: this.bookings, presence: this.presence() }] : [])];
    if (target) return structuredClone(await target.invoke(method, structuredClone(all)));
    return this.ref(address)[method](...all);
  }

  // The desk whose chair p sits on, if any.
  deskOf(p) { return p?.seat ? SEATS.find((s) => s.id === p.seat)?.desk || null : null; }

  // A guest has no actor, so their workstation lives with their connection
  // and is gone when they leave (or when a hibernating Worker wakes).
  guestStation(p, kind) {
    if (p.station) return p.station;
    const storage = new MemoryStorage({ state: { guest: true, peer: p.id } });
    p.station = new EntityHost(KINDS[kind], {
      address: `${kind}:guest`, kind, name: 'guest', storage, services: this.runtime.services || {},
      now: () => this.now(),
      ref: (a) => this.ref(a),
      setAlarm: (t) => {
        clearTimeout(p.stationTimer);
        if (t == null) return;
        p.stationTimer = setTimeout(() => p.station?.alarm().catch(() => {}), Math.max(0, t - this.now()));
        p.stationTimer.unref?.();
      },
    });
    return p.station;
  }

  // The browser's workstation (public/js/workstation.js): any public method
  // of the caller's own workstation, answered by ref. The computer shows on
  // the desk while it's in use.
  async workstation(p, m) {
    if (m.method === 'power') {
      p.pc = !!m.on && !!this.deskOf(p);
      return this.broadcast({ t: 'peer', id: p.id, pc: p.pc });
    }
    const ref = typeof m.ref === 'number' || typeof m.ref === 'string' ? m.ref : null;
    try {
      const allowed = m.method === 'prefs' ? { internal: true } : {};
      const result = await this.call(p, 'workstation:self', String(m.method || ''), Array.isArray(m.args) ? m.args.slice(0, 4) : [], allowed);
      this.sendTo(p, { t: 'wsr', ref, result: result ?? null });
    } catch (e) {
      this.sendTo(p, { t: 'wsr', ref, error: e.message });
    }
  }

  // ---- what entities may call on the World --------------------------------
  worldApi() {
    return {
      apply: (effects) => this.apply(effects),
      presence: () => this.presence(),
      deliver: (key, msg) => this.deliver(key, msg),
      summary: () => this.summary(),
      inventoryOf: (id) => { const p = this.peers.get(id); return p ? this.inventory(p) : []; },
      invApply: (id, change) => { const p = this.peers.get(id); return p?.ready ? this.invApply(p, change) : { error: 'they left' }; },
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
      case 'floor': return this.broadcast({ t: 'floor', items: this.floor });
      case 'pomodoro': return this.broadcastPomo();
      case 'wing': return this.layout(value);
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
      channels: this.wing,
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
      video: p.video, screen: p.screen, pc: p.pc, cup: p.cup, joinedAt: p.joinedAt,
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
    const { ws, cupTimer, emoteTimer, ...rest } = p;
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
    clearTimeout(p.stationTimer); p.station = null;
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
    this.remember(zoneId, { name: msg.name, text: msg.text, ts: msg.ts, freeq: true });
    for (const q of this.peers.values()) {
      if (!q.ready || q.kind === 'freeq') continue;
      const hit = zoneAt(q.x, q.y)?.id === zoneId;
      const ment = mentionsPeer(tags, q);
      if (hit || ment) this.sendTo(q, { ...msg, mention: ment, far: !hit && ment });
    }
  }

  ownerKey(p) { return p.did || `${p.kind}:${p.name}`; }

  // A line said in a channel room, kept by the room for whoever walks in next.
  remember(zoneId, line) {
    if (map.ZONES.some((z) => z.id === zoneId && z.channel)) this.bg(this.ref(`chan:${zoneId}`).say(line));
  }

  // Channel rooms: { t: 'chan', op, ref?, ... }, answered with { t: 'chan', op, ref, ... } or an error.
  //   open { name, access?, rules? }   close { name }   access { name, access, rules? }
  //   check { room }   accept { room, hash }   admit { room, to }
  async chan(p, m) {
    const ref = m.ref ?? null, room = String(m.room || '');
    const calls = {
      open: () => this.call(p, 'wing:main', 'open', [String(m.name || ''), m.access, m.rules]),
      close: () => this.call(p, 'wing:main', 'close', [String(m.name || '')]),
      access: () => this.call(p, 'wing:main', 'setAccess', [String(m.name || ''), m.access, m.rules]),
      check: () => this.call(p, `chan:${room}`, 'check'),
      accept: () => this.call(p, `chan:${room}`, 'accept', [String(m.hash || '')]),
      // Knock on an invite-only room: everyone inside hears it and can let you in.
      knock: () => {
        const inside = [...this.peers.values()].filter((q) => q.ready && q.kind !== 'freeq' && zoneAt(q.x, q.y)?.id === room);
        for (const q of inside) this.sendTo(q, { t: 'wave', from: p.id, name: p.name, kind: 'knock', chanRoom: room });
        return { ok: inside.length > 0, inside: inside.length, ...(inside.length ? {} : { error: 'nobody is inside to let you in' }) };
      },
      admit: () => {
        // Let in by peer id: remember them by who they are, so it lasts.
        const q = this.peers.get(m.to);
        if (q?.ready) this.sendTo(q, { t: 'toast', text: `🔓 ${p.name} let you into ${this.wing.find((r) => r.id === room)?.channel || 'the room'}` });
        return this.call(p, `chan:${room}`, 'admit', [q ? this.ownerKey(q) : String(m.to || '')]);
      },
    };
    if (!calls[m.op] || (m.op !== 'open' && m.op !== 'close' && m.op !== 'access' && !this.wing.some((r) => r.id === room))) return this.sendTo(p, { t: 'error', message: 'no such channel room', ref });
    const r = await calls[m.op]().catch((e) => ({ error: e.message }));
    if (r?.error) return this.sendTo(p, { t: 'error', message: r.error, ref });
    this.sendTo(p, { t: 'chan', op: m.op, ref, room: m.op === 'check' ? room : r.room || room, result: r });
  }

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
      case 'inv': return this.inv(p, m);
      case 'ws': return this.workstation(p, m);
      case 'wave': return this.wave(p, m);
      case 'audio': p.audio = !!m.on; return this.broadcast({ t: 'peer', id: p.id, audio: p.audio });
      case 'av': return this.av(p, m);
      case 'book': return this.book(p, m);
      case 'chan': return this.chan(p, m);
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
    // A guest's things last for the visit (a reconnect keeps them); everyone else's are on their actor.
    if (!key) p.items ||= [];
    p.ready = true;
    this.replaceOlder(p);
    this.sendTo(p, {
      t: 'welcome', id: p.id, now: this.now(), you: this.publicPeer(p),
      peers: [...this.peers.values()].filter((q) => q.ready && q !== p).map((q) => this.publicPeer(q)),
      desks: this.desks, strokes: this.strokes, notes: this.notes, pomo: this.pomoState(),
      scores: this.scores.slice(0, 10), counters: this.counters, shouts: this.shouts.slice(-20),
      bookings: this.bookings, freeq: this.freeq?.state() || {}, objects: this.objects(), wing: this.wing,
      gallery: this.gallery,
      floor: this.floor, items: key ? arrival?.items || [] : p.items, keeps: !!key,
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
    const x = num(m.x, 0, map.W, p.x), y = num(m.y, 0, map.H, p.y);
    if (isBlocked(Math.floor(x), Math.floor(y)) && !p.seat) return;
    // Guard against teleport hacks beyond a generous per-message step.
    if (Math.hypot(x - p.x, y - p.y) > 6 && !m.teleport) return;
    // A locked booking keeps everyone but its holders out of the room.
    const from = zoneAt(p.x, p.y), to = zoneAt(x, y);
    if (to?.bookable && to !== from && lockedOut(this.bookings, to.id, p, this.now())) {
      const b = activeBooking(this.bookings, to.id, this.now());
      return this.sendTo(p, { t: 'bounce', x: p.x, y: p.y, room: to.id, text: `🔒 ${to.name} is booked for “${b.title}” until ${stamp(b.end)}. Knock to be let in.` });
    }
    // A channel room's access policy: the door stays shut to whoever doesn't meet it.
    if (to?.channel && to !== from) {
      const d = this.door(to.id, p);
      if (!d.ok) {
        const a = accessSummary(this.mirror.get(`chan:${to.id}`)?.policy || this.wing.find((r) => r.id === to.id)?.policy);
        const how = d.needs.map((n) => n.label).join(d.needs.some((n) => n.or) ? ' or ' : ', ');
        return this.sendTo(p, { t: 'bounce', x: p.x, y: p.y, room: to.id, door: true, text: `${a.icon} ${to.name} (${a.text}): ${how ? `${how[0].toLowerCase()}${how.slice(1)} to get in.` : 'closed.'} Read the sign by the door.` });
      }
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
    if (zone?.channel) this.remember(zone.id, { name: p.name, text: msg.text, ts: t });
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
      // Standing up switches the desk computer off, and ends a share to its monitor.
      const off = { pc: false, ...(p.screen && !zoneAt(p.x, p.y)?.av ? { screen: false } : {}) };
      Object.assign(p, off);
      return this.broadcast({ t: 'peer', id: p.id, seat: null, ...off });
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
    this.holdCup(p);
    await this.ref('coffee:main').brew();
    // Standing at the machine, you also walk off with the cup itself.
    const machine = FURNITURE.find((f) => f.id === 'coffee');
    if (machine && distTo(machine, p) <= 3) {
      const r = await this.invApply(p, { give: [{ kind: 'coffee' }], from: 'Coffee machine' });
      if (r.error) this.sendTo(p, { t: 'toast', text: `☕ No hands free for the cup: ${r.error}` });
    }
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

  // ---- inventory -------------------------------------------------------------
  // What people carry: on their actor if they have one, on the peer for the
  // visit if they're a guest. Changes go out to each of their connections.
  async inventory(p) {
    const key = this.actorKey(p);
    if (!key) return p.items || [];
    return this.ref(`actor:${key}`).inventory();
  }

  async invApply(p, change) {
    const key = this.actorKey(p);
    let r;
    if (key) r = await this.ref(`actor:${key}`).invApply(change);
    else {
      const give = (change.give || []).map((i) => cleanItem(i, { from: change.from, now: this.now() })).filter(Boolean).map(({ data, ...i }) => i);
      r = applyChange(p.items || [], { take: change.take || [], give }, { slots: GUEST_SLOTS });
      if (r.items) p.items = r.items;
    }
    if (r.error) return r;
    if (key) this.deliver(key, { t: 'inv', items: r.items });
    else this.sendTo(p, { t: 'inv', items: r.items });
    return r;
  }

  // The inventory as the generated tools and the browser see it (INVENTORY.api).
  // Each answers { items, … } or { error }.
  async inventoryCall(p, method, [a, b, c] = []) {
    if (method === 'view') return this.inventory(p);
    if (method === 'use') return this.useItem(p, a);
    if (method === 'drop') return this.dropItem(p, a, b);
    if (method === 'give') return this.giveItem(p, a, b, c);
    if (method === 'pickup') return this.pickUp(p, a);
    throw new Error(`inventory has no method ${method}`);
  }

  // { t: 'inv', op: 'use' | 'drop' | 'give' | 'pickup', id, to?, qty? }
  async inv(p, m) {
    const op = ['use', 'drop', 'give', 'pickup'].includes(m.op) ? m.op : null;
    if (!op) return;
    const r = await this.inventoryCall(p, op, op === 'give' ? [m.id, m.to, m.qty] : op === 'drop' ? [m.id, m.qty] : [m.id]);
    if (r?.error) this.sendTo(p, { t: 'error', message: r.error });
  }

  async useItem(p, id) {
    const s = (await this.inventory(p)).find((x) => x.id === id);
    if (!s) return { error: 'you don\'t have that' };
    let items = null;
    if (s.consume) {
      const r = await this.invApply(p, { take: [{ id, qty: 1 }] });
      if (r.error) return r;
      items = r.items;
    }
    const did = useLine(s);
    this.act(p, did);
    if (s.emote) this.flashEmote(p, s.emote);
    if (ITEMS[s.kind]?.cup) this.holdCup(p);
    return { items: items || (await this.inventory(p)), did };
  }

  async dropItem(p, id, qty) {
    const s = (await this.inventory(p)).find((x) => x.id === id);
    if (!s) return { error: 'you don\'t have that' };
    const n = Math.max(1, Math.min(s.qty, Math.floor(+qty) || s.qty));
    const r = await this.invApply(p, { take: [{ id, qty: n }] });
    if (r.error) return r;
    const floor = await this.ref('floor:main').place({ item: { ...s, qty: n }, x: p.x, y: p.y + 0.3, by: p.name });
    this.act(p, `puts down ${label({ ...s, qty: n })}`);
    return { items: r.items, floor };
  }

  async giveItem(p, id, to, qty = 1) {
    const q = this.findPeer(to);
    if (!q || q === p) return { error: `nobody called ${clip(to, 40)} is here` };
    if (Math.hypot(q.x - p.x, q.y - p.y) > GIVE_RANGE) return { error: `walk over to ${q.name} first (within ${GIVE_RANGE} tiles)` };
    const s = (await this.inventory(p)).find((x) => x.id === id);
    if (!s) return { error: 'you don\'t have that' };
    const n = Math.max(1, Math.min(s.qty, Math.floor(+qty) || 1));
    const r = await this.invApply(p, { take: [{ id, qty: n }] });
    if (r.error) return r;
    const got = await this.invApply(q, { give: r.taken.map(({ id: _, ...i }) => i) });
    if (got.error) {
      // Their hands are full: it goes back to the giver.
      const back = await this.invApply(p, { give: r.taken });
      return { error: `${q.name} can't take it: ${got.error.replace(/^your hands are/, 'their hands are').replace(/ drop or use something first$/, '')}`, items: back.items };
    }
    this.sendTo(q, { t: 'toast', text: `🎁 ${p.name} gave you ${label({ ...s, qty: n })}` });
    this.act(p, `hands ${q.name} ${label({ ...s, qty: n })}`);
    return { items: r.items, to: q.name };
  }

  async pickUp(p, id) {
    const e = this.floor.find((x) => x.id === id);
    if (!e) return { error: 'that isn\'t there any more' };
    if (Math.hypot(e.x - p.x, e.y - p.y) > PICKUP_RANGE) return { error: `walk over to the ${e.item.name} first (within ${PICKUP_RANGE} tiles)` };
    const got = await this.ref('floor:main').remove(id);
    if (!got) return { error: 'someone got there first' };
    const r = await this.invApply(p, { give: [got.item] });
    if (r.error) {
      await this.ref('floor:main').place({ item: got.item, x: got.x, y: got.y, by: got.by });
      return r;
    }
    this.act(p, `picks up ${label(got.item)}`);
    return { items: r.items };
  }

  // Someone doing something with their things: an action line for everyone who can hear them.
  act(p, text) {
    const msg = { t: 'chat', id: p.id, name: p.name, text, ts: this.now(), scope: 'nearby', action: true };
    for (const q of this.peers.values()) if (q.ready && (q === p || canHear(p, q))) this.sendTo(q, msg);
  }

  flashEmote(p, name) {
    p.emote = name;
    this.broadcast({ t: 'peer', id: p.id, emote: name });
    clearTimeout(p.emoteTimer);
    p.emoteTimer = setTimeout(() => { if (p.emote === name) { p.emote = null; this.broadcast({ t: 'peer', id: p.id, emote: null }); } }, 3000);
    p.emoteTimer.unref?.();
  }

  holdCup(p) {
    p.cup = true;
    clearTimeout(p.cupTimer);
    p.cupTimer = setTimeout(() => { p.cup = false; this.broadcast({ t: 'peer', id: p.id, cup: false }); }, 5 * 60000);
    p.cupTimer.unref?.();
    this.broadcast({ t: 'peer', id: p.id, cup: true });
  }

  findPeer(q) {
    const s = String(q ?? '').toLowerCase().replace(/^@/, '');
    if (!s) return null;
    const ready = [...this.peers.values()].filter((x) => x.ready && x.kind !== 'freeq');
    return this.peers.get(q)?.ready && this.peers.get(q).kind !== 'freeq' ? this.peers.get(q)
      : ready.find((x) => x.name.toLowerCase() === s || x.name.toLowerCase().replace(/\s+/g, '') === s || x.handle?.toLowerCase() === s) || null;
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
    // Cameras belong to A/V rooms; a screen can also go up on your desk monitor.
    const ok = !!zoneAt(p.x, p.y)?.av;
    p.video = ok && !!m.video;
    p.screen = (ok || !!this.deskOf(p)) && !!m.screen;
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
