// Channel rooms: the hallway wing of generated rooms under the core office
// (public/js/wing.js draws them). Two kinds:
//
//   wing:main       which channels have a room, and where. Any source can
//                   offer channels ("freeq" does, from freeq.js); people and
//                   agents can open one themselves ("office"). It never
//                   depends on a particular source: rooms are keyed by the
//                   channel name and kept while any source still wants them.
//   chan:<zone id>  one per room: the door. Holds the room's access policy
//                   (public/js/policy.js) and who accepted its rules or was
//                   let in, keeps its last lines of chat and shows them to
//                   whoever walks in. The World mirrors it and checks it at
//                   the door, for people and agents alike.
//
// Rooms don't move under people: a slot is kept while anyone stands in its
// room, and a channel that comes back gets its old slot if it's still free.

import { Entity } from './runtime.js';
import { str, int, arr, obj, opt, bool } from './schema.js';
import { MAX_ROOMS, tierFor, slugOf, channelKey, TIERS } from '../../public/js/wing.js';
import { cleanPolicy, officePolicy, evaluate, summary, describe } from '../../public/js/policy.js';

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const KEEP_MS = 30 * MIN; // a room nobody offers any more stays this long
export const OFFICE_IDLE_MS = 7 * DAY; // a room people opened goes after a week unused
const PRUNE_EVERY = HOUR;
const LOG_MAX = 40;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const validName = (s) => /^#?[\p{L}\p{N}][\p{L}\p{N}_.-]{0,31}$/u.test(s);

const REQ = { type: 'object', description: 'Requirement tree: { type: OPEN | ACCEPT {hash} | PRESENT {credential_type, issuer} | PROVE {proof_type} | INVITE | ALL/ANY {requirements} | NOT {requirement} } (freeq\'s policy DSL plus INVITE)' };
export const POLICY = { type: ['object', 'null'], description: 'Who may walk in: { source, version, require, roles, rules, rulesHash, endpoints: { type: { label, url } }, deny: [DID], url }. Null is open to all.', properties: { require: REQ } };
const ROOM = obj({
  id: str('Zone id (ch-<slug>)'), channel: str('Channel name'), slot: int('Slot in the wing', 0), tier: str('Size: s, m or l'),
  topic: opt(str('Topic')), members: int('Members, as the source counts them', 0), sources: arr(str('Source'), 'Who wants the room: freeq, office, …'),
  created: int('ms since epoch', 0), by: opt(str('Who opened it, for office rooms')),
  policy: POLICY, access: obj({ icon: str('Sign icon'), text: str('Sign text'), open: bool('Anyone may walk in') }, 'What the sign by the door says'),
});

export class Wing extends Entity {
  static doc = 'The hallway wing under the core office: one procedurally generated room per channel. Sources (freeq, or people opening rooms themselves) offer channels; the wing gives each a slot off the hallways, sizes it by member count, and archives rooms nobody wants any more once they are empty. Clients build the same rooms from its view.';
  static api = {
    view: { doc: 'The channel rooms, by slot. Each client generates the same room from { channel, slot, tier }.', returns: arr(ROOM, 'Rooms') },
    offer: {
      doc: 'A source\'s current channels. New ones get a room, known ones are updated, and rooms the source no longer lists are let go (archived once empty for 30 minutes and no other source wants them). Returns channel (lowercase, with #) -> zone id.',
      params: { source: str('Source name', 16), channels: arr(obj({ name: str('Channel'), members: opt(int('Members', 0)), topic: opt(str('Topic', 200)), policy: opt(POLICY), allow: opt(arr(str('DID'), 'DIDs the source already lets in (they skip the policy)', 500)) }), 'Channels', MAX_ROOMS) },
      returns: { type: 'object', additionalProperties: { type: 'string' }, description: 'channel -> zone id' }, mutates: true, internal: true,
    },
    open: {
      doc: 'Open a room for a channel off the hallway (or find the one it already has). Signed-in people and agents only. access: open (default), rules (people accept `rules` at the door) or invite (people inside let others in).', who: true, mutates: true,
      params: { name: str('Channel name, e.g. #design', 33), access: opt(str('open, rules or invite', 8, { enum: ['open', 'rules', 'invite'] })), rules: opt(str('Rules text for access=rules', 2000)) },
      returns: obj({ room: opt(ROOM), error: opt(str('Why not')) }),
    },
    close: {
      doc: 'Let go of a room you opened. It goes once it is empty, unless another source (freeq) still has the channel.', who: true, mutates: true,
      params: { name: str('Channel name', 33) },
      returns: obj({ ok: opt(bool('Let go')), error: opt(str('Why not')) }),
    },
    setAccess: {
      doc: 'Change who may walk into a room you opened: open, rules (accept `rules` at the door) or invite. Rooms from another source (freeq) keep that source\'s policy.', who: true, mutates: true,
      params: { name: str('Channel name', 33), access: str('open, rules or invite', 8, { enum: ['open', 'rules', 'invite'] }), rules: opt(str('Rules text for access=rules', 2000)) },
      returns: obj({ room: opt(ROOM), error: opt(str('Why not')) }),
    },
    prune: { doc: 'Archive rooms nobody wants that have been empty long enough. The alarm calls it.', mutates: true, internal: true },
  };
  static events = { tells: { 'chan:<id>': 'init { channel } when a room is made' }, receives: { active: 'from chan:<id>, someone used the room' } };

