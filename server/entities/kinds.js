// The kinds of entity in the office (see runtime.js for how they run and
// talk). Each owns its own state and rules; the World mirrors what they
// show and turns it into protocol messages (Office.apply).

import { Entity } from './runtime.js';
import { str, int, num as numS, bool, arr, obj, opt, WHO } from './schema.js';
import { DESKS, ZONES, PLUGIN_OBJECTS } from '../../public/js/map.js';
import { PluginObject } from './plugin.js';
import { Gallery, UploadedObject } from './gallery.js';
import { MAX_SLOTS, FLOOR_MAX, FLOOR_TTL, applyChange, cleanItem } from '../../public/js/items.js';
import { Workstation } from './workstation.js';
import { MIN, RULES, roomById, activeBooking, checkSlot, toTime, parseInvitees, isHolder, keyOf, inRoomOrDoor } from '../../public/js/rooms.js';
import { stamp, stampRange } from '../../public/js/time.js';
import { Wing, ChannelRoom } from './channels.js';
import { ROLES, GRANTABLE, effectiveRole, grantError, can } from '../../public/js/roles.js';

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, d = lo) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
const shortId = () => crypto.randomUUID().slice(0, 8);

export const POMO_ZONES = ZONES.filter((z) => z.kind === 'quiet').map((z) => z.id);
export const MAX_STROKES = 3000;
const PROFILE_TTL = 10 * MIN;
// No sprite yet, or a handle that didn't verify? They may be fixing it right
// now, so look again soon.
const MISS_TTL = 30 * 1000;
const complete = (v) => !!(v?.sprite && v?.handle);
const INBOX_MAX = 30;

// An item stack, as entities and the docs describe it (public/js/items.js).
export const ITEM = obj({
  id: str('Stack id', 16), kind: str('What it is, e.g. coffee, cookie, myplugin:badge', 32), name: str('Name', 40), emoji: str('Emoji', 8),
  qty: int('How many', 1, 20), verb: opt(str('What using it looks like, e.g. eats', 16)), consume: opt(bool('Using it uses one up')),
  emote: opt(str('Emote shown while using it', 16)), data: opt({ description: 'Whatever the plugin that made it keeps on it (≤ 512 bytes of JSON)' }),
  from: opt(str('Where it came from', 40)), at: opt(int('When they got it, ms since epoch', 0)),
}, 'An item stack');
const CHANGE = obj({
  take: opt(arr(obj({ id: opt(str('Stack id', 16)), kind: opt(str('Item kind', 32)), qty: opt(int('How many (default 1)', 1, 20)) }), 'Taken first, oldest stacks of a kind first', 10)),
  give: opt(arr(ITEM, 'Then given (cleaned with cleanItem)', 10)),
  from: opt(str('Who is handing them out, stamped on given items', 40)),
}, 'A change to their things: all or nothing');

// ---- topics ----------------------------------------------------------------
// A pub/sub channel, itself an entity: it keeps its subscribers and fans
// events out to them. The World mirrors the subscriber count so it only
// publishes to topics somebody listens to.
export class Topic extends Entity {
  static doc = 'A pub/sub channel. Keeps its subscribers and fans events out to them; the World mirrors the subscriber count so it only publishes to topics somebody listens to.';
  static api = {
    view: { doc: 'How many subscribe.', returns: int('Subscriber count', 0) },
    subscribers: { doc: 'Addresses subscribed to this topic.', returns: arr(str('Entity address'), 'Subscribers') },
    subscribe: { doc: 'Add an entity to the topic.', params: { address: str('Subscriber address') }, returns: int('Subscriber count', 0), mutates: true, internal: true },
    unsubscribe: { doc: 'Remove an entity from the topic.', params: { address: str('Subscriber address') }, mutates: true, internal: true },
    publish: { doc: 'Send an event to every subscriber but the publisher (their notify()).', params: { ev: { type: 'object', description: 'The event, usually { type, ... }' }, from: str('Publisher address') }, returns: int('How many it went to', 0), internal: true },
  };

  view() { return (this.state.subs || []).length; }
  subscribers() { return this.state.subs || []; }

  async subscribe(address) {
    const subs = new Set(this.state.subs || []);
    if (subs.has(address)) return subs.size;
    subs.add(address);
    this.state.subs = [...subs];
    await this.save();
    await this.mirror(subs.size, { quiet: true });
    return subs.size;
  }

  async unsubscribe(address) {
    this.state.subs = (this.state.subs || []).filter((a) => a !== address);
    await this.save();
    await this.mirror(this.state.subs.length, { quiet: true });
  }

  async publish(ev, from) {
    const subs = (this.state.subs || []).filter((a) => a !== from);
    const out = await Promise.allSettled(subs.map((a) => this.ref(a).notify(this.name, ev, from)));
    for (const [i, r] of out.entries()) if (r.status === 'rejected') this.log('error', `publish to ${subs[i]} failed: ${r.reason?.message}`);
    return subs.length;
  }
}

