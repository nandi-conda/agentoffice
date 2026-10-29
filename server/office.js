// The World: the office hub that holds everyone's socket. Movement,
// presence, proximity chat, emotes, A/V flags and the WebRTC
// signalling relay happen here, because they need to be fast. Everything
// else with its own state is an entity (server/entities): each actor, each
// meeting room, each desk, each object on the map (the whiteboard, the
// notice board, the coffee machine…: WASM plugins) and the arcade. The World hands them requests,
// mirrors what they show (so a welcome is one message, with no round trips),
// and carries out the effects they send back (Office.apply).

import { mentionTags, mentionsPeer } from '../public/js/mentions.js';
import { SPAWN, openSpot, DESKS, SEATS, FURNITURE, PLUGIN_OBJECTS, zoneAt, deskAt, canHear, isBlocked, applyWing } from '../public/js/map.js';
import * as map from '../public/js/map.js';
import { cleanRequest } from './plugins.js';
import { ROOMS, roomById, activeBooking, restrictedAt, panelOf, toTime } from '../public/js/rooms.js';
import { stamp } from '../public/js/time.js';
import { LocalRuntime, EntityHost, MemoryStorage, parse } from './entities/runtime.js';
import { KINDS, MIRRORED, POMO_ZONES, ITEM } from './entities/kinds.js';
import { str, int, num as numS, bool, arr, obj, opt, WHO, describeKind, paramList } from './entities/schema.js';
import { GUEST_SLOTS, PICKUP_RANGE, GIVE_RANGE, ITEMS, applyChange, cleanItem, unowned, label, useLine, placeError, nearestPlace, holdsKey, SKELETON_KEY } from '../public/js/items.js';
import { mayEnter } from './entities/channels.js';
import { summary as accessSummary } from '../public/js/policy.js';
import { LogBuffer, log } from './logs.js';
import { ROLES, GRANTABLE, atLeast, rank, effectiveRole, roleLabel, can } from '../public/js/roles.js';
import { placed, asItem, CARRIED } from './entities/gallery.js';