  get rooms() { return (this.state.rooms ||= {}); }
  get archive() { return (this.state.archive ||= {}); }

  view() {
    return Object.values(this.rooms).sort((a, b) => a.slot - b.slot).map((r) => {
      const src = Object.values(r.src || {});
      const policy = this.policyOf(r);
      return {
        id: r.id, channel: r.channel, slot: r.slot, tier: r.tier,
        topic: src.find((s) => s.topic)?.topic || null,
        members: Math.max(0, ...src.map((s) => s.members || 0)),
        sources: Object.keys(r.src || {}), created: r.created, by: r.by || null,
        policy, access: summary(policy),
      };
    });
  }

  // The policy that applies: the first source that has one (an outside
  // source's policy wins over what an opener picked in the office).
  policyOf(r) {
    const srcs = Object.entries(r.src || {}).sort(([a], [b]) => (a === 'office') - (b === 'office'));
    for (const [, s] of srcs) if (s.policy) return s.policy;
    return null;
  }

  // Who skips the policy: whoever the sources vouch for, and the opener.
  allowOf(r) {
    const out = new Set();
    for (const s of Object.values(r.src || {})) {
      for (const d of s.allow || []) out.add(d);
      if (s.owner) out.add(s.owner);
    }
    return [...out];
  }

  async occupied() {
    try { return new Set((await this.world.presence()).map((w) => w.zone).filter(Boolean)); } catch { return new Set(); }
  }

  // Make (or find) the room for a channel. Null when the wing is full.
  make(channel) {
    const key = channelKey(channel);
    if (this.rooms[key]) return this.rooms[key];
    const used = new Set(Object.values(this.rooms).map((r) => r.slot));
    if (used.size >= MAX_ROOMS) return null;
    const old = this.archive[key];
    let slot = old && !used.has(old.slot) ? old.slot : -1;
    for (let s = 0; slot < 0 && s < MAX_ROOMS; s++) if (!used.has(s)) slot = s;
    const ids = new Set(Object.values(this.rooms).map((r) => r.id));
    let id = old?.id && !ids.has(old.id) ? old.id : `ch-${slugOf(channel)}`;
    for (let n = 2; ids.has(id); n++) id = `ch-${slugOf(channel)}-${n}`;
    delete this.archive[key];
    const r = this.rooms[key] = { id, channel: `#${clip(channel, 33).replace(/^#+/, '')}`, slot, tier: 's', src: {}, created: this.now(), active: this.now() };
    this.fresh.push(r);
    return r;
  }

  // Grow or shrink to fit the channel, but only while nobody's inside.
  resize(r, occupied) {
    const members = Math.max(0, ...Object.values(r.src).map((s) => s.members || 0));
    const tier = tierFor(members);
    if (tier !== r.tier && TIERS[tier] && !occupied.has(r.id)) { r.tier = tier; return true; }
    return false;
  }