// ---- actors -----------------------------------------------------------------
// One per identity: a DID (signed-in person or agent), or `agent:<name>` for
// agents without one. Guests are passers-by and don't get one.
// Holds the rpg.actor character, the status they had last, notes that came
// while they were away, and (for DIDs) their AT Protocol OAuth session.
const AT = obj({ x: numS('X in tiles'), y: numS('Y in tiles'), dir: opt(int('Facing: 0 down, 1 left, 2 right, 3 up', 0, 3)), zone: opt({ type: ['string', 'null'], description: 'Area id' }) }, 'Where they stand');
const TARGET = obj({ x: opt(numS('X in tiles')), y: opt(numS('Y in tiles')), place: opt(str('A zone id or name, #channel, seat or desk id, furniture id, or a person', 253)), teleport: opt(bool('Appear there instead of walking')), text: opt(str('Shown to them', 200)) }, 'Where to: x/y or place');

export class Actor extends Entity {
  static doc = 'One per identity: a DID (signed-in person or agent), or agent:<name> for agents without one. Holds the rpg.actor character, the status they had last, notes that came while they were away, what they carry (their inventory), and (for DIDs) their AT Protocol OAuth session. Guests get none: what a guest carries lives on their connection in the World and goes when they do.';
  static api = {
    view: { doc: 'Whether they are in and when they were last seen.', returns: obj({ online: bool('In the office now'), lastSeen: { type: ['integer', 'null'], description: 'ms since epoch' } }), internal: true },
    profile: { doc: 'Their rpg.actor character (cached 10 minutes, 30 seconds while they have no sprite or verified handle; the last good one if the PDS is down).', params: { opts: opt(obj({ fresh: opt(bool('Skip the cache')) }, 'Options')) }, returns: { type: ['object', 'null'], description: '{ handle, sprite, stats, displayName, description }, null without a DID' }, internal: true },
    arrive: { doc: 'Walking in: returns the character (re-read from their PDS if they had no sprite or verified handle last time), last status and note, and the notes kept while they were away (and empties the inbox).', mutates: true, internal: true },
    depart: { doc: 'Walking out, leaving from `at`.', params: { at: opt(AT) }, mutates: true, internal: true },
    where: { doc: 'Where they were last (kept while they are away, so a refresh or a new sign-in puts them back there).', returns: { type: ['object', 'null'], description: '{ x, y, dir, zone, at }' }, internal: true },
    place: { doc: 'The World keeps where they stand (when they stop, and as they leave).', params: { at: AT }, mutates: true, internal: true },
    moveTo: {
      doc: 'Move them: in the office they walk (or, with teleport, appear) at the place; away, it is where they come back. Anyone may move themselves; moderators may move anyone (people.move); entities pass who=null.',
      params: { who: { type: ['object', 'null'], description: 'Who asks (null: the system or another entity)' }, target: TARGET },
      returns: obj({ ok: opt(bool('Moved')), online: opt(bool('They were in, so they are walking there')), x: opt(numS('X')), y: opt(numS('Y')), zone: opt({ type: ['string', 'null'], description: 'Area' }), error: opt(str('Why not')) }),
      mutates: true, internal: true, cap: 'people.move',
    },
    remember: { doc: 'Keep their status and note for next time.', params: { last: obj({ status: opt(str('Status')), note: opt(str('Working-on note', 80)) }) }, mutates: true, internal: true },
    sessionGet: { doc: 'The AT Protocol OAuth session, unless older than ttlMs.', params: { ttlMs: opt(int('Max age in ms', 0)) }, internal: true },
    sessionSet: { doc: 'Store the OAuth session.', params: { session: { type: 'object', description: 'Tokens + DPoP key' } }, mutates: true, internal: true },
    sessionDel: { doc: 'Forget the OAuth session.', mutates: true, internal: true },
    inventory: { doc: 'What they carry.', returns: arr(ITEM, 'Item stacks'), internal: true },
    invApply: { doc: 'Take and give items in one go, all or nothing (at most 20 stacks of 20). The World calls it for picking up, dropping, giving and using; plugins reach it through the World.', params: { change: CHANGE }, returns: obj({ items: opt(arr(ITEM, 'What they carry now')), taken: opt(arr(ITEM, 'What was taken')), error: opt(str('Why not')) }), mutates: true, internal: true },
    role: { doc: 'The role they were granted (roles:main keeps the directory and hands each actor its copy).', returns: { type: ['object', 'null'], description: '{ role, by, at } or null' }, internal: true },
    setRole: { doc: 'Keep a copy of the role roles:main granted them (null: back to the default).', params: { grant: { type: ['object', 'null'], description: '{ role, by, at }' } }, mutates: true, internal: true },
  };
  // Internal all the way: any DID names an actor, so open reads would let
  // anyone create Durable Objects at will. Look people up with look or /api/actor.
  static events = { receives: { deliver: 'A protocol message for them: delivered now if they are in, kept in their inbox (30) if not.' } };

  get did() { return this.name.startsWith('did:') ? this.name : null; }

  view() { return { online: !!this.state.online, lastSeen: this.state.lastSeen || null }; }

  async profile({ fresh = false } = {}) {
    const load = this.services.loadActor;
    if (!this.did || !load) return null;
    const c = this.state.profile;
    if (!fresh && c && this.now() - c.at < (complete(c.v) ? PROFILE_TTL : MISS_TTL)) return c.v;
    try {
      const a = await load(this.did, { fresh });
      const v = { handle: a.handle, sprite: a.sprite, stats: a.stats, displayName: a.displayName, description: a.description };
      this.state.profile = { v, at: this.now() };
      await this.save();
      return v;
    } catch (e) {
      // A PDS that's down shouldn't cost them their character: keep the last one.
      if (c) return c.v;
      throw e;
    }
  }