// What entities may call on the World ('world:main'), in the same shape as
// an entity's `static api` (see entities/schema.js), for the API docs.
export const WORLD = {
  doc: 'The office itself (OfficeRoom): everyone\'s socket, movement, presence, proximity chat, emotes, A/V flags and the WebRTC relay. It hands entities requests, mirrors what they show, and carries out the effects they send back.',
  api: {
    apply: {
      doc: 'Carry out effects: { op: "mirror", value | push+max, except?, quiet? } (what the sender shows changed), { op: "send", to: peerId, msg }, { op: "broadcast", msg, except? }, { op: "showOut", to: peerId, room, text }, { op: "log", entries } (server logs, for operators). Entities call it through this.emit(), this.mirror() and this.log().',
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
  doc: 'What you carry. Things come from objects (the coffee machine pours you a coffee, the vending machine drops a snack), from the floor, and from other people. Use them (eat, drink, show off), throw them away, put them down on a spot within 3 tiles, or hand them to someone within 3 tiles. Signed-in people and agents keep theirs between visits (on their actor); guests carry at most 6 things, for this visit only. Served by the World, always for the caller.',
  api: {
    view: { doc: 'What you carry.', who: true, returns: arr(ITEM, 'Item stacks') },
    use: { doc: 'Use one of your things: eat it, drink it, or show it off. Everyone who can hear you sees it; things like snacks are used up.', who: true, mutates: true, params: { id: str('Stack id (from inventory_view)', 16) }, returns: obj({ items: arr(ITEM, 'What you carry now'), did: str('What it looked like') }) },
    place: { doc: 'Put something down on a tile within 3 tiles of you that you can reach on foot: not a wall or furniture, not something already lying or standing there, not a booked room you\'re kept out of. Leave out x and y to put it down at your feet (or the nearest free tile). Things lie on the floor: anyone can pick them up, and they are cleared away after a day. An object you carry (an uploaded plugin: an arcade cabinet, a guestbook…) stands up in the room as itself instead, works for everyone, and is yours: only you (or a moderator) can pick it up again.', who: true, mutates: true, params: { id: str('Stack id', 16), x: opt(numS('Tile x (any point in the tile)', 0, 48)), y: opt(numS('Tile y', 0, 32)), qty: opt(int('How many (default all of the stack)', 1, 20)) }, returns: obj({ items: arr(ITEM, 'What you carry now'), floor: opt(str('Floor id, when it lies on the floor')), object: opt(str('Object id (u-…), when it stands up as itself')), x: numS('Where it landed: tile centre x', 0, 48), y: numS('Tile centre y', 0, 32) }) },
    give: { doc: 'Hand something to a person within 3 tiles.', who: true, mutates: true, params: { id: str('Stack id', 16), to: str('Their peer id, name or handle', 253), qty: opt(int('How many (default 1)', 1, 20)) }, returns: obj({ items: arr(ITEM, 'What you carry now'), to: str('Who got it') }) },
    destroy: { doc: 'Throw something away for good: it is gone, not put down anywhere, and nobody gets it back. Works anywhere.', who: true, mutates: true, params: { id: str('Stack id', 16), qty: opt(int('How many (default all of the stack)', 1, 20)) }, returns: obj({ items: arr(ITEM, 'What you carry now') }) },
    pickup: { doc: 'Pick something up off the floor (floor_view lists it), or an object standing in a room that is yours (gallery_view lists it: its u-… id), which goes into your inventory as one item. You must be within 1.5 tiles of it: walk_to it first.', who: true, mutates: true, params: { id: str('Floor id, or an object id (u-…)', 16) }, returns: obj({ items: arr(ITEM, 'What you carry now') }) },
  },
};

// Moderation and roles, served by the World because only it holds the
// sockets and knows where everyone stands. Described like an entity
// (address mod:main) so the docs and the MCP tools (mod_kick, mod_grant…)
// come from it; each method's `role` is checked in Office.call and the MCP
// hub only lists the tools to people who have it. Nobody can act on
// someone whose role is as high as theirs, except owners.
const PERSON = str('Their peer id, name or handle', 253);
export const MOD = {
  doc: `Moderation and server roles. Moderators kick, mute and move people, clear the floor, remove uploads and notices, close channel rooms or change their door, and cancel anyone's booking (those last ones through the usual tools); admins also grant roles and ban; owners make admins. Owners and admins start from the OWNER_DIDS and ADMIN_DIDS env vars; MCP sessions with the operator token (MCP_TOKEN) are owners. Served by the World. Roles: ${Object.entries(ROLES).map(([r, v]) => `${r} (${v.doc})`).join('; ')}`,
  api: {
    people: {
      doc: 'Everyone in the office with their role (and whether they are muted), and everyone granted a role.', who: true, role: 'moderator',
      returns: obj({ online: arr(obj({ id: str('Peer id'), name: str('Name'), handle: { type: ['string', 'null'] }, did: { type: ['string', 'null'] }, kind: str('human, agent or freeq'), role: str('Role'), muted: opt(int('Muted until, ms since epoch', 0)), zone: { type: ['string', 'null'] } }), 'In the office'), granted: { type: 'object', description: 'DID -> { role, name, handle, by, at, env? } (roles:main)' } }),
    },
    kick: { doc: 'Send someone out of the office. They can come back (ban them to keep them out).', who: true, mutates: true, role: 'moderator', params: { to: PERSON, reason: opt(str('Why, shown to them', 200)) }, returns: obj({ ok: opt(bool('Kicked')), error: opt(str('Why not')) }) },
    mute: { doc: 'Stop someone chatting and talking (their mic goes off) for a while, even if they come back in.', who: true, mutates: true, role: 'moderator', params: { to: PERSON, minutes: opt(int('How long (default 10)', 1, 1440)), reason: opt(str('Why, shown to them', 200)) }, returns: obj({ until: opt(int('Muted until, ms since epoch', 0)), error: opt(str('Why not')) }) },
    unmute: { doc: 'Let someone talk again.', who: true, mutates: true, role: 'moderator', params: { to: PERSON }, returns: obj({ ok: opt(bool('Unmuted')), error: opt(str('Why not')) }) },
    move: { doc: 'Move someone to another area (default the lobby), e.g. out of a room they should not be in.', who: true, mutates: true, role: 'moderator', params: { to: PERSON, place: opt(str('Zone id or name (default lobby)', 64)) }, returns: obj({ ok: opt(bool('Moved')), zone: opt(str('Where to')), error: opt(str('Why not')) }) },
    removeItem: { doc: 'Clear something off the floor (floor_view lists it), wherever you stand.', who: true, mutates: true, role: 'moderator', params: { id: str('Floor id', 16) }, returns: obj({ ok: opt(bool('Cleared')), error: opt(str('Why not')) }) },
    grant: {
      doc: `Give someone a role: ${GRANTABLE.join(', ')} (member puts them back to the default; banned keeps them out and kicks them now). Only signed-in people (DIDs) get roles. Admins grant up to moderator to people below them; owners grant anything. Env owners and admins can't be changed here.`,
      who: true, mutates: true, role: 'admin',
      params: { to: str('Their DID, or the peer id, name or handle of someone in the office', 253), role: { type: 'string', enum: GRANTABLE, description: 'The role' } },
      returns: obj({ did: opt(str('DID')), role: opt(str('Their role now')), error: opt(str('Why not')) }),
    },
  },
};

const STATUSES = new Set(['available', 'focus', 'meeting', 'away', 'coffee']);
const IDLE_POMO = { phase: 'idle', endsAt: 0, round: 0, focusMin: 25, breakMin: 5 };
// The pomodoro timers (WASM plugin objects), one per quiet zone.
const POMOS = PLUGIN_OBJECTS.filter((f) => f.plugin === 'pomodoro');
// Close code for someone a moderator sent out (or who is banned): their
// client doesn't reconnect.
export const KICKED = 4003;

// The sockets behind one avatar: every tab or device someone has the office
// open in. To the rest of the office it looks like a single socket, so
// everything sent to a person reaches all their tabs and they stay in sync.
// WebRTC signals are the exception: they go to the tab that last used its
// mic, camera or calls (two tabs answering one call would fight over it).
// Each tab has an id so a Durable Object can find it again after waking.
export class Tabs {
  constructor(ws, id) { this.socks = new Map(); this.seen = new Map(); this.voice = null; if (ws) this.add(ws, id); }
  get size() { return this.socks.size; }
  get readyState() { for (const s of this.socks.values()) if (s.readyState === 1) return 1; return 3; }
  // A socket object can change across a wake-up; the id stays.
  add(ws, id = this.idOf(ws) || crypto.randomUUID().slice(0, 8)) {
    if (!this.socks.has(id)) { this.voice = id; this.seen.set(id, Date.now()); }
    this.socks.set(id, ws);
    return id;
  }
  idOf(ws) { for (const [id, s] of this.socks) if (s === ws) return id; return null; }
  drop(ws) {
    const id = this.idOf(ws);
    if (id) { this.socks.delete(id); this.seen.delete(id); }
    if (!this.socks.has(this.voice)) this.voice = [...this.socks.keys()].at(-1) ?? null;
    return this.socks.size;
  }
  send(s, { only = null, except = null } = {}) {
    for (const w of this.socks.values()) {
      if (w.readyState !== 1 || (only && w !== only) || w === except) continue;
      try { w.send(s); } catch { /* closing */ }
    }
  }
  sendVoice(s) { this.send(s, { only: this.socks.get(this.voice) || null }); }
  close(code, reason) { for (const w of this.socks.values()) { try { w.close(code, reason); } catch { /* already gone */ } } }
}
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, d = lo) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
// How far someone stands from a piece of furniture (its nearest edge).
const distTo = (f, p) => Math.hypot(Math.max(f.x, Math.min(p.x, f.x + (f.w || 1))) - p.x, Math.max(f.y, Math.min(p.y, f.y + (f.h || 1))) - p.y);

export class Office {
  // runtime: where the entities live (a LocalRuntime in this process by
  // default; the Worker passes one backed by Durable Objects).
  // mirror/onMirror: a saved copy of the mirror, and a hook for keeping it,
  // so a Durable Object waking from hibernation doesn't ask every entity again.
  // roles: the env bootstrap { owners, admins } (public/js/roles.js bootstrap());
  // without it, the runtime's services.roles.
  // plugins: the PluginHost that runs the WASM objects, when the office makes
  // its own runtime (without one they're out of order).
  constructor(saved = {}, { onChange = () => {}, loadActor = null, now = () => Date.now(), runtime = null, mirror = null, onMirror = () => {}, roles = null, plugins = null } = {}) {
    this.peers = new Map();
    this.onChange = onChange;
    this.loadActor = loadActor;
    this.now = now;
    this.runtime = runtime || new LocalRuntime({ kinds: KINDS, now, services: { loadActor, plugins, roles: roles || { owners: [], admins: [] } } });
    this.roleEnv = roles || this.runtime.services?.roles || { owners: [], admins: [] };
    // Owner key -> muted until (ms), so leaving and coming back doesn't lift it.
    this.mutes = new Map((saved.mutes || []).filter(([, t]) => t > now()));
    this.roleListeners = new Set();
    this.runtime.setWorld?.(this.worldApi());
    // Recent server logs, for operators over MCP (server/logs.js); the entry
    // points make it this process's log sink.
    this.logs = new LogBuffer({ now });
    this.mirror = new Map(mirror || []); // entity address -> what it shows
    this.onMirror = onMirror;
    // The channel wing, as last mirrored (a hibernation wake has it at once).
    this.layout(this.mirror.get('wing:main'), false);
    // Waves counted before the reception desk did: it takes them over (legacy 'world:waves').
    this.waves = saved.counters?.waves || saved.waves || 0;
    this.shouts = [];
    // When this copy of the office started; a recent time means a restart
    // (deploy or eviction) wiped what lives only in memory.
    this.upSince = this.now();
    // With a saved mirror the office is ready at once and refreshes behind.
    const booting = this.boot(saved.migrated ? null : saved, !!mirror?.length);
    this.ready = mirror?.length ? Promise.resolve() : booting;
    // Objects that used to be core entities (the notice board…) take over
    // their old state the first time they run.
    this.ready.then(() => { for (const f of PLUGIN_OBJECTS) if (f.legacy) this.bg(this.ref(`plugin:${f.id}`).wake()); }, () => {});
  }

  ref(address) { return this.runtime.ref(address); }

  // Background entity calls (publishing, touching desks…): never let one
  // failing take a message down with it.
  bg(promise) { promise.catch((e) => log('error', 'world', `entity call failed: ${e.message}`)); }

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
    // Then pull what everyone shows. With a saved mirror (a hibernation wake,
    // a deploy) the office is already up on it, and this refreshes it behind:
    // the saved copy can be older than the entities, when a push came in
    // after the last save and the World went away before the next one (an
    // upload that then vanished from the map and the gallery while
    // gallery:main still counted it).
    // Anything an entity pushes meanwhile is newer than the view it answered.
    const pushed = (this.pushed = new Set());
    const take = (address, r) => {
      if (pushed.has(address)) return;
      if (r.status !== 'fulfilled') return log('error', address, `view failed: ${r.reason?.message}`);
      if (cached && JSON.stringify(this.mirror.get(address) ?? null) === JSON.stringify(r.value ?? null)) return;
      this.mirrored({ from: address, value: r.value, quiet: !cached });
    };
    const views = await Promise.allSettled(MIRRORED.map((a) => this.ref(a).view()));
    views.forEach((r, i) => take(MIRRORED[i], r));
    // Uploaded objects aren't in MIRRORED (people add them): pull what each shows.
    const ups = this.gallery.map((f) => `uobj:${f.id}`);
    (await Promise.allSettled(ups.map((a) => this.ref(a).view()))).forEach((r, i) => take(ups[i], r));
    this.pushed = null;
    if (!cached) this.layout(this.mirror.get('wing:main'), false);
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
    this.freeq?.wingChanged?.();
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
    for (const [k, t] of this.mutes) if (t <= this.now()) this.mutes.delete(k);
    return { migrated: true, counters: { waves: this.waves }, ...(this.mutes.size ? { mutes: [...this.mutes] } : {}) };
  }

  // ---- what the entities show, from the mirror ---------------------------
  get desks() {
    const out = {};
    for (const d of DESKS) { const v = this.mirror.get(`desk:${d.id}`); if (v) out[d.id] = v; }
    return out;
  }
  // Every room's schedule, as its door panel shows it.
  get bookings() { return ROOMS.flatMap((r) => this.shown(panelOf(r.id))?.bookings || []).sort((a, b) => a.start - b.start); }
  get strokes() { return this.mirror.get('plugin:whiteboard')?.feed || []; }
  // What a plugin object shows everyone besides its label (display.data):
  // the notice board's notes, the coffee machine's count, the pomodoro.
  shown(id) { return this.mirror.get(`plugin:${id}`)?.display?.data || null; }
  get notes() { return this.shown('noticeboard')?.notes || []; }
  get scores() { return this.shown('arcade')?.scores || []; }
  get floor() { return this.mirror.get('floor:main') || []; }
  // Where nothing else can be put down: what lies on the floor, and the
  // objects standing in rooms.
  get occupied() { return [...this.floor, ...this.gallery.filter(placed).map((i) => ({ x: i.x + 0.5, y: i.y + 0.5 }))]; }
  get counters() {
    const pomodoros = POMOS.reduce((n, f) => n + (this.shown(f.id)?.count || 0), 0);
    // Waves are the reception desk's; until it first runs, the World's old count.
    return { coffees: this.shown('coffee')?.count || 0, pomodoros, waves: this.shown('reception')?.waves ?? this.waves };
  }
  pomoState() {
    const out = {};
    for (const f of POMOS) {
      const { phase, endsAt, round, focusMin, breakMin, startedBy } = { ...IDLE_POMO, ...this.shown(f.id) };
      out[f.zone] = { phase, endsAt, round, focusMin, breakMin, ...(startedBy ? { startedBy } : {}) };
    }
    return out;
  }

  // ---- generated API calls ------------------------------------------------
  // An entity method from its `static api`, called on behalf of peer p (null
  // for a read-only observer). The same checks for every generated MCP tool:
  // internal methods never, anything acting or naming the caller needs
  // someone in the office, inZone needs them standing in the entity's zone.
  // The World fills in `who` and `ctx`, so callers only pass the params.
  // `self` entities (workstations) are always the caller's own, whatever the
  // address said; `atDesk` needs the caller standing at a desk.
  async call(p, address, method, args = [], { internal = false } = {}) {
    let { kind, name } = parse(address);
    const spec = kind === 'inventory' ? INVENTORY.api[method] : kind === 'mod' ? MOD.api[method] : KINDS[kind] && describeKind(kind, KINDS[kind]).api[method];
    if (!spec || (spec.internal && !internal)) throw new Error(`${address} has no public method ${method}`);
    if ((spec.who || spec.mutates || spec.inZone || spec.near || spec.self) && !p?.ready) throw new Error('join the office first');
    // Server roles (public/js/roles.js): one check for every method that needs one.
    if (spec.role && !atLeast(this.roleOf(p), spec.role)) throw new Error(`that needs the ${spec.role} role (you're ${p ? `a${/^[aeiou]/.test(this.roleOf(p)) ? 'n' : ''} ${this.roleOf(p)}` : 'an observer'})`);
    let target = null;
    if (spec.self) {
      const key = this.actorKey(p);
      if (key) { address = `${kind}:${key}`; name = key; } else target = this.guestStation(p, kind);
    }
    if (spec.atDesk && !this.deskOf(p)) throw new Error('walk up to a desk first (take_desk, or walk_to desk-N)');
    if (spec.inZone && zoneAt(p.x, p.y)?.id !== name) throw new Error(`walk to ${name} first`);
    if (spec.near) {
      // Same rule as the browser: walk up to it (its nearest edge) first.
      const f = FURNITURE.find((x) => x.id === name) || DESKS.find((x) => x.id === name) || this.uploaded(name);
      if (!f) throw new Error(`${address} isn't on the map`);
      const cx = Math.max(f.x, Math.min(p.x, f.x + (f.w || 1))), cy = Math.max(f.y, Math.min(p.y, f.y + (f.h || 1)));
      if (Math.hypot(cx - p.x, cy - p.y) > spec.near) throw new Error(`you're too far from the ${f.name || name}: walk_to ${name} first (within ${spec.near} tiles)`);
    }
    if (kind === 'inventory') return this.inventoryCall(p, method, args);
    if (kind === 'mod') return this.modCall(p, method, args);
    if (method === 'view' && this.mirror.has(address)) return this.mirror.get(address);
    const params = paramList(spec).map((_, i) => args[i]);
    while (params.length && params.at(-1) === undefined) params.pop();
    if (spec.ctx) params.length = paramList(spec).length;
    const all = [...(spec.who ? [this.who(p)] : []), ...params, ...(spec.ctx ? [{ all: this.bookings, presence: this.presence() }] : [])];
    if (target) return structuredClone(await target.invoke(method, structuredClone(all)));
    return this.ref(address)[method](...all);
  }

  // The desk whose chair p stands at, if any.
  deskOf(p) { return p ? deskAt(p.x, p.y)?.id || null : null; }

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
      walk: (key, target) => this.walk(key, target),
      bookings: () => this.bookings,
      enforce: () => this.enforce(),
      // What the World itself kept before an object took it over.
      legacy: (what) => (what === 'world:waves' ? this.waves : null),
    };
  }

  // Who's in the office, as entities see them.
  presence() {
    return [...this.peers.values()].filter((q) => q.ready && q.kind !== 'freeq').map((q) => this.who(q));
  }

  who(p) {
    return { id: p.id, key: this.ownerKey(p), name: p.name, handle: p.handle, did: p.did, kind: p.kind, zone: zoneAt(p.x, p.y)?.id || null, x: p.x, y: p.y, role: this.roleOf(p) };
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
  //   { op: 'log', entries: [{ level, source, msg, data?, ts }] }   server logs from entity objects
  apply(effects) {
    for (const e of effects || []) {
      if (e.op === 'mirror') this.mirrored(e);
      else if (e.op === 'send') { const q = this.peers.get(e.to); if (q?.ready) this.sendTo(q, e.msg); }
      else if (e.op === 'broadcast') this.broadcast(e.msg, this.peers.get(e.except) || null);
      else if (e.op === 'showOut') { const q = this.peers.get(e.to), room = roomById(e.room); if (q?.ready && room) this.showOut(q, room, e.text); }
      else if (e.op === 'log') for (const entry of (e.entries || []).slice(0, 200)) this.logs.add({ ...entry, source: entry.source || e.from || 'entity' });
    }
    return true;
  }

  mirrored({ from, value, push, max, except, quiet, feed }) {
    const kind = parse(from).kind;
    if (feed) {
      // A plugin object's feed (the whiteboard's strokes): kept with what it shows.
      const v = this.mirror.get(from) || { display: null, via: null };
      if (feed.clear) v.feed = [];
      else {
        (v.feed ||= []).push(feed.push);
        while (v.feed.length > max) v.feed.shift();
      }
      this.mirror.set(from, v);
    } else if (push !== undefined) {
      const list = this.mirror.get(from) || [];
      list.push(push);
      while (list.length > max) list.shift();
      this.mirror.set(from, list);
    } else if ((kind === 'plugin' || kind === 'uobj') && value && !('feed' in value) && this.mirror.get(from)?.feed) {
      // What it shows changed; its feed didn't.
      this.mirror.set(from, { ...value, feed: this.mirror.get(from).feed });
    } else this.mirror.set(from, value);
    this.pushed?.add(from);
    this.onMirror(from);
    if (quiet) return;
    if (feed) {
      const { name } = parse(from), but = this.peers.get(except) || null;
      // The whiteboard keeps its own message; other feeds go out with the object.
      if (name === 'whiteboard' && kind === 'plugin') return this.broadcast(feed.clear ? { t: 'wb', op: 'clear' } : { t: 'wb', op: 'stroke', stroke: feed.push }, but);
      return this.broadcast({ t: 'obj', id: name, feed }, but);
    }
    switch (kind) {
      case 'desk': return this.broadcast({ t: 'desks', desks: this.desks });
      case 'plugin': {
        const { name } = parse(from);
        this.broadcast({ t: 'obj', id: name, display: value?.display || null });
        // The objects browsers draw themselves also have their own messages.
        // A whole feed (the whiteboard took over the old board's strokes).
        if (name === 'whiteboard' && value?.feed) this.broadcast({ t: 'wb', op: 'set', strokes: value.feed });
        if (name === 'noticeboard') this.broadcast({ t: 'notes', notes: this.notes });
        else if (name === 'coffee' || name === 'reception') this.broadcast({ t: 'counters', counters: this.counters });
        else if (name === 'arcade') this.broadcast({ t: 'scores', scores: this.scores.slice(0, 10) });
        else if (POMOS.some((f) => f.id === name)) this.broadcastPomo();
        else if (ROOMS.some((r) => panelOf(r.id) === name)) this.broadcast({ t: 'bookings', bookings: this.bookings });
        return;
      }
      case 'uobj': {
        const id = parse(from).name;
        // A whole feed (refreshed after a wake): an uploaded whiteboard's strokes.
        return this.broadcast({ t: 'obj', id, display: value?.display || null, ...(Array.isArray(value?.feed) ? { feed: { set: value.feed } } : {}) });
      }
      case 'gallery': return this.broadcast({ t: 'gallery', items: this.gallery });
      case 'floor': return this.broadcast({ t: 'floor', items: this.floor });
      case 'wing': return this.layout(value);
      case 'roles': return this.rolesChanged();
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
      // How each plugin object last ran (dynamic-worker, worker-thread, offline).
      objects: Object.fromEntries(PLUGIN_OBJECTS.map((f) => [f.id, this.mirror.get(`plugin:${f.id}`)?.via || 'unused'])),
      // Uploaded objects and how each last ran (dynamic-worker, worker-thread, offline).
      uploads: Object.fromEntries(this.gallery.map((f) => [f.id, this.mirror.get(`uobj:${f.id}`)?.via || 'unused'])),
    };
  }

  publicPeer(p) {
    return {
      id: p.id, name: p.name, handle: p.handle, did: p.did, kind: p.kind,
      actor: p.actor, x: p.x, y: p.y, dir: p.dir, moving: p.moving,
      status: p.status, note: p.note, emote: p.emote, audio: p.audio,
      video: p.video, screen: p.screen, pc: p.pc, cup: p.cup, joinedAt: p.joinedAt,
      role: this.roleOf(p), ...(this.mutedUntil(p) ? { muted: this.mutedUntil(p) } : {}),
    };
  }

  // Transport-neutral entry points: open() a peer for a socket, feed it
  // message() and close(). connect() wires them to a Node `ws` socket; the
  // Cloudflare Durable Object calls them from its hibernation handlers.
  // `did` is only ever a DID the visitor proved via OAuth (see auth.js).
  // `operator`: an MCP session with the operator token (MCP_TOKEN), an owner.
  // A person with the office open in several tabs is one peer with several
  // sockets (see Tabs): the second tab's hello joins it to the first.
  open(ws, { did = null, restored = null, operator = false, tab } = {}) {
    const p = {
      id: crypto.randomUUID().slice(0, 8), ready: false, name: 'guest', handle: null, did: null, authDid: did, operator: !!operator,
      kind: 'human', actor: null, x: SPAWN.x, y: SPAWN.y, dir: 0, moving: false,
      status: 'available', note: '', emote: null, audio: false, video: false, screen: false, cup: false,
      chatTimes: [], joinedAt: this.now(),
      ...restored, ws: new Tabs(ws, tab),
    };
    this.peers.set(p.id, p);
    return p;
  }

  // `ws`: the tab it came from, when the peer may have several.
  message(p, raw, ws = null) {
    p = p.joined || p;
    let msg;
    try { msg = JSON.parse(raw); } catch { return Promise.resolve(); }
    if (!msg || typeof msg.t !== 'string') return Promise.resolve();
    const tab = ws && p.ws.idOf(ws);
    if (tab) {
      p.ws.seen.set(tab, Date.now());
      // The tab using mic, camera or calls is the one WebRTC talks to.
      if (msg.t === 'audio' || msg.t === 'av' || msg.t === 'rtc' || msg.t === 'fq-call') p.ws.voice = tab;
    }
    return Promise.resolve(this.handle(p, msg, ws)).catch((e) => this.sendTo(p, { t: 'error', message: e.message }));
  }

  // A tab closed: the person leaves when it was their last one.
  closeTab(p, ws) {
    p = p.joined || p;
    if (!p.ws.drop(ws)) this.leave(p);
  }

  // The parts of a peer worth keeping across a Durable Object hibernation.
  snapshot(p) {
    const { ws, joined, cupTimer, emoteTimer, station, stationTimer, heldMove, unlocking, ...rest } = p;
    return rest;
  }

  connect(ws, { did = null, operator = false } = {}) {
    const p = this.open(ws, { did, operator });
    ws.on('message', (raw) => this.message(p, raw, ws));
    ws.on('close', () => this.closeTab(p, ws));
    ws.on('error', () => this.closeTab(p, ws));
    return p;
  }

  sendTo(p, msg) {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  // Calls and WebRTC: only the tab using them (see Tabs).
  sendVoice(p, msg) {
    if (p.ws.readyState === 1) p.ws.sendVoice(JSON.stringify(msg));
  }

  // `tabs`: also to the sender's other tabs (everyone but the tab `except` is
  // the one it came from), for what that tab already shows itself.
  broadcast(msg, except = null, { tabs = false, from = null } = {}) {
    const s = JSON.stringify(msg);
    for (const q of this.peers.values()) {
      if (!q.ready || q.ws.readyState !== 1) continue;
      if (q !== except) q.ws.send(s);
      else if (tabs && from) q.ws.send(s, { except: from });
    }
  }

  leave(p) {
    if (!this.peers.has(p.id)) return;
    this.peers.delete(p.id);
    if (p.ready) this.broadcast({ t: 'leave', id: p.id });
    if (p.kind !== 'freeq') { this.freeq?.leave(p); this.freeq?.presence(); }
    if (!p.ready || p.kind === 'freeq') return;
    const key = this.actorKey(p);
    if (key) this.bg(this.ref(`actor:${key}`).depart(this.spotOf(p)));
    else if (p.items?.length) this.bg(this.leaveBehind(p));
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
    p.x = x; p.y = y; p.moving = false;
    this.broadcast({ t: 'move', id: p.id, x, y, dir: p.dir, moving: false });
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
  // `replyTo` is { msgid, name?, text? } when the line answers another one.
  remoteChat({ zoneId, channel, peer, name, text, ts = null, msgid = null, replyTo = null, backfill = false }) {
    const msg = { t: 'chat', id: peer?.id || `freeq:${name}`, name: clip(name, 32), text: clip(text, 500), ts: ts || this.now(), scope: channel, freeq: true, ...(msgid ? { msgid } : {}), ...(replyTo ? { replyTo } : {}), ...(backfill ? { backfill: true } : {}) };
    const tags = mentionTags(msg.text);
    this.remember(zoneId, { name: msg.name, text: msg.text, ts: msg.ts, freeq: true, ...(msgid ? { msgid } : {}), ...(replyTo ? { replyTo } : {}) });
    for (const q of this.peers.values()) {
      if (!q.ready || q.kind === 'freeq') continue;
      const hit = zoneAt(q.x, q.y)?.id === zoneId;
      const ment = mentionsPeer(tags, q);
      if (hit || ment) this.sendTo(q, { ...msg, mention: ment, far: !hit && ment });
    }
  }

  // freeq gave an office line in a bridged area its msgid (seen in the echo):
  // everyone there can now answer it as a freeq reply.
  chatMsgid(zoneId, key, msgid) {
    if (map.ZONES.some((z) => z.id === zoneId && z.channel)) this.bg(this.ref(`chan:${zoneId}`).tag({ key, msgid }));
    for (const q of this.peers.values()) {
      if (q.ready && q.kind !== 'freeq' && zoneAt(q.x, q.y)?.id === zoneId) this.sendTo(q, { t: 'chat-id', key, msgid });
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

  async handle(p, m, ws = null) {
    await this.ready;
    if (m.t === 'hello') return this.hello(p, m, ws);
    if (!p.ready) return;
    switch (m.t) {
      case 'move': return this.move(p, m, ws);
      case 'chat': return this.chat(p, m);
      case 'status': return this.setStatus(p, m);
      case 'emote': return this.emote(p, m);
      case 'desk': return this.desk(p, m);
      case 'pomo': return this.pomodoro(p, m);
      case 'wb': return this.whiteboard(p, m);
      case 'note': return this.noticeboard(p, m);
      case 'coffee': return this.coffee(p, m);
      case 'score': return this.score(p, m);
      case 'use': return this.use(p, m);
      case 'gallery': return this.galleryOp(p, m);
      case 'inv': return this.inv(p, m);
      case 'ws': return this.workstation(p, m);
      case 'wave': return this.wave(p, m);
      case 'audio': p.audio = !!m.on && !this.mutedUntil(p); return this.broadcast({ t: 'peer', id: p.id, audio: p.audio });
      case 'mod': return this.modOp(p, m);
      case 'av': return this.av(p, m);
      case 'book': return this.book(p, m);
      case 'chan': return this.chan(p, m);
      case 'rtc': return this.rtc(p, m);
      // Voice in a freeq-bridged channel room is the channel's freeq call (freeq.js).
      case 'fq-call': return void this.freeq?.onCallOp(p, m).catch(() => {});
      case 'ping': return this.sendTo(p, { t: 'pong', ts: m.ts });
    }
  }

  async hello(p, m, ws = null) {
    if (p.ready || p.greeting) return;
    p.greeting = true;
    p.kind = m.kind === 'agent' ? 'agent' : 'human';
    p.name = clip(m.name, 32) || (p.kind === 'agent' ? 'agent' : 'guest');
    let arrival = null;
    if (p.authDid) {
      // Identity comes from the signed-in DID only, never from the hello
      // message, so nobody can walk in wearing someone else's handle.
      p.did = p.authDid;
    } else {
      if (m.handle) this.sendTo(p, { t: 'error', message: `sign in to use @${clip(m.handle, 253)}; walking in as a guest` });
      // A guest's browser keeps a random key of its own, so its reconnects,
      // refreshes and other tabs find the guest already standing here
      // (see tabHost) instead of walking in a second one.
      if (typeof m.guest === 'string' && /^[\w-]{16,64}$/.test(m.guest)) p.guestKey = m.guest;
    }
    if (this.roleOf(p) === 'banned') {
      p.greeting = false;
      return this.sendOff(p, 'You were banned from this office.');
    }
    // Already in from another tab or device: this tab joins that avatar.
    if (await this.joinTab(p, ws)) return;
    // Their actor entity has their character, last status and notes kept for them.
    const key = this.actorKey(p);
    if (key) arrival = await this.ref(`actor:${key}`).arrive().catch((e) => ({ error: e.message }));
    // Another tab of theirs got in while we waited: join it, and count one arrival.
    if (this.tabHost(p)) {
      this.bg(this.ref(`actor:${key}`).depart());
      return this.joinTab(p, ws);
    }
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
    // A guest's things last for the visit (a reconnect keeps them, leaving puts
    // them on the floor: see leaveBehind); everyone else's are on their actor.
    if (!key) p.items ||= [];
    // Back where they were last time (signed-in people and agents), else
    // at the door; either way not on top of whoever else is standing there.
    // (A refresh opens the new tab before the old one closes, so it joins the
    // avatar still standing there instead: see joinTab.)
    if (p.x === SPAWN.x && p.y === SPAWN.y) {
      const kept = arrival?.at;
      const back = this.canStand(kept, p) ? kept : SPAWN;
      const at = openSpot(back.x, back.y, [...this.peers.values()].filter((q) => q.ready && q !== p));
      p.x = at.x; p.y = at.y;
      if (back !== SPAWN) p.dir = (+back.dir || 0) | 0;
    }
    p.ready = true;
    p.shownRole = this.roleOf(p);
    p.keyring = holdsKey(key ? arrival?.items : p.items);
    this.sendTo(p, this.welcome(p, key ? arrival?.items || [] : p.items));
    for (const msg of arrival?.inbox || []) this.sendTo(p, msg);
    this.broadcast({ t: 'join', peer: this.publicPeer(p) }, p);
    this.touchDesk(p);
    const zone = zoneAt(p.x, p.y);
    if (zone) this.publish(`zone:${zone.id}`, { type: 'enter', who: this.who(p) });
    this.publish('office', { type: 'join', who: this.who(p) });
    this.freeq?.presence();
  }

  // Everything a tab needs to draw the office, as `p`.
  welcome(p, items) {
    return {
      t: 'welcome', id: p.id, now: this.now(), you: this.publicPeer(p),
      peers: [...this.peers.values()].filter((q) => q.ready && q !== p).map((q) => this.publicPeer(q)),
      desks: this.desks, strokes: this.strokes, notes: this.notes, pomo: this.pomoState(),
      scores: this.scores.slice(0, 10), counters: this.counters, shouts: this.shouts.slice(-20),
      bookings: this.bookings, freeq: this.freeq?.state() || {}, objects: this.objects(), feeds: this.feeds(), wing: this.wing,
      gallery: this.gallery,
      floor: this.floor, items, keeps: !!this.actorKey(p),
    };
  }

  // One avatar per identity. The avatar a signed-in person already has here
  // (another tab, a phone, a refresh whose old tab hasn't closed yet). An
  // agent working as them is someone else to look at, so it gets its own.
  tabHost(p) {
    const same = p.did ? (q) => q.did === p.did : p.guestKey ? (q) => !q.did && q.guestKey === p.guestKey : null;
    if (!same) return null;
    return [...this.peers.values()].find((q) => q !== p && q.ready && same(q) && q.kind === p.kind) || null;
  }

  // A new tab joins the avatar they already have: its socket moves over, it
  // gets the office as that avatar sees it, and from then on it's one more
  // window onto the same person (moves, chat and the rest reach every tab).
  async joinTab(p, ws) {
    const host = this.tabHost(p);
    if (!host) return false;
    const sock = ws || [...p.ws.socks.values()][0];
    this.peers.delete(p.id);
    p.joined = host;
    host.ws.add(sock, p.ws.idOf(sock) || undefined);
    const key = this.actorKey(host);
    const items = key ? await this.ref(`actor:${key}`).inventory().catch(() => []) : host.items;
    host.ws.send(JSON.stringify(this.welcome(host, items)), { only: sock });
    // A rejoin while another tab or MCP session of theirs is still in would
    // otherwise keep the look from when that one walked in.
    if (key && host.did) this.bg(this.refreshLook(host));
    return true;
  }

  // Re-read their character (from their PDS if it had no sprite or verified
  // handle) and, if it changed, redraw them for everyone.
  async refreshLook(p) {
    const done = !!(p.actor?.sprite && p.handle);
    const a = await this.ref(`actor:${p.did}`).profile({ fresh: !done }).catch(() => null);
    if (!a || !this.peers.has(p.id)) return;
    const actor = { sprite: a.sprite, stats: a.stats, displayName: a.displayName, description: a.description };
    if (a.handle === p.handle && JSON.stringify(actor) === JSON.stringify(p.actor)) return;
    p.handle = a.handle;
    p.actor = actor;
    this.broadcast({ t: 'leave', id: p.id });
    this.broadcast({ t: 'join', peer: this.publicPeer(p) });
  }

  move(p, m, ws = null, keyTried = false) {
    const x = num(m.x, 0, map.W, p.x), y = num(m.y, 0, map.H, p.y);
    if (isBlocked(Math.floor(x), Math.floor(y))) return;
    // Guard against teleport hacks beyond a generous per-message step.
    if (Math.hypot(x - p.x, y - p.y) > 6 && !m.teleport) return;
    // A booking keeps everyone but its holders out of the room, doorway
    // included, while it runs. Someone already in there can still walk out.
    const from = zoneAt(p.x, p.y), to = zoneAt(x, y);
    const shut = restrictedAt(this.bookings, x, y, p, this.now());
    if (shut && shut !== restrictedAt(this.bookings, p.x, p.y, p, this.now())) {
      // Carrying a skeleton key: the door opens as they walk up.
      if (p.keyring && !keyTried) return this.useKey(p, shut, m, ws);
      const b = activeBooking(this.bookings, shut.id, this.now());
      return this.sendTo(p, { t: 'bounce', x: p.x, y: p.y, room: shut.id, text: `🔒 ${shut.name} is restricted: booked by ${b.name} for “${b.title}” until ${stamp(b.end)}. Knock to be let in.` });
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
    const desk = this.deskOf(p);
    p.x = x; p.y = y; p.dir = num(m.dir, 0, 3, 0) | 0; p.moving = !!m.moving;
    if (!p.moving) this.keepSpot(p);
    this.broadcast({ t: 'move', id: p.id, x, y, dir: p.dir, moving: p.moving }, p, { tabs: true, from: ws });
    // Walking away from a desk switches its computer off, and ends a share to its monitor.
    if (desk && !this.deskOf(p) && (p.pc || (p.screen && !to?.av))) {
      const off = { pc: false, ...(p.screen && !to?.av ? { screen: false } : {}) };
      Object.assign(p, off);
      this.broadcast({ t: 'peer', id: p.id, ...off });
    }
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
    const muted = this.mutedUntil(p);
    if (muted) return this.sendTo(p, { t: 'error', message: `a moderator muted you until ${stamp(muted)}` });
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
      // Matched up with the msgid freeq gives the line (chatMsgid), so it can be answered.
      msg.key = crypto.randomUUID().slice(0, 12);
      // Answering a channel line threads it there too (the msgid it came with).
      const reply = typeof m.reply === 'string' && /^[\w.:+/=-]{1,128}$/.test(m.reply) ? m.reply : null;
      if (reply) msg.replyTo = { msgid: reply, ...this.freeq.line(reply) };
      this.freeq.relay(p, zone.id, msg.text, reply, msg.key).then((note) => {
        // The same note again within a minute (a guest chatting away) isn't news.
        if (note && (note !== p.freeqNote || this.now() - p.freeqNoteAt > 60000)) this.sendTo(p, { t: 'freeq-note', text: note, ok: false });
        if (note) { p.freeqNote = note; p.freeqNoteAt = this.now(); }
      });
    }
    if (zone?.channel) {
      // A bridged line's freeq msgid is filled in when it comes back (chatMsgid).
      this.remember(zone.id, { name: p.name, text: msg.text, ts: t, ...(msg.key ? { key: msg.key } : {}), ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) });
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

  // The pomodoro, notice board and coffee machine are WASM plugin objects:
  // their protocol messages become plugin actions, from anywhere in the den
  // (pomodoro) or the office (notes, coffee).
  async pomodoro(p, m) {
    const zone = zoneAt(p.x, p.y);
    const f = POMOS.find((x) => x.zone === zone?.id);
    if (!f) return;
    const mins = (v, d) => Math.max(1, Math.min(90, Math.floor(+v) || d));
    const action = m.action === 'stop' ? 'stop'
      : m.action === 'start' ? (m.focusMin || m.breakMin ? `start:${mins(m.focusMin, 25)}:${mins(m.breakMin, 5)}` : 'start') : null;
    if (action) await this.ref(`plugin:${f.id}`).interact(this.who(p), { action });
  }

  broadcastPomo() {
    this.broadcast({ t: 'pomo', pomo: this.pomoState(), counters: this.counters, now: this.now() });
  }

  // The whiteboard is a WASM plugin object too (plugins/wasm-whiteboard):
  // a stroke is its `stroke` action with the stroke as data, and goes on its
  // feed. perform, not interact: strokes come faster than its cooldown.
  // The boardroom's whiteboard, or (with `id`) an uploaded one: same strokes, its own board.
  async whiteboard(p, m) {
    const req = m.op === 'clear' ? { action: 'clear' } : m.op === 'stroke' ? { action: 'stroke', data: { points: m.points, color: m.color, size: m.size } } : null;
    if (!req) return;
    if (m.id != null) {
      const f = this.uploadOf(m, 'whiteboard');
      return f && this.ref(`uobj:${f.id}`).perform(this.who(p), cleanRequest(req));
    }
    await this.ref('plugin:whiteboard').perform(this.who(p), cleanRequest(req));
  }

  // The lobby's notice board, or (with `board`) an uploaded one.
  async noticeboard(p, m) {
    const req = m.op === 'add' ? { action: 'add', input: m.text } : m.op === 'remove' && /^[\w-]{1,16}$/.test(m.id || '') ? { action: `remove:${m.id}` } : null;
    if (!req) return;
    if (m.board != null) {
      const f = this.uploadOf(m, 'board');
      return f && this.ref(`uobj:${f.id}`).interact(this.who(p), cleanRequest(req));
    }
    await this.ref('plugin:noticeboard').interact(this.who(p), cleanRequest(req));
  }

  // The kitchen's machine, or (with `id`) an uploaded one you're standing at.
  async coffee(p, m = {}) {
    if (m.id != null) {
      const f = this.uploadOf(m, 'coffee');
      if (!f || distTo(f, p) > 3) return;
      this.holdCup(p);
      return this.ref(`uobj:${f.id}`).interact(this.who(p), { action: 'pour' });
    }
    this.holdCup(p);
    // Standing at the machine, you also walk off with the cup itself.
    const machine = FURNITURE.find((f) => f.id === 'coffee');
    await this.ref('plugin:coffee').interact(this.who(p), { action: machine && distTo(machine, p) <= 3 ? 'pour' : 'brew' });
    // Tell anyone nearby that a coffee chat is brewing.
    for (const q of this.peers.values()) {
      if (q !== p && q.ready && canHear(p, q)) this.sendTo(q, { t: 'toast', text: `☕ ${p.name} grabbed a coffee nearby. Coffee chat?` });
    }
  }

  // A finished game of Byte Snake (played in the browser): the leaderboard
  // is the arcade's WASM plugin.
  score(p, m) {
    const score = Math.floor(+m.score);
    if (!(score >= 1 && score <= 10000)) return;
    return this.ref('plugin:arcade').interact(this.who(p), { action: `score:${score}` });
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

  // The feeds of uploaded objects that keep one (an uploaded whiteboard's strokes).
  feeds() {
    const out = {};
    for (const f of this.gallery) { const v = this.mirror.get(`uobj:${f.id}`); if (v?.feed?.length) out[f.id] = v.feed; }
    return out;
  }

  // An uploaded object of one of the office's own kinds (look), standing in a
  // room, that a message from the browser names: its entity, or null.
  // (No id: the office's own one.)
  uploadOf(m, look) {
    const f = typeof m.id === 'string' || typeof m.board === 'string' ? this.uploaded(m.board ?? m.id) : null;
    return f && f.look === look ? f : null;
  }

  // Objects people uploaded (gallery:main), as map objects.
  get gallery() { return this.mirror.get('gallery:main') || []; }
  uploaded(id) {
    const i = this.gallery.find((x) => x.id === id);
    // (A carried one is in someone's inventory, not on the map.)
    return i && !i.carried ? { ...i, w: 1, h: 1, plugin: 'upload' } : null;
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
      // (A carried upload, a key or an object, keeps the few bytes that say which upload it is.)
      const give = (change.give || []).map((i) => cleanItem(i, { from: change.from, now: this.now() })).filter(Boolean).map(({ data, ...i }) => (data?.upload ? { ...i, data } : i));
      r = applyChange(p.items || [], { take: change.take || [], give }, { slots: GUEST_SLOTS });
      if (r.items) p.items = r.items;
    }
    if (r.error) return r;
    // Whether they carry a skeleton key, on every connection of theirs (an
    // MCP session and a browser tab share one actor's things). Without one,
    // any room a key let them into shuts again: checked on every change, not
    // only when this connection saw the key go, so nothing stale keeps it open.
    p.keyring = holdsKey(r.items);
    if (key) for (const q of this.peers.values()) if (q !== p && this.actorKey(q) === key) q.keyring = p.keyring;
    if (!p.keyring) await this.relock(p);
    if (key) this.deliver(key, { t: 'inv', items: r.items });
    else this.sendTo(p, { t: 'inv', items: r.items });
    return r;
  }

  // The inventory as the generated tools and the browser see it (INVENTORY.api).
  // Each answers { items, … } or { error }.
  async inventoryCall(p, method, [a, b, c, d] = []) {
    if (method === 'view') return this.inventory(p);
    if (method === 'use') return this.useItem(p, a);
    if (method === 'place') return this.placeItem(p, a, b, c, d);
    if (method === 'give') return this.giveItem(p, a, b, c);
    if (method === 'pickup') return this.pickUp(p, a);
    if (method === 'destroy') return this.destroyItem(p, a, b);
    throw new Error(`inventory has no method ${method}`);
  }

  // { t: 'inv', op: 'use' | 'place' | 'give' | 'pickup' | 'destroy', id, x?, y?, to?, qty? }
  async inv(p, m) {
    const op = ['use', 'place', 'give', 'pickup', 'destroy'].includes(m.op) ? m.op : null;
    // Never silent: a browser newer than the server would otherwise click into nothing.
    if (!op) return this.sendTo(p, { t: 'error', message: `this office can't ${clip(String(m.op ?? 'do that'), 20)} things yet (reload, or the server needs a deploy)` });
    const r = await this.inventoryCall(p, op, op === 'give' ? [m.id, m.to, m.qty] : op === 'place' ? [m.id, m.x, m.y, m.qty] : op === 'destroy' ? [m.id, m.qty] : [m.id]);
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

  // Putting something down on a tile in reach (items.js placeTiles has the
  // rules, the same ones the browser draws). Without x/y: at their feet.
  async placeItem(p, id, x, y, qty) {
    const s = (await this.inventory(p)).find((i) => i.id === id);
    if (!s) return { error: 'you don\'t have that' };
    const opts = { floor: this.occupied, bookings: this.bookings, now: this.now() };
    let tile;
    if (x == null && y == null) {
      tile = nearestPlace(p, opts);
      if (!tile) return { error: 'there\'s no free spot around you' };
    } else {
      const why = placeError(p, +x, +y, opts);
      if (why) return { error: why };
      tile = { x: Math.floor(x), y: Math.floor(y) };
    }
    // An object (an upload that isn't just an item) stands up in the room as
    // itself, and is whoever put it there's.
    const obj = s.data?.upload && this.gallery.find((i) => i.id === s.data.upload && i.carried && i.look !== CARRIED);
    if (obj) return this.standUp(p, s, obj, tile);
    const n = Math.max(1, Math.min(s.qty, Math.floor(+qty) || s.qty));
    const r = await this.invApply(p, { take: [{ id, qty: n }] });
    if (r.error) return r;
    const at = { x: tile.x + 0.5, y: tile.y + 0.5 };
    // Put down, it's nobody's: the floor doesn't know who left it.
    const floor = await this.ref('floor:main').place({ item: unowned({ ...s, qty: n }), ...at });
    this.act(p, `puts down ${label({ ...s, qty: n })}`);
    return { items: r.items, floor, ...at };
  }

  async standUp(p, s, obj, tile) {
    const r = await this.invApply(p, { take: [{ id: s.id, qty: 1 }] });
    if (r.error) return r;
    const owner = { did: p.did || null, handle: p.handle || null, name: p.name, ...(p.did ? {} : { guest: p.id }) };
    const put = await this.ref('gallery:main').put(obj.id, tile.x, tile.y, owner).catch((e) => ({ error: e.message }));
    if (put.error) { const back = await this.invApply(p, { give: r.taken }); return { error: put.error, items: back.items }; }
    this.act(p, `sets up ${s.emoji} ${s.name}`);
    return { items: r.items, object: obj.id, x: tile.x + 0.5, y: tile.y + 0.5 };
  }

  // Whose an object standing in a room is: whoever put it there (a moderator may too).
  owns(p, obj) {
    if (can(this.roleOf(p), 'uploads.remove')) return true;
    return obj.owner?.did ? obj.owner.did === p.did : !!obj.owner?.guest && obj.owner.guest === p.id;
  }

  // Picking up an object standing in a room: it goes into their inventory as one item.
  async pickUpObject(p, obj) {
    if (!this.owns(p, obj)) return { error: `${obj.name} is ${obj.owner?.handle ? `@${obj.owner.handle}` : obj.owner?.name || 'someone else'}'s: only they can pick it up` };
    if (Math.hypot(obj.x + 0.5 - p.x, obj.y + 0.5 - p.y) > PICKUP_RANGE + 0.5) return { error: `walk over to the ${obj.name} first (within ${PICKUP_RANGE} tiles)` };
    const was = { x: obj.x, y: obj.y, owner: obj.owner };
    const got = await this.ref('gallery:main').carry(obj.id);
    if (!got) return { error: 'that isn\'t there any more' };
    const r = await this.invApply(p, { give: [asItem(got)] });
    if (r.error) { await this.ref('gallery:main').put(obj.id, was.x, was.y, was.owner).catch(() => {}); return r; }
    this.act(p, `picks up ${got.emoji} ${got.name}`);
    return { items: r.items };
  }

  // A guest has nowhere to keep their things once they're gone, so they're
  // left on the floor where they stood (a stack per free tile, nearest
  // first), for them or anyone else to pick up. Nothing just vanishes.
  async leaveBehind(p) {
    const items = p.items;
    p.items = [];
    const floor = [...this.floor];
    for (const s of items) {
      const tile = nearestPlace(p, { floor, bookings: this.bookings, now: this.now() }) || { x: Math.floor(p.x), y: Math.floor(p.y) };
      const at = { x: tile.x + 0.5, y: tile.y + 0.5 };
      floor.push(at);
      await this.ref('floor:main').place({ item: unowned(s), ...at });
    }
    const line = { t: 'chat', id: p.id, name: p.name, text: `left ${items.map(label).join(', ')} behind`, ts: this.now(), scope: 'nearby', action: true };
    for (const q of this.peers.values()) if (q.ready && canHear(p, q)) this.sendTo(q, line);
  }

  // Gone for good: taken out of their hands and not put anywhere.
  async destroyItem(p, id, qty) {
    const s = (await this.inventory(p)).find((i) => i.id === id);
    if (!s) return { error: 'you don\'t have that' };
    const n = Math.max(1, Math.min(s.qty, Math.floor(+qty) || s.qty));
    const r = await this.invApply(p, { take: [{ id, qty: n }] });
    if (r.error) return r;
    // A carried upload (a Skeleton Key) is the item: throwing it away removes it.
    if (s.data?.upload && !r.items.some((i) => i.data?.upload === s.data.upload)) await this.ref('gallery:main').discard(s.data.upload).catch(() => {});
    this.act(p, `throws away ${label({ ...s, qty: n })}`);
    return { items: r.items };
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
    // Handed over, it's theirs: nothing on it points back at the giver.
    const got = await this.invApply(q, { give: r.taken.map(({ id: _, ...i }) => unowned(i)) });
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
    const obj = this.gallery.find((i) => i.id === id && placed(i));
    if (obj) return this.pickUpObject(p, obj);
    const e = this.floor.find((x) => x.id === id);
    if (!e) return { error: 'that isn\'t there any more' };
    if (Math.hypot(e.x - p.x, e.y - p.y) > PICKUP_RANGE) return { error: `walk over to the ${e.item.name} first (within ${PICKUP_RANGE} tiles)` };
    const got = await this.ref('floor:main').remove(id);
    if (!got) return { error: 'someone got there first' };
    const r = await this.invApply(p, { give: [got.item] });
    if (r.error) {
      await this.ref('floor:main').place({ item: got.item, x: got.x, y: got.y });
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
    // The reception desk counts it for its sign (an office event: people can't send it).
    this.bg(this.ref('plugin:reception').act(this.who(p), 'wave', null, { type: 'wave', data: { kind: m.kind === 'knock' ? 'knock' : 'wave' } }));
    this.sendTo(q, { t: 'wave', from: p.id, name: p.name, kind: m.kind === 'knock' ? 'knock' : 'wave' });
    this.broadcast({ t: 'peer', id: p.id, emote: 'wave' });
  }

  rtc(p, m) {
    const q = this.peers.get(m.to);
    if (!q || !q.ready) return;
    this.sendVoice(q, { t: 'rtc', from: p.id, data: m.data });
  }

  // ---- A/V rooms ----------------------------------------------------------
  // Camera and screen share flags. The media itself is peer to peer; these
  // just let everyone draw who's on camera. Only meaningful in an A/V room.
  av(p, m) {
    // Cameras belong to A/V rooms and channel rooms' freeq calls; a screen can
    // also go up on your desk monitor.
    const z = zoneAt(p.x, p.y);
    const ok = !!(z?.av || z?.channel);
    p.video = ok && !!m.video;
    p.screen = (ok || !!this.deskOf(p)) && !!m.screen;
    this.broadcast({ t: 'peer', id: p.id, video: p.video, screen: p.screen });
  }

  // ---- meeting room bookings: each room's door panel keeps them ----------
  // The panels are a WASM plugin (plugins/wasm-rooms): changes go to the
  // room's panel as a `book` event, which only the office can send, with
  // what only the office knows (how many the owner has in the other rooms,
  // who's being let in). The office keeps the door (enforce, move).
  // { t: 'book', op: 'create' | 'cancel' | 'extend' | 'end' | 'update' | 'admit', ref? }
  // Replies { t: 'booked', ref, booking } or { t: 'error', ref, message }.
  async book(p, m) {
    const ref = typeof m.ref === 'string' || typeof m.ref === 'number' ? m.ref : undefined;
    const fail = (message) => this.sendTo(p, { t: 'error', message, ref });
    if (m.op === 'create' && !p.did && p.kind !== 'agent') return fail('sign in to book a room');
    const room = m.op === 'create' ? roomById(m.room)?.id : this.bookings.find((b) => b.id === m.id)?.room;
    if (!room) return fail(m.op === 'create' ? 'no such room' : 'no such booking');
    const now = this.now(), who = this.who(p);
    // Times are numbers by the time they reach the plugin ("HH:MM" is today here).
    const time = (v) => (v === undefined || v === null || v === 'now' ? v : Number.isFinite(toTime(v, now)) ? toTime(v, now) : 'not a time');
    const to = m.op === 'admit' ? this.peers.get(m.to) : null;
    const data = {
      op: String(m.op || ''), id: m.id, title: m.title, start: time(m.start), end: time(m.end), minutes: m.minutes,
      invitees: m.invitees, lock: m.lock, autoRelease: m.autoRelease,
      owned: this.bookings.filter((b) => b.room !== room && b.owner === who.key && b.end > now).length,
      to: to?.ready ? this.who(to) : null,
    };
    const r = await this.ref(`plugin:${panelOf(room)}`).act(who, 'book', null, { type: 'book', zone: room, data }).catch((e) => ({ toast: e.message }));
    const reply = r?.reply || { error: r?.toast || 'the room\'s panel didn\'t answer' };
    if (reply.error) return fail(reply.error);
    this.sendTo(p, { t: 'booked', ref, booking: reply.booking });
  }

  // Someone carrying a skeleton key walked up to a booked room. The key is
  // an upload (look `item`, with the unlock permission): its plugin is asked
  // to `open:<room>` for them, which goes through the room's panel like any
  // unlock, then the move goes through. Moves that come in meanwhile wait;
  // the last one is made.
  async useKey(p, room, m, ws) {
    p.heldMove = { m, ws };
    if (p.unlocking) return;
    p.unlocking = room.id;
    const error = await this.turnKey(p, room).catch((e) => e.message);
    const held = p.heldMove;
    p.unlocking = null; p.heldMove = null;
    if (!this.peers.has(p.id) || !held) return;
    if (error) return this.sendTo(p, { t: 'bounce', x: p.x, y: p.y, room: room.id, text: `🗝️ The key won't turn: ${error}` });
    return this.move(p, held.m, held.ws, true);
  }

  // Their skeleton key left their hands (put down, handed on, thrown away):
  // the rooms it let them into shut to them again, and the panels' turns
  // show them out of one they're standing in (enforce).
  async relock(p) {
    const who = this.who(p);
    const rooms = [...new Set(this.bookings.filter((b) => b.keyed?.includes(who.key)).map((b) => b.room))];
    await Promise.all(rooms.map((r) => this.ref(`plugin:${panelOf(r)}`).act(who, 'relock', null, { type: 'relock', zone: r }).catch(() => {})));
  }

  // Null once they're let in, else why not.
  async turnKey(p, room) {
    const keys = (await this.inventory(p)).filter((s) => s.kind === SKELETON_KEY);
    const key = keys.map((s) => this.gallery.find((i) => i.id === s.data?.upload && i.carried && i.permissions?.includes('unlock'))).find(Boolean);
    const gone = 'it doesn\'t fit any lock any more (its upload was removed)';
    if (!key) return gone;
    const r = await this.ref(`uobj:${key.id}`).act(this.who(p), `open:${room.id}`).catch(() => null);
    if (!r) return gone;
    return r?.unlock ? null : r?.toast || 'nothing happened';
  }

  // The panels keep their own alarms; this nudges them all now (tests, catch-up).
  tickRooms() {
    return Promise.all(ROOMS.map((r) => this.ref(`plugin:${panelOf(r.id)}`).act(null, 'tick')));
  }

  // A booked room is for its meeting only: anyone else inside (there when
  // it started, or in by any other route) is shown out. Moves are refused at
  // the door (move); the panels call this after every turn.
  enforce() {
    const now = this.now(), list = this.bookings;
    for (const q of this.peers.values()) {
      if (!q.ready || q.kind === 'freeq') continue;
      const room = restrictedAt(list, q.x, q.y, this.who(q), now);
      if (!room) continue;
      const b = activeBooking(list, room.id, now);
      this.showOut(q, room, `🔒 ${room.name} is booked for “${b.title}” (${b.name}) until ${stamp(b.end)}, so you've been shown out. Knock to be let in.`);
    }
  }

  // ---- server roles and moderation (public/js/roles.js, MOD) ---------------
  // Someone's role, from who they proved they are: the roles:main directory
  // as mirrored, on top of the env owners and admins. Null p: an observer.
  roleOf(p) {
    if (!p) return 'observer';
    return effectiveRole({ did: p.did || p.authDid, kind: p.kind, operator: p.operator }, this.mirror.get('roles:main') || {}, this.roleEnv);
  }

  // The same for an MCP session that may not have joined: { did, operator }.
  roleFor({ did = null, operator = false } = {}) {
    return effectiveRole({ did, kind: 'agent', operator, mcp: true }, this.mirror.get('roles:main') || {}, this.roleEnv);
  }

  // Whom roles changed for listen here (the MCP hub re-lists its tools).
  onRoles(fn) { this.roleListeners.add(fn); return () => this.roleListeners.delete(fn); }

  // The directory changed: everyone sees the new badges, the banned leave.
  rolesChanged() {
    for (const q of [...this.peers.values()]) {
      if (!q.ready || q.kind === 'freeq') continue;
      const role = this.roleOf(q);
      if (role === q.shownRole) continue;
      q.shownRole = role;
      if (role === 'banned') this.sendOff(q, 'You were banned from this office.');
      else this.broadcast({ t: 'peer', id: q.id, role });
    }
    for (const fn of this.roleListeners) { try { fn(); } catch (e) { console.error('roles listener', e.message); } }
  }

  mutedUntil(p) {
    const t = Math.max(p.mutedUntil || 0, this.mutes.get(this.ownerKey(p)) || 0);
    return t > this.now() ? t : 0;
  }

  // Out of the office, and told why. Their client stays closed.
  sendOff(q, text) {
    this.sendTo(q, { t: 'kicked', text });
    try { q.ws.close(KICKED, 'sent out'); } catch { /* already gone */ }
    this.leave(q);
  }

  // Who a moderator means, and whether they may act on them.
  target(p, to, verb) {
    const q = this.findPeer(to);
    if (!q) return { error: `nobody called ${clip(to, 40)} is here` };
    if (q === p) return { error: `you can't ${verb} yourself` };
    const mine = this.roleOf(p), theirs = this.roleOf(q);
    if (mine !== 'owner' && rank(theirs) >= rank(mine)) return { error: `you can't ${verb} ${q.name}: they're a${/^[aeiou]/.test(theirs) ? 'n' : ''} ${roleLabel(theirs).toLowerCase()}` };
    return { q };
  }

  // MOD.api, after Office.call checked the role.
  async modCall(p, method, [a, b, c] = []) {
    if (method === 'people') {
      return {
        online: [...this.peers.values()].filter((q) => q.ready).map((q) => ({ id: q.id, name: q.name, handle: q.handle || null, did: q.did || null, kind: q.kind, role: this.roleOf(q), ...(this.mutedUntil(q) ? { muted: this.mutedUntil(q) } : {}), zone: zoneAt(q.x, q.y)?.id || null })),
        granted: this.mirror.get('roles:main') || {},
      };
    }
    if (method === 'removeItem') {
      const got = await this.ref('floor:main').remove(clip(a, 16));
      if (got?.item.data?.upload) await this.ref('gallery:main').discard(got.item.data.upload).catch(() => {});
      return got ? { ok: true } : { error: 'that isn\'t on the floor any more' };
    }
    if (method === 'grant') {
      let did = null, info = {};
      if (/^did:/.test(String(a))) {
        did = clip(a, 253);
        const q = [...this.peers.values()].find((x) => x.did === did);
        if (q) info = { name: q.name, handle: q.handle || null };
      } else {
        const q = this.findPeer(a);
        if (!q) return { error: `nobody called ${clip(a, 40)} is here: give their DID` };
        if (!q.did) return { error: `${q.name} isn't signed in, so they can't have a role` };
        did = q.did; info = { name: q.name, handle: q.handle || null };
      }
      if (!GRANTABLE.includes(b)) return { error: `pick one of ${GRANTABLE.join(', ')}` };
      return this.ref('roles:main').grant(this.who(p), did, b, info);
    }
    const verb = { kick: 'kick', mute: 'mute', unmute: 'unmute', move: 'move' }[method];
    if (!verb) throw new Error(`mod has no method ${method}`);
    const { q, error } = this.target(p, a, verb);
    if (error) return { error };
    if (method === 'kick') {
      this.sendOff(q, `${p.name} sent you out of the office${b ? `: ${clip(b, 200)}` : '.'}`);
      return { ok: true };
    }
    if (method === 'mute' || method === 'unmute') {
      const until = method === 'mute' ? this.now() + num(b, 1, 1440, 10) * 60000 : 0;
      if (until) this.mutes.set(this.ownerKey(q), until); else this.mutes.delete(this.ownerKey(q));
      q.mutedUntil = until;
      if (until) q.audio = false;
      this.onChange();
      this.broadcast({ t: 'peer', id: q.id, muted: until, ...(until ? { audio: false } : {}) });
      this.sendTo(q, { t: 'toast', text: until ? `🔇 ${p.name} muted you until ${stamp(until)}${c ? `: ${clip(c, 200)}` : ''}` : `🔊 ${p.name} unmuted you` });
      return until ? { until } : { ok: true };
    }
    // move
    const want = String(b || 'lobby').trim().toLowerCase();
    const zone = map.ZONES.find((z) => z.id === want || z.name.toLowerCase() === want || (z.channel && z.channel.toLowerCase() === `#${want.replace(/^#/, '')}`));
    if (!zone) return { error: `no area called ${clip(b, 40)}` };
    const from = zoneAt(q.x, q.y);
    const at = openSpot((zone.x0 + zone.x1 + 1) / 2, (zone.y0 + zone.y1 + 1) / 2, [...this.peers.values()].filter((x) => x.ready && x !== q));
    Object.assign(q, { x: at.x, y: at.y, moving: false, video: false, screen: false });
    q.spotSaved = 0; this.keepSpot(q);
    this.sendTo(q, { t: 'bounce', x: q.x, y: q.y, room: zone.id, moved: true, text: `${p.name} moved you to ${zone.name}` });
    this.broadcast({ t: 'move', id: q.id, x: q.x, y: q.y, dir: q.dir, moving: false }, q);
    this.broadcast({ t: 'peer', id: q.id, video: false, screen: false });
    if (from !== zone) {
      const who = this.who(q);
      if (from) this.publish(`zone:${from.id}`, { type: 'exit', who });
      this.publish(`zone:${zone.id}`, { type: 'enter', who });
    }
    return { ok: true, zone: zone.id };
  }

  // ---- where people stand, kept on their actor ------------------------------
  spotOf(p) { return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), dir: p.dir | 0, zone: zoneAt(p.x, p.y)?.id || null }; }

  // When someone stops (at most every 2 s), their actor keeps the spot, so a
  // refresh or a new sign-in puts them back there.
  keepSpot(p) {
    const key = p.kind !== 'freeq' && this.actorKey(p);
    if (!key || this.now() - (p.spotSaved || 0) < 2000) return;
    p.spotSaved = this.now();
    this.bg(this.ref(`actor:${key}`).place(this.spotOf(p)));
  }

  // Whether p may stand at a kept spot now: still on the map, not in a wall,
  // its area still there, and no booking or channel door keeping them out.
  canStand(at, p) {
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return false;
    if (at.x < 0 || at.y < 0 || at.x >= map.W || at.y >= map.H || isBlocked(Math.floor(at.x), Math.floor(at.y))) return false;
    const zone = zoneAt(at.x, at.y);
    if ((zone?.id || null) !== (at.zone ?? zone?.id ?? null)) return false;
    if (restrictedAt(this.bookings, at.x, at.y, p, this.now())) return false;
    if (zone?.channel && !this.door(zone.id, p).ok) return false;
    return true;
  }

  // Where a move target lands: { x, y } or { place } (zone, #channel, seat,
  // desk, furniture or person), on a free tile.
  spotFor(target, q) {
    const others = [...this.peers.values()].filter((x) => x.ready && x !== q);
    const s = String(target.place ?? '').trim().toLowerCase();
    if (!s) {
      const x = +target.x, y = +target.y;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= map.W || y >= map.H) return null;
      return openSpot(x, y, others, 0.6);
    }
    const zone = map.ZONES.find((z) => z.id === s || z.name.toLowerCase() === s || (z.channel && z.channel.toLowerCase() === `#${s.replace(/^#/, '')}`));
    if (zone) return openSpot((zone.x0 + zone.x1 + 1) / 2, (zone.y0 + zone.y1 + 1) / 2, others);
    const desk = DESKS.find((d) => d.id === s), seat = SEATS.find((d) => d.id === s) || desk?.seat;
    if (seat) return openSpot(seat.x, seat.y, others, 0.6);
    const f = FURNITURE.find((d) => d.id === s);
    if (f) return openSpot(f.x + f.w / 2, f.y + f.h + 0.5, others);
    const who = this.findPeer(target.place);
    if (who && who !== q) return openSpot(who.x, who.y, others);
    return null;
  }

  // Move someone by their actor key (Actor.moveTo). In the office their
  // client walks them there along a path (or they appear there, teleport);
  // away, the spot is returned for their actor to keep.
  walk(key, target = {}) {
    const here = [...this.peers.values()].filter((q) => q.ready && q.kind !== 'freeq' && this.ownerKey(q) === key);
    const at = this.spotFor(target, here[0] || null);
    if (!at) return { error: `don't know where ${clip(target.place ?? `${target.x},${target.y}`, 60)} is` };
    const zone = zoneAt(at.x, at.y)?.id || null;
    const text = target.text ? clip(target.text, 200) : null;
    for (const q of here) {
      if (target.teleport) {
        const from = zoneAt(q.x, q.y);
        Object.assign(q, { x: at.x, y: at.y, moving: false });
        this.sendTo(q, { t: 'bounce', x: q.x, y: q.y, room: zone, moved: true, text });
        this.broadcast({ t: 'move', id: q.id, x: q.x, y: q.y, dir: q.dir, moving: false }, q);
        if (from?.id !== zone) {
          const who = this.who(q);
          if (from) this.publish(`zone:${from.id}`, { type: 'exit', who });
          if (zone) this.publish(`zone:${zone}`, { type: 'enter', who });
        }
        q.spotSaved = 0; this.keepSpot(q);
      } else this.sendTo(q, { t: 'walk', x: at.x, y: at.y, text });
    }
    return { online: here.length > 0, x: at.x, y: at.y, zone };
  }

  // Make someone's browser follow another person (or stop, `id` null), the
  // way their Follow button does. Their own tabs only.
  followFor(key, id) {
    const here = [...this.peers.values()].filter((q) => q.ready && q.kind !== 'freeq' && this.ownerKey(q) === key);
    for (const q of here) this.sendTo(q, { t: 'follow', id });
    return { online: here.length > 0 };
  }

  // The admin panel: { t: 'mod', op, ref?, to?, reason?, minutes?, place?, id?, role? },
  // answered with { t: 'modres', ref, op, result }.
  async modOp(p, m) {
    const args = {
      people: [], kick: [m.to, m.reason], mute: [m.to, m.minutes, m.reason], unmute: [m.to],
      move: [m.to, m.place], removeItem: [m.id], grant: [m.to, m.role],
    }[m.op];
    if (!args) return;
    const result = await this.call(p, 'mod:main', m.op, args).catch((e) => ({ error: e.message }));
    this.sendTo(p, { t: 'modres', ref: m.ref ?? null, op: m.op, result });
  }

  showOut(q, room, text) {
    q.x = room.door.x; q.y = room.door.y; q.moving = false;
    q.video = false; q.screen = false;
    this.sendTo(q, { t: 'bounce', x: q.x, y: q.y, room: room.id, text });
    this.broadcast({ t: 'move', id: q.id, x: q.x, y: q.y, dir: q.dir, moving: false }, q);
    this.broadcast({ t: 'peer', id: q.id, video: false, screen: false });
  }
}