  async changed() {
    const fresh = this.fresh || [];
    this.fresh = [];
    await this.save();
    // Each room's door learns its channel and policy (only when they change).
    const doors = Object.values(this.rooms).map((r) => [r, { channel: r.channel, policy: this.policyOf(r), allow: this.allowOf(r) }])
      .filter(([r, d]) => fresh.includes(r) || JSON.stringify(d) !== r.door);
    await Promise.all(doors.map(([r, d]) => { r.door = JSON.stringify(d); return this.ref(`chan:${r.id}`).init(d); }));
    await this.save();
    await this.mirror(this.view());
    await this.setAlarm(Object.values(this.rooms).length ? this.now() + PRUNE_EVERY : null);
  }

  async offer(source, channels = []) {
    this.fresh = [];
    source = clip(source, 16) || 'source';
    const occupied = await this.occupied();
    const now = this.now(), seen = new Set(), out = {};
    for (const c of channels.slice(0, MAX_ROOMS)) {
      if (!c?.name || !validName(String(c.name).trim())) continue;
      const key = channelKey(c.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const r = this.make(c.name);
      if (!r) continue;
      r.src[source] = {
        members: Math.max(0, +c.members || 0), topic: c.topic ? clip(c.topic, 200) : null, at: now,
        policy: cleanPolicy(c.policy ? { ...c.policy, source } : null),
        allow: (Array.isArray(c.allow) ? c.allow : []).filter((d) => /^did:/.test(d)).slice(0, 500),
      };
      delete r.left;
      this.resize(r, occupied);
      out[key] = r.id;
    }
    for (const [key, r] of Object.entries(this.rooms)) {
      if (!r.src[source] || seen.has(key)) continue;
      delete r.src[source];
      if (!Object.keys(r.src).length) r.left = now;
    }
    this.sweep(occupied);
    await this.changed();
    return out;
  }

  async open(who, name, access = 'open', rules = null) {
    this.fresh = [];
    if (!who?.did && who?.kind !== 'agent') return { error: 'sign in to open a room' };
    name = clip(name, 33);
    if (!validName(name)) return { error: 'use a channel name like #design (letters, numbers, - _ .)' };
    const r = this.make(name);
    if (!r) return { error: `the wing is full (${MAX_ROOMS} rooms)` };
    if (!r.src.office) {
      r.src.office = { members: 0, topic: null, at: this.now(), owner: who.key, policy: officePolicy(access, rules) };
      r.by ||= who.name;
    }
    delete r.left;
    await this.changed();
    return { room: this.view().find((v) => v.id === r.id) };
  }

  async setAccess(who, name, access, rules = null) {
    this.fresh = [];
    const r = this.rooms[channelKey(name)];
    if (!r?.src.office) return { error: 'no room you opened has that name' };
    if (r.src.office.owner && r.src.office.owner !== who.key) return { error: `only ${r.by || 'whoever opened it'} can change who gets in` };
    if (access === 'rules' && !clip(rules, 2000)) return { error: 'write the rules people accept at the door' };
    r.src.office.policy = officePolicy(access, clip(rules, 2000));
    await this.changed();
    const room = this.view().find((v) => v.id === r.id);
    return { room, ...(Object.keys(r.src).some((k) => k !== 'office' && r.src[k].policy) ? { note: 'the channel\'s own policy from its source still applies' } : {}) };
  }

  async close(who, name) {
    this.fresh = [];
    const r = this.rooms[channelKey(name)];
    if (!r?.src.office) return { error: 'no room you opened has that name' };
    if (r.src.office.owner && r.src.office.owner !== who.key) return { error: `only ${r.by || 'whoever opened it'} can let it go` };
    delete r.src.office;
    if (!Object.keys(r.src).length) r.left = this.now();
    this.sweep(await this.occupied());
    await this.changed();
    return { ok: true };
  }

  // Rooms nobody wants: kept while anyone's in them, then archived (the slot
  // is remembered in case the channel comes back).
  sweep(occupied) {
    const now = this.now();
    for (const [key, r] of Object.entries(this.rooms)) {
      if (r.src.office && now - Math.max(r.active || 0, r.src.office.at) > OFFICE_IDLE_MS) {
        delete r.src.office;
        if (!Object.keys(r.src).length) r.left = now;
      }
      if (Object.keys(r.src).length || occupied.has(r.id) || now - (r.left || now) < KEEP_MS) continue;
      delete this.rooms[key];
      this.archive[key] = { slot: r.slot, id: r.id, at: now };
    }
    // Forget archived slots after a month.
    for (const [key, a] of Object.entries(this.archive)) if (now - a.at > 30 * DAY) delete this.archive[key];
  }

  async prune() {
    this.fresh = [];
    const before = Object.keys(this.rooms).length;
    this.sweep(await this.occupied());
    if (Object.keys(this.rooms).length !== before) await this.changed();
    else await this.setAlarm(before ? this.now() + PRUNE_EVERY : null);
  }

  alarm() { return this.prune(); }

  async onMessage({ type, data }) {
    if (type !== 'active') return;
    const r = Object.values(this.rooms).find((x) => x.id === data?.id);
    if (r) { r.active = this.now(); await this.save(); }
  }
}

// One generated room's door and memory. The World mirrors view() and checks
// it whenever someone steps in (Office.move), so the rule holds the same for
// people, agents and MCP tools.
const DOOR = obj({
  channel: opt(str('Channel')), policy: POLICY,
  allow: arr(str('DID or owner key'), 'Let in on the source\'s word (or opened the room)'),
  accepted: { type: 'object', additionalProperties: { type: 'string' }, description: 'owner key -> rules hash they accepted' },
  invited: arr(str('Owner key'), 'Let in by someone inside'),
}, 'The door: policy and who meets it');

export class ChannelRoom extends Entity {
  static doc = 'One generated channel room off the hallway, and its door. Holds the access policy its source gave it (freeq\'s channel policy, or what the opener picked), who accepted its rules or was let in, and the last 40 lines said inside, shown to whoever walks in. The World checks the door whenever anyone, person or agent, steps in.';
  static api = {
    view: { doc: 'The door: policy, who skips it, who accepted the rules, who was let in.', returns: DOOR },
    check: {
      doc: 'May the caller walk in? Says what is missing and how to get it (accept the rules at the sign, knock, or get a credential from the source).', who: true,
      returns: obj({ ok: bool('May walk in'), access: obj({ icon: str('Icon'), text: str('Text'), open: bool('Open to all') }), require: str('The policy in words'), needs: arr(obj({ type: str('ACCEPT, INVITE, PRESENT, PROVE, BANNED'), label: str('What to do'), url: opt(str('Where to get it')), hash: opt(str('Rules hash')) }), 'Missing'), rules: opt(str('Rules text')) }),
    },
    accept: {
      doc: 'Accept the room\'s rules (the text on its sign), which is what an ACCEPT policy asks. Pass the rules hash you were shown, so you accept these rules and not newer ones.', who: true, mutates: true,
      params: { hash: str('Rules hash from check or the sign', 128) },
      returns: obj({ ok: opt(bool('Accepted')), error: opt(str('Why not')) }),
    },
    admit: {
      doc: 'Let someone who knocked into an invite-only room. Only people inside can.', who: true, mutates: true,
      params: { to: str('Peer id or owner key of who to let in', 300) },
      returns: obj({ ok: opt(bool('Let in')), error: opt(str('Why not')) }),
    },
    history: { doc: 'The last lines said in the room, oldest first.', returns: arr(obj({ name: str('Who'), text: str('What'), ts: int('ms since epoch', 0), freeq: opt(bool('Said on freeq')) }), 'Lines') },
    init: { doc: 'Set up by the wing: the channel, its policy and who skips it.', params: { info: obj({ channel: str('Channel'), policy: POLICY, allow: opt(arr(str('DID'), 'Allow list')) }) }, mutates: true, internal: true },
    say: { doc: 'Keep a line said in the room.', params: { line: obj({ name: str('Who', 32), text: str('What', 500), ts: opt(int('ms since epoch', 0)), freeq: opt(bool('Said on freeq')) }) }, mutates: true, internal: true },
  };
  static events = { subscribes: { 'zone:<id>': 'enter: shows the newcomer the recent lines' }, tells: { 'wing:main': 'active, at most hourly' } };