  // Walking in: the character, what they were doing last time, and any
  // notes that arrived while they were out.
  async arrive() {
    let profile = null, error = null;
    // Walking in without a sprite or verified handle last time always looks
    // again, so a sprite or DNS record made a minute ago shows up on the next join.
    try { profile = await this.profile({ fresh: !complete(this.state.profile?.v) }); } catch (e) { error = e.message; }
    const inbox = this.state.inbox || [];
    this.state.inbox = [];
    this.state.online = (this.state.online || 0) + 1;
    this.state.lastSeen = this.now();
    await this.save();
    return { profile, error, status: this.state.status || null, note: this.state.note ?? null, inbox, items: this.state.items || [], at: this.state.at || null };
  }

  async depart(at = null) {
    if (at) this.keepAt(at);
    this.state.online = Math.max(0, (this.state.online || 0) - 1);
    this.state.lastSeen = this.now();
    await this.save();
  }

  where() { return this.state.at || null; }

  keepAt(at) {
    const x = +at?.x, y = +at?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.state.at = { x, y, dir: (+at.dir || 0) | 0, zone: at.zone || null, at: this.now() };
  }

  async place(at) { this.keepAt(at); await this.save(); }

  // Server-side logic moves people through here: a room pulling invitees
  // in, a plugin, a moderator. The World walks them if they're in.
  async moveTo(who, target) {
    if (who && who.key !== this.name && !can(who.role, 'people.move')) return { error: 'only moderators can move other people' };
    const r = await this.world.walk(this.name, target || {});
    if (r.error) return r;
    if (!r.online) { this.keepAt(r); await this.save(); }
    return { ok: true, ...r };
  }

  async remember({ status, note }) {
    if (status) this.state.status = status;
    if (note !== undefined) this.state.note = clip(note, 80);
    await this.save();
  }

  // Messages for the person: { type: 'deliver', data: <protocol message> }.
  // Delivered now if they're in the office, kept for their next visit if not.
  async onMessage({ type, data }) {
    if (type !== 'deliver' || !data?.t) return;
    const n = await this.world.deliver(this.name, data);
    if (n) return;
    const inbox = this.state.inbox || [];
    inbox.push({ ...data, queued: this.now() });
    this.state.inbox = inbox.slice(-INBOX_MAX);
    await this.save();
  }

  // What they carry. Every change goes through invApply, so it's all or
  // nothing even when two things hand them stuff at once.
  inventory() { return this.state.items || []; }

  async invApply({ take = [], give = [], from = null } = {}) {
    const now = this.now();
    const g = give.map((i) => cleanItem(i, { from, now })).filter(Boolean);
    const r = applyChange(this.state.items || [], { take, give: g }, { slots: MAX_SLOTS });
    if (r.error) return { error: r.error };
    this.state.items = r.items;
    await this.save();
    return r;
  }

  role() { return this.state.role || null; }
  async setRole(grant) {
    if (grant?.role) this.state.role = { role: grant.role, by: clip(grant.by, 64), at: grant.at || this.now() };
    else delete this.state.role;
    await this.save();
  }

  // The AT Protocol OAuth session (tokens + DPoP key), kept with the person.
  sessionGet(ttlMs) {
    const s = this.state.session;
    if (!s || (ttlMs && this.now() - s.at > ttlMs)) return undefined;
    return s.v;
  }
  async sessionSet(v) { this.state.session = { v, at: this.now() }; await this.save(); }
  async sessionDel() { delete this.state.session; await this.save(); }
}

// ---- desks ------------------------------------------------------------------
// Each desk is claimed by one owner. Desks listen to each other on the
// `desks` topic: claiming one lets go of any other desk you held.
export class Desk extends Entity {
  static doc = 'A desk, claimed by one owner with a goal. Claiming one lets go of any other desk you held (desks listen to each other on the desks topic). Someone else\'s desk frees up after 12 hours if they are not in.';
  static api = {
    view: { doc: 'Who holds it.', returns: { type: ['object', 'null'], description: '{ owner, name, handle, goal, since, seen } or null when free' } },
    claim: { doc: 'Put your name and goal on the desk.', who: true, params: { goal: opt(str('What you are working on', 80)) }, returns: obj({ ok: bool('Claimed'), error: opt(str('Why not')) }), mutates: true },
    goal: { doc: 'Change the goal on your desk.', who: true, params: { goal: str('What you are working on', 80) }, returns: obj({ ok: bool('Changed'), error: opt(str('Why not')) }), mutates: true },
    release: { doc: 'Give your desk up.', who: true, returns: obj({ ok: bool('Released'), error: opt(str('Why not')) }), mutates: true },
    touch: { doc: 'The owner came in: keeps the desk from going stale.', params: { key: str('Owner key') }, mutates: true, internal: true },
  };
  static events = { publishes: { desks: '{ type: "claimed", owner, desk } when someone claims this desk' }, subscribes: { desks: 'lets go of this desk when its owner claims another' } };

  async setup() { await this.subscribe('desks'); }
  view() { return this.state.holder || null; }
  seed(holder) { if (holder && !this.state.holder) { this.state.holder = holder; return this.save(); } }