  async setup() { await this.subscribe(`zone:${this.name}`); }
  get log() { return (this.state.log ||= []); }

  view() {
    return { channel: this.state.channel || null, policy: this.state.policy || null, allow: this.state.allow || [], accepted: this.state.accepted || {}, invited: this.state.invited || [] };
  }
  history() { return this.log; }

  async init({ channel, policy = null, allow = [] } = {}) {
    if (channel) this.state.channel = clip(channel, 33);
    const before = this.state.policy?.version;
    this.state.policy = cleanPolicy(policy);
    this.state.allow = (allow || []).slice(0, 500);
    // A new invite-only policy starts a fresh guest list; accepted rules
    // stay tied to their hash, so edited rules need accepting again anyway.
    if (before !== this.state.policy?.version && this.state.policy?.require?.type !== 'INVITE') this.state.invited = [];
    await this.save();
    await this.mirror(this.view(), { quiet: true });
  }

  check(who) {
    const v = this.view(), p = v.policy;
    const r = mayEnter(v, who);
    return { ok: r.ok, access: summary(p), require: describe(p?.require, p), needs: r.needs, rules: p?.rules || null };
  }

  async accept(who, hash) {
    const p = this.state.policy;
    if (!p?.rulesHash && !JSON.stringify(p?.require || {}).includes('"ACCEPT"')) return { error: 'this room has no rules to accept' };
    if (!JSON.stringify(p.require).includes(`"hash":"${String(hash).replace(/"/g, '')}"`)) return { error: 'those aren\'t the current rules: read the sign again' };
    (this.state.accepted ||= {})[who.key] = hash;
    await this.save();
    await this.mirror(this.view(), { quiet: true });
    return { ok: true };
  }

  async admit(who, to) {
    if (who.zone !== this.name) return { error: 'only people inside can let others in' };
    const list = new Set(this.state.invited || []);
    list.add(clip(to, 300));
    this.state.invited = [...list].slice(-200);
    await this.save();
    await this.mirror(this.view(), { quiet: true });
    return { ok: true };
  }

  async say({ name, text, ts, freeq } = {}) {
    if (!text) return;
    this.log.push({ name: clip(name, 32), text: clip(text, 500), ts: ts || this.now(), ...(freeq ? { freeq: true } : {}) });
    this.log.sort((a, b) => a.ts - b.ts);
    while (this.log.length > LOG_MAX) this.log.shift();
    await this.touch();
    await this.save();
  }

  async touch() {
    const now = this.now();
    if (now - (this.state.active || 0) < HOUR) return;
    this.state.active = now;
    await this.tell('wing:main', 'active', { id: this.name });
  }

  async onEvent(topic, ev) {
    if (ev.type !== 'enter' || !ev.who?.id) return;
    await this.touch();
    await this.save();
    if (this.log.length) await this.emit({ op: 'send', to: ev.who.id, msg: { t: 'chanlog', room: this.name, channel: this.state.channel || null, lines: this.log.slice(-15) } });
  }
}

// The door rule, from a door's view (what the World mirrors) and the person
// at it ({ key, did, id }): banned never; vouched for by the source, the
// opener, or already let in; else the policy itself.
export function mayEnter(door, who) {
  if (!door) return { ok: true, needs: [] };
  const keys = [who.key, who.did].filter(Boolean);
  const allowed = keys.some((k) => door.allow?.includes(k));
  const accepted = new Set(Object.entries(door.accepted || {}).filter(([k]) => keys.includes(k)).map(([, h]) => h));
  const invited = keys.some((k) => door.invited?.includes(k)) || door.invited?.includes(who.id);
  return evaluate(door.policy, { did: who.did, allowed, accepted, invited });
}