  async changed() { await this.save(); await this.mirror(this.state.holder || null); }

  async claim(who, goal) {
    const cur = this.state.holder;
    if (cur && cur.owner !== who.key) {
      // Someone else's desk is taken until it goes stale and they're not in.
      const stale = this.now() - (cur.seen || 0) > 12 * 3600 * 1000;
      if (!stale || (await this.world.presence()).some((q) => q.key === cur.owner)) return { error: `${cur.name}'s desk` };
    }
    this.state.holder = { owner: who.key, name: who.name, handle: who.handle, goal: clip(goal, 80), since: cur?.owner === who.key ? cur.since : this.now(), seen: this.now() };
    await this.changed();
    await this.publish('desks', { type: 'claimed', owner: who.key, desk: this.name });
    return { ok: true };
  }

  async goal(who, goal) {
    if (this.state.holder?.owner !== who.key) return { error: 'not your desk' };
    this.state.holder.goal = clip(goal, 80);
    await this.changed();
    return { ok: true };
  }

  async release(who) {
    if (this.state.holder?.owner !== who.key) return { error: 'not your desk' };
    delete this.state.holder;
    await this.changed();
    return { ok: true };
  }

  // The owner came in: keeps the desk from going stale.
  async touch(key) {
    if (this.state.holder?.owner !== key) return;
    this.state.holder.seen = this.now();
    await this.save();
    await this.mirror(this.state.holder, { quiet: true });
  }

  async onEvent(topic, ev) {
    if (topic === 'desks' && ev.type === 'claimed' && ev.desk !== this.name && this.state.holder?.owner === ev.owner) {
      delete this.state.holder;
      await this.changed();
    }
  }
}

// ---- retired: the whiteboard, notice board, arcade, coffee machine and pomodoro
// They're WASM plugins now (plugins/wasm-whiteboard, -noticeboard, -arcade,
// -coffee, -pomodoro; entities plugin:whiteboard, plugin:noticeboard,
// plugin:arcade, plugin:coffee, plugin:pomodoro). These keep
// what the old entities saved so the plugin entities can take it over the
// first time they run (`legacy` on the map object, PluginObject.adopt), and
// take the very first offices' state (World.boot). Nothing else calls them.
// The whiteboard kept its strokes one storage key each; the plugin object
// takes them over as its feed.
export class Whiteboard extends Entity {
  static retired = true;
  static doc = 'Retired: the whiteboard is the plugin:whiteboard object now. Keeps the strokes it had for it.';
  static api = {};
  async view() { return [...(await this.host.storage.list({ prefix: 's:' })).values()]; }
  async seed(strokes) {
    if (!Array.isArray(strokes) || this.state.seq) return;
    let seq = 0;
    for (const s of strokes.slice(-MAX_STROKES)) await this.host.storage.put(`s:${String(++seq).padStart(10, '0')}`, s);
    this.state.seq = seq;
    await this.save();
  }
}

export class NoticeBoard extends Entity {
  static retired = true;
  static doc = 'Retired: the notice board is the plugin:noticeboard object now. Keeps the notes it had for it.';
  static api = {};
  view() { return this.state.notes || []; }
  seed(notes) { if (Array.isArray(notes) && !this.state.notes) { this.state.notes = notes; return this.save(); } }
}

export class Arcade extends Entity {
  static retired = true;
  static doc = 'Retired: the arcade leaderboard is the plugin:arcade object now. Keeps the scores it had for it.';
  static api = {};
  view() { return this.state.scores || []; }
  seed(scores) { if (Array.isArray(scores) && !this.state.scores) { this.state.scores = scores; return this.save(); } }
}

export class CoffeeMachine extends Entity {
  static retired = true;
  static doc = 'Retired: the coffee machine is the plugin:coffee object now. Keeps the cup count it had for it.';
  static api = {};
  view() { return { count: this.state.count || 0 }; }
  seed(count) { if (count && !this.state.count) { this.state.count = count; return this.save(); } }
}

export class Pomodoro extends Entity {
  static retired = true;
  static doc = 'Retired: the pomodoro is the plugin:pomodoro object now. Keeps the timer it had for it.';
  static api = {};
  view() {
    const { phase = 'idle', endsAt = 0, round = 0, focusMin = 25, breakMin = 5, startedBy } = this.state;
    return { state: { phase, endsAt, round, focusMin, breakMin, ...(startedBy ? { startedBy } : {}) }, count: this.state.count || 0 };
  }
  seed(count) { if (count && !this.state.count) { this.state.count = count; return this.save(); } }
}

// ---- meeting rooms -----------------------------------------------------------------------
// Each bookable room keeps its own bookings, wakes itself for reminders and
// start/end announcements, and listens on its zone topic for people coming in.
// Notes for a booking's owner go to their actor, so they get them even if
// they're out of the office.

// When tick() next has something to do for these bookings.
export function nextRoomEvent(bookings, now) {
  let t = Infinity;
  for (const b of bookings) {
    const s = b.sent || {};
    for (const [due, when] of [[!s.soon, b.start - RULES.remind], [!s.start, b.start], [b.autoRelease && !b.seen, b.start + RULES.grace], [!s.ending, b.end - RULES.remind], [!s.ended, b.end], [true, b.end + 24 * 60 * MIN]]) {
      if (due && when > now && when < t) t = when;
    }
    if (b.start <= now && now < b.end && !b.seen) t = Math.min(t, now + 30000);
  }
  return Number.isFinite(t) ? t : null;
}

export class Room extends Entity {
  static doc = 'A bookable meeting room. Keeps its own bookings, wakes itself for reminders and start/end announcements, keeps everyone but the meeting out while it runs, releases rooms nobody turned up to, and listens on its zone topic for people coming in. Notes for a booking\'s owner go to their actor, so they get them even when away.';
  static api = {
    view: { doc: 'Its bookings (a day of history included).', returns: arr(obj({ id: str('Booking id'), room: str('Room id'), title: str('Title'), start: int('ms since epoch', 0), end: int('ms since epoch', 0), owner: str('Owner key'), name: str('Owner name'), invitees: arr(str('Handle, DID or agent name'), 'Invitees'), lock: bool('Locked'), autoRelease: bool('Freed if nobody turns up') }), 'Bookings') },
    book: {
      doc: 'Create, cancel, extend, end, update a booking, or admit someone knocking. 15 min to 4 h, up to 14 days ahead, no overlaps; only the owner may change a booking (moderators can cancel or end anyone\'s).', who: true, ctx: true, mutates: true, cap: 'bookings.override',
      params: { m: obj({
        op: str('create, cancel, extend, end, update or admit', 8, { enum: ['create', 'cancel', 'extend', 'end', 'update', 'admit'] }),
        id: opt(str('Booking id (all ops but create)', 16)),
        title: opt(str('Title', 80)),
        start: opt({ type: ['integer', 'string'], description: 'ms since epoch, or "now"' }),
        end: opt(int('ms since epoch', 0)),
        minutes: opt(int('Length for create (15..240), or how much to extend by (5..120)', 5, 240)),
        invitees: opt(arr(str('Handle, DID or agent name', 253), 'Invitees', 20)),
        lock: opt(bool('Ignored: every booking keeps everyone but its holders out')),
        autoRelease: opt(bool('Free the room if nobody turns up within 10 minutes (default true)')),
        to: opt(str('Peer id to let in (admit)', 64)),
      }, 'What to do', ['op']) },
      returns: obj({ booking: opt(obj({ id: str('Booking id'), room: str('Room id'), title: str('Title'), start: int('ms since epoch', 0), end: int('ms since epoch', 0), owner: str('Owner key'), name: str('Owner name'), invitees: arr(str('Handle, DID or agent name'), 'Invitees'), lock: bool('Locked'), autoRelease: bool('Freed if nobody turns up') })), error: opt(str('Why not')) }),
    },
    unlock: { doc: 'Let someone into the meeting running now, past the booking, as if a holder had let them in: what a plugin with the unlock permission (e.g. the Skeleton Key) does for whoever uses it. The people in the meeting are told.', params: { who: WHO, by: str('What let them in', 40) }, returns: { type: 'object', description: '{ booking } or { error }' }, mutates: true, internal: true },
    tick: { doc: 'Send due reminders and announcements, release no-shows. Safe to call as often as you like; the alarm calls it.', params: { opts: opt(obj({ presence: arr(WHO, 'Who is in') })) }, mutates: true, internal: true },
  };
  static events = { subscribes: { 'zone:<room>': 'enter: a holder turning up keeps the booking from being released' } };

  get room() { return roomById(this.name); }
  get bookings() { return this.state.bookings || []; }
  set bookings(v) { this.state.bookings = v; }

  async setup() { await this.subscribe(`zone:${this.name}`); }
  view() { return this.bookings; }
  seed(all) {
    if (!Array.isArray(all) || this.state.bookings) return;
    this.bookings = all.filter((b) => b.room === this.name);
    return this.save();
  }

  async changed() {
    this.bookings.sort((a, c) => a.start - c.start);
    await this.save();
    await this.mirror(this.bookings);
    await this.setAlarm(nextRoomEvent(this.bookings, this.now()));
  }

  note(q, b, kind, text) {
    return { op: 'send', to: q.id, msg: { t: 'roomnote', kind, room: b.room, id: b.id, text } };
  }

  // Owner notes go through their actor, so they're kept if they're away.
  noteOwner(b, kind, text) {
    if (b.owner.startsWith('human:')) return null; // a guest, nobody to keep it for
    return this.tell(`actor:${b.owner}`, 'deliver', { t: 'roomnote', kind, room: b.room, id: b.id, text });
  }

  // `who` is the person asking, `all` every booking in the office (the
  // per-owner limit spans rooms), `presence` who's in the office now.
  async book(who, m, { all = [], presence = [] } = {}) {
    const now = this.now(), room = this.room, key = who.key;
    const effects = [];
    const others = all.filter((b) => b.room !== this.name);
    const list = () => [...others, ...this.bookings];
    const done = async (b) => { await this.changed(); if (effects.length) await this.emit(...effects); return { booking: b }; };

    if (m.op === 'create') {
      if (!who.did && who.kind !== 'agent') return { error: 'sign in to book a room' };
      const start = m.start === undefined || m.start === 'now' ? now : toTime(m.start, now);
      const end = m.end !== undefined ? toTime(m.end, now) : start + num(m.minutes, 15, 240, 30) * MIN;
      const slot = checkSlot(list(), { room: room.id, start, end, owner: key }, now);
      if (slot.error) return { error: slot.error };
      const b = {
        id: shortId(), room: room.id, title: clip(m.title, 80) || `${who.name}'s meeting`,
        start: slot.start, end: slot.end, owner: key, name: who.name, handle: who.handle,
        invitees: parseInvitees(m.invitees), lock: !!m.lock, autoRelease: m.autoRelease !== false,
        seen: false, admitted: [], sent: {}, created: now,
      };
      this.bookings = [...this.bookings, b];
      for (const q of presence) if (q.id !== who.id && isHolder(b, q)) effects.push(this.note(q, b, 'invite', `📅 ${who.name} invited you to “${b.title}” in ${room.name}, ${stampRange(b)}`));
      // Invited by DID and not here: their actor keeps the invite for them.
      const here = new Set(presence.map((q) => q.did).filter(Boolean));
      const away = b.invitees.filter((i) => i.startsWith('did:') && !here.has(i));
      await Promise.all(away.map((did) => this.tell(`actor:${did}`, 'deliver', { t: 'roomnote', kind: 'invite', room: b.room, id: b.id, text: `📅 ${who.name} invited you to “${b.title}” in ${room.name}, ${stampRange(b)}` })));
      const out = await done(b);
      await this.tick({ presence });
      return out;
    }

    const b = this.bookings.find((x) => x.id === m.id);
    if (!b) return { error: 'no such booking' };
    if (m.op === 'admit') {
      // Anyone already holding the room can let a knocker in.
      if (!isHolder(b, who) || !(b.start <= now && now < b.end)) return { error: 'only people in the meeting can let others in' };
      const q = presence.find((x) => x.id === m.to);
      if (!q) return { error: 'they left' };
      if (!b.admitted.includes(keyOf(q))) b.admitted.push(keyOf(q));
      effects.push(this.note(q, b, 'admit', `🔓 ${who.name} let you into ${room.name}`));
      return done(b);
    }
    // Moderators can cancel or end anyone's booking, not take it over.
    const override = b.owner !== key && can(who.role, 'bookings.override') && (m.op === 'cancel' || m.op === 'end');
    if (b.owner !== key && !override) return { error: 'only the person who booked it can change it' };
    if (override) await this.noteOwner(b, 'override', `📅 ${who.name} ${m.op === 'cancel' || b.start > now ? 'cancelled' : 'ended'} “${b.title}” in ${room.name}`);
    if (m.op === 'cancel' || (m.op === 'end' && b.start > now)) {
      this.bookings = this.bookings.filter((x) => x !== b);
      for (const q of presence) {
        if (q.id !== who.id && isHolder(b, q) && b.end > now) effects.push(this.note(q, b, 'cancel', `📅 “${b.title}” in ${room.name} was cancelled`));
      }
      await done(b);
      return { booking: { ...b, cancelled: true } };
    }
    if (m.op === 'end') {
      b.end = Math.max(b.start, now);
      b.sent.ended = true;
      return done(b);
    }
    if (m.op === 'extend') {
      const slot = checkSlot(list(), { room: b.room, start: b.start, end: b.end + num(m.minutes, 5, 120, 15) * MIN, owner: key, id: b.id }, now);
      if (slot.error) return { error: slot.error };
      b.end = slot.end;
      b.sent.ending = false;
      return done(b);
    }
    if (m.op === 'update') {
      if (m.title !== undefined) b.title = clip(m.title, 80) || b.title;
      if (m.invitees !== undefined) b.invitees = parseInvitees(m.invitees);
      if (m.lock !== undefined) b.lock = !!m.lock;
      if (m.start !== undefined || m.end !== undefined) {
        const start = m.start !== undefined ? toTime(m.start, now) : b.start;
        const end = m.end !== undefined ? toTime(m.end, now) : start + (b.end - b.start);
        const slot = checkSlot(list(), { room: b.room, start, end, owner: key, id: b.id }, now);
        if (slot.error) return { error: slot.error };
        Object.assign(b, { start: slot.start, end: slot.end, sent: {} });
      }
      return done(b);
    }
    return { error: 'unknown booking op' };
  }

  // A plugin with the unlock permission let `who` in: they count as admitted
  // to the meeting running now, and the meeting hears about it.
  async unlock(who, by = 'a key') {
    const now = this.now(), room = this.room;
    const b = activeBooking(this.bookings, room.id, now);
    if (!b) return { error: `${room.name} isn't booked right now: just walk in` };
    if (isHolder(b, who)) return { booking: b };
    b.admitted = [...new Set([...(b.admitted || []), keyOf(who)])];
    const presence = await this.world.presence().catch(() => []);
    const effects = presence.filter((q) => q.id !== who.id && isHolder(b, q)).map((q) => this.note(q, b, 'unlock', `🗝️ ${who.name} let themselves into ${room.name} with ${clip(by, 40)}`));
    effects.push(this.note(who, b, 'unlock', `🔓 ${room.name} is open to you until “${b.title}” ends at ${stamp(b.end)}`));
    await this.changed();
    await this.emit(...effects);
    return { booking: b };
  }

  // Reminders, start/end announcements, locking people out, and releasing
  // rooms nobody turned up to. Safe to call as often as you like.
  async tick({ presence } = {}) {
    const now = this.now(), room = this.room;
    presence ||= await this.world.presence();
    const effects = [], owners = [];
    let changed = false;
    const inside = presence.filter((q) => q.zone === room.id || inRoomOrDoor(room, q.x, q.y));
    for (const b of [...this.bookings]) {
      const sent = (b.sent ||= {});
      if (b.end <= now) {
        if (!sent.ended) {
          sent.ended = true; changed = true;
          for (const q of inside) effects.push(this.note(q, b, 'ended', `📅 “${b.title}” has ended. ${room.name} is free unless it's booked next.`));
        }
        continue;
      }
      if (!sent.soon && b.start > now && b.start - now <= RULES.remind) {
        sent.soon = true; changed = true;
        for (const q of presence) if (isHolder(b, q) && !inside.includes(q)) effects.push(this.note(q, b, 'soon', `📅 “${b.title}” in ${room.name} starts at ${stamp(b.start)}`));
      }
      if (b.start > now) continue;
      if (!b.seen && inside.some((q) => isHolder(b, q))) { b.seen = true; changed = true; }
      if (!sent.start) {
        sent.start = true; changed = true;
        for (const q of presence) {
          if (isHolder(b, q) && !inside.includes(q)) effects.push(this.note(q, b, 'start', `📅 “${b.title}” in ${room.name} is starting now`));
        }
      }
      // A booked room is for the meeting only: anyone else inside (there when
      // it started, or in by any other route) is shown out, every tick.
      for (const q of inside) {
        if (!isHolder(b, q)) effects.push({ op: 'showOut', to: q.id, room: room.id, text: `🔒 ${room.name} is booked for “${b.title}” (${b.name}) until ${stamp(b.end)}, so you've been shown out. Knock to be let in.` });
      }
      if (b.autoRelease && !b.seen && now - b.start >= RULES.grace) {
        this.bookings = this.bookings.filter((x) => x !== b);
        changed = true;
        owners.push([b, 'released', `📅 Nobody turned up to “${b.title}”, so ${room.name} was released`]);
        continue;
      }
      if (!sent.ending && b.end - now <= RULES.remind) {
        sent.ending = true; changed = true;
        const next = this.bookings.find((x) => x.start >= b.end && x.start - b.end < RULES.soon);
        for (const q of inside) effects.push(this.note(q, b, 'ending', `⏳ ${Math.ceil((b.end - now) / MIN)} minutes left in ${room.name}${next ? `. Next up: “${next.title}” (${next.name})` : ''}`));
      }
    }
    // Keep a day of history so "earlier today" still shows on the schedule.
    const keep = this.bookings.filter((b) => now - b.end < 24 * 60 * MIN);
    if (keep.length !== this.bookings.length) { this.bookings = keep; changed = true; }
    if (changed) await this.changed();
    else await this.setAlarm(nextRoomEvent(this.bookings, now));
    if (effects.length) await this.emit(...effects);
    for (const [b, kind, text] of owners) await this.noteOwner(b, kind, text);
  }

  alarm() { return this.tick(); }

  // Someone walked in: a holder turning up keeps the booking from being released.
  async onEvent(topic, ev) {
    if (ev.type !== 'enter') return;
    const now = this.now();
    const b = this.bookings.find((x) => x.start <= now && now < x.end);
    if (b && !b.seen && isHolder(b, ev.who)) { b.seen = true; await this.changed(); }
  }
}

// ---- the floor --------------------------------------------------------------------------
// Things people put down, wherever they stood. Anyone can pick them up (the
// World checks they're close enough); the cleaners take anything left a day.
export class Floor extends Entity {
  static doc = 'Things people dropped, where they dropped them: at most 40, each cleared away after a day. The World places and removes them (picking up needs you within 1.5 tiles); read it with floor_view.';
  static api = {
    view: { doc: 'Everything lying on the floor.', returns: arr(obj({ id: str('Floor id'), item: ITEM, x: numS('Tile x', 0, 48), y: numS('Tile y', 0, 32), by: str('Who put it down'), at: int('When, ms since epoch', 0) }), 'Things on the floor') },
    place: { doc: 'Put an item down at x, y. The oldest thing goes when the floor is full.', params: { entry: obj({ item: ITEM, x: numS('Tile x', 0, 48), y: numS('Tile y', 0, 32), by: str('Who put it down', 32) }) }, returns: str('Floor id'), mutates: true, internal: true },
    remove: { doc: 'Take something off the floor (first come, first served).', params: { id: str('Floor id', 16) }, returns: { type: ['object', 'null'], description: 'The entry, or null if someone got there first' }, mutates: true, internal: true },
  };

  view() { return this.state.items || []; }

  async changed() {
    await this.save();
    await this.mirror(this.view());
    const items = this.view();
    await this.setAlarm(items.length ? Math.min(...items.map((e) => e.at)) + FLOOR_TTL : null);
  }

  async place({ item, x, y, by }) {
    const clean = cleanItem(item, { now: this.now() });
    if (!clean) return null;
    const e = { id: shortId(), item: { ...clean, id: item.id || shortId() }, x: num(x, 0, 48), y: num(y, 0, 32), by: clip(by, 32), at: this.now() };
    this.state.items = [...this.view(), e].slice(-FLOOR_MAX);
    await this.changed();
    return e.id;
  }

  async remove(id) {
    const e = this.view().find((x) => x.id === id);
    if (!e) return null;
    this.state.items = this.view().filter((x) => x !== e);
    await this.changed();
    return e;
  }

  async alarm() {
    const now = this.now();
    const keep = this.view().filter((e) => now - e.at < FLOOR_TTL);
    if (keep.length === this.view().length) return this.setAlarm(keep.length ? Math.min(...keep.map((e) => e.at)) + FLOOR_TTL : null);
    this.state.items = keep;
    await this.changed();
  }
}

// ---- roles ----------------------------------------------------------------------------
// Who was granted which role (public/js/roles.js has the roles and what each
// may do). The World mirrors the directory, so every check it makes is
// instant, and each actor keeps a copy of its own grant. Owners and admins
// from the env (OWNER_DIDS, ADMIN_DIDS, in services.roles) are on top of
// it: they show in the directory but can't be changed here.
const GRANT = obj({ role: str('Role'), name: opt(str('Their name when it was granted', 32)), handle: opt({ type: ['string', 'null'], description: 'Their handle' }), by: str('Who granted it', 64), at: int('When, ms since epoch', 0), env: opt(bool('From OWNER_DIDS / ADMIN_DIDS: change the env to change it')) });
export class Roles extends Entity {
  static doc = `Server roles: who was granted which role (owner, admin, moderator, member, banned). Signed-in people are members and signed-in agents are agents unless granted something else; guests and MCP sessions that haven't signed in are guests and observers. Owners and admins start from the OWNER_DIDS and ADMIN_DIDS env vars and can't be changed here. ${Object.entries(ROLES).map(([r, v]) => `${v.label}: ${v.doc}`).join(' ')}`;
  static api = {
    view: { doc: 'Everyone with a role that isn\'t the default, by DID (env owners and admins included).', returns: { type: 'object', additionalProperties: GRANT, description: 'DID -> grant' } },
    grant: {
      doc: `Give someone a role (${GRANTABLE.join(', ')}; member puts them back to the default). Admins grant up to moderator to people below them; owners grant anything. Use mod_grant, which finds people by name or handle.`,
      who: true, mutates: true, role: 'admin', internal: true,
      params: { did: str('Their DID', 253, { pattern: '^did:' }), role: { type: 'string', enum: GRANTABLE, description: 'The role' }, info: opt(obj({ name: opt(str('Their name', 32)), handle: opt({ type: ['string', 'null'], description: 'Their handle' }) }, 'Who they are, for the directory')) },
      returns: obj({ did: opt(str('DID')), role: opt(str('Their role now')), error: opt(str('Why not')) }),
    },
  };

  get env() { return this.services.roles || {}; }
  get people() { return (this.state.people ||= {}); }

  view() {
    const out = {};
    for (const [did, g] of Object.entries(this.people)) out[did] = g;
    for (const did of this.env.admins || []) out[did] = { ...out[did], role: effectiveRole({ did }, this.people, this.env), by: 'ADMIN_DIDS', at: 0, env: true };
    for (const did of this.env.owners || []) out[did] = { ...out[did], role: 'owner', by: 'OWNER_DIDS', at: 0, env: true };
    return out;
  }

  async grant(who, did, role, info = {}) {
    did = clip(did, 253);
    if (!/^did:[a-z]+:\S+$/.test(did)) return { error: 'roles go to signed-in people: give a DID' };
    const by = who?.role || 'guest';
    const from = effectiveRole({ did }, this.people, this.env);
    const err = grantError(by, from, role);
    if (err) return { error: err };
    if (this.env.owners?.includes(did) || (this.env.admins?.includes(did) && role !== 'owner')) return { error: 'their role comes from OWNER_DIDS / ADMIN_DIDS: change the env to change it' };
    if (did === who.did && role !== 'owner' && by !== 'owner') return { error: 'you can\'t change your own role' };
    const grant = role === 'member' ? null : { role, name: clip(info?.name ?? this.people[did]?.name, 32) || undefined, handle: info?.handle ?? this.people[did]?.handle ?? null, by: clip(who.handle ? `@${who.handle}` : who.name, 64), at: this.now() };
    if (grant) this.people[did] = grant; else delete this.people[did];
    await this.save();
    await this.ref(`actor:${did}`).setRole(grant && { role: grant.role, by: grant.by, at: grant.at });
    await this.mirror(this.view());
    return { did, role: effectiveRole({ did }, this.people, this.env) };
  }
}

export const KINDS = {
  roles: Roles,
  topic: Topic, actor: Actor, room: Room, desk: Desk,
  whiteboard: Whiteboard, noticeboard: NoticeBoard, arcade: Arcade, coffee: CoffeeMachine, pomodoro: Pomodoro,
  plugin: PluginObject, gallery: Gallery, uobj: UploadedObject, floor: Floor, workstation: Workstation,
  wing: Wing, chan: ChannelRoom,
};

// Everything the World mirrors, pulled when it starts.
export const MIRRORED = [
  ...DESKS.map((d) => `desk:${d.id}`),
  ...ZONES.filter((z) => z.bookable).map((z) => `room:${z.id}`),
  'floor:main', 'wing:main', 'roles:main',
  ...PLUGIN_OBJECTS.map((f) => `plugin:${f.id}`), 'gallery:main',
  ...ZONES.map((z) => `topic:zone:${z.id}`), 'topic:office', 'topic:desks',
];
