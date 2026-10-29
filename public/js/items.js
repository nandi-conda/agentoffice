// Things people carry: the item shape, the office's own item kinds, and the
// stack arithmetic, shared by the server (actor inventories, the floor,
// plugin grants) and the browser (the inventory panel).
//
// An item stack is plain data:
//   { id, kind, name, emoji, qty, verb?, consume?, emote?, data?, from?, at }
// `kind` says what it is ('coffee', 'cookie', 'myplugin:badge'); `verb` is
// what using it looks like ("eats", "sips"); `consume` uses one up.
// Plugins hand items out through the same cleanItem(), so nothing they send
// gets further than these fields.

import { isBlocked, zoneAt } from './map.js';
import { lockedOut } from './rooms.js';

export const MAX_SLOTS = 20; // stacks a signed-in person or agent can carry
export const GUEST_SLOTS = 6; // guests carry less: theirs lives only as long as the visit
export const MAX_QTY = 20; // per stack
export const PICKUP_RANGE = 1.5; // tiles
export const GIVE_RANGE = 3; // tiles
export const PLACE_RANGE = 3; // tiles: how far from you you can put something down
export const FLOOR_MAX = 40; // things lying around the office at once
export const FLOOR_TTL = 24 * 3600 * 1000; // the cleaners come by every day
const MAX_DATA = 512;

const KIND = /^[a-z0-9][a-z0-9:._-]{0,31}$/;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const shortId = () => crypto.randomUUID().slice(0, 8);

// The office's own things. Plugins name theirs (see cleanItem), and a kind
// listed here fills in whatever a plugin leaves out.
export const ITEMS = {
  coffee: { name: 'Coffee', emoji: '☕', verb: 'sips', consume: true, emote: 'coffee', cup: true },
  chips: { name: 'Salt & Vinegar Chips', emoji: '🥔', verb: 'munches', consume: true, emote: 'happy' },
  choc: { name: 'Dark Chocolate Bar', emoji: '🍫', verb: 'eats', consume: true, emote: 'love' },
  gum: { name: 'Mint Gum', emoji: '🍬', verb: 'chews', consume: true, emote: 'silly' },
  soda: { name: 'Sparkling Water', emoji: '🥤', verb: 'drinks', consume: true, emote: 'happy' },
  cookie: { name: 'Giant Cookie', emoji: '🍪', verb: 'eats', consume: true, emote: 'happy' },
};

// Anything that claims to be an item (a plugin's grant, a client's echo),
// reduced to the fields above. Returns null when it isn't one.
export function cleanItem(raw, { from = null, now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || !KIND.test(raw.kind || '')) return null;
  const known = ITEMS[raw.kind] || {};
  const item = {
    kind: raw.kind,
    name: clip(raw.name, 40) || known.name || raw.kind,
    emoji: clip(raw.emoji, 8) || known.emoji || '📦',
    qty: Math.max(1, Math.min(MAX_QTY, Math.floor(+raw.qty) || 1)),
  };
  const verb = /^[a-z][a-z ]{0,15}$/i.test(raw.verb || '') ? raw.verb.toLowerCase() : known.verb;
  if (verb) item.verb = verb;
  if (raw.consume ?? known.consume) item.consume = true;
  const emote = /^[a-z]{1,16}$/.test(raw.emote || '') ? raw.emote : known.emote;
  if (emote) item.emote = emote;
  if (raw.data !== undefined && raw.data !== null) {
    try {
      const json = JSON.stringify(raw.data);
      if (json && json.length <= MAX_DATA) item.data = JSON.parse(json);
    } catch { /* not JSON: dropped */ }
  }
  if (from || raw.from) item.from = clip(from || raw.from, 40);
  item.at = Number.isFinite(raw.at) ? raw.at : now;
  return item;
}

const stacks = (a, b) => a.kind === b.kind && a.name === b.name && a.data === undefined && b.data === undefined;

// Put items into a list of stacks. All or nothing: { items } on success,
// { error } when they don't fit.
export function addItems(list, give, { slots = MAX_SLOTS } = {}) {
  const out = list.map((s) => ({ ...s }));
  for (const g of give) {
    let left = g.qty;
    for (const s of out) {
      if (!left || !stacks(s, g)) continue;
      const n = Math.min(left, MAX_QTY - s.qty);
      s.qty += n; left -= n;
    }
    while (left > 0) {
      if (out.length >= slots) return { error: `your hands are full (${slots} things at most): drop or use something first` };
      const n = Math.min(left, MAX_QTY);
      const { id, ...rest } = g;
      out.push({ ...rest, id: id && !out.some((s) => s.id === id) ? id : shortId(), qty: n });
      left -= n;
    }
  }
  return { items: out };
}

// Take items out: each of `take` names a stack by id, or a kind (the oldest
// stacks of it first), and a qty (default 1). All or nothing: { items, taken }
// or { error }. `taken` are the stacks removed, with the qty taken.
export function takeItems(list, take) {
  const out = list.map((s) => ({ ...s }));
  const taken = [];
  for (const t of take) {
    let want = Math.max(1, Math.floor(+t.qty) || 1);
    const from = t.id ? out.filter((s) => s.id === t.id) : out.filter((s) => s.kind === t.kind);
    const have = from.reduce((n, s) => n + s.qty, 0);
    if (have < want) {
      const what = from[0]?.name || ITEMS[t.kind]?.name || t.kind || 'that';
      return { error: have ? `you only have ${have} ${what}` : `you don't have ${t.id ? 'that' : what}` };
    }
    for (const s of from) {
      if (!want) break;
      const n = Math.min(want, s.qty);
      s.qty -= n; want -= n;
      taken.push({ ...s, qty: n });
    }
  }
  return { items: out.filter((s) => s.qty > 0), taken };
}

// A change to someone's things: take first, then give, all or nothing.
export function applyChange(list, { take = [], give = [] } = {}, opts = {}) {
  const t = takeItems(list, take);
  if (t.error) return { error: t.error };
  const g = addItems(t.items, give, opts);
  if (g.error) return { error: g.error };
  return { items: g.items, taken: t.taken };
}

// "a Giant Cookie", "3 × Coffee"
export const label = (s) => `${s.emoji} ${s.qty > 1 ? `${s.qty} × ` : ''}${s.name}`;

// The button that uses it: "Eat", "Drink", "Use".
const BUTTONS = { eats: 'Eat', munches: 'Eat', sips: 'Drink', drinks: 'Drink', chews: 'Chew', reads: 'Read', plays: 'Play', wears: 'Wear' };
export const useButton = (s) => BUTTONS[s.verb] || (s.verb ? 'Use' : 'Show off');

// What using an item looks like: "eats a Giant Cookie 🍪".
export function useLine(s) {
  const verb = s.verb || 'shows off';
  const a = /^[aeiou]/i.test(s.name) ? 'an' : 'a';
  return `${verb} ${s.consume ? a : 'their'} ${s.name} ${s.emoji}`;
}

// ---- putting things down -------------------------------------------------------
// Where someone standing at p can put something: free tiles within
// PLACE_RANGE they can reach on foot (so never through a wall), not in a
// booked room they're kept out of, and not on top of something already
// lying there. The browser draws these; the server checks against the same.
// Returns Map 'x,y' -> { x, y, ok, why } for every tile in range.
export function placeTiles(p, { floor = [], bookings = [], now = Date.now() } = {}) {
  const sx = Math.floor(p.x), sy = Math.floor(p.y);
  const near = (tx, ty) => Math.hypot(tx + 0.5 - p.x, ty + 0.5 - p.y) <= PLACE_RANGE;
  const taken = new Set(floor.map((e) => `${Math.floor(e.x)},${Math.floor(e.y)}`));
  const out = new Map();
  const reach = new Set([`${sx},${sy}`]);
  const queue = [[sx, sy]];
  // Flood out from where they stand, 8-way without cutting corners, like walking.
  while (queue.length) {
    const [x, y] = queue.shift();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if ((!dx && !dy) || reach.has(k) || !near(nx, ny) || isBlocked(nx, ny)) continue;
      if (dx && dy && (isBlocked(x + dx, y) || isBlocked(x, y + dy))) continue;
      reach.add(k);
      queue.push([nx, ny]);
    }
  }
  for (let ty = sy - PLACE_RANGE; ty <= sy + PLACE_RANGE; ty++) for (let tx = sx - PLACE_RANGE; tx <= sx + PLACE_RANGE; tx++) {
    if (!near(tx, ty)) continue;
    const k = `${tx},${ty}`;
    let why = null;
    if (isBlocked(tx, ty)) why = 'something is in the way there';
    else if (!reach.has(k)) why = 'you can\'t reach there from here';
    else if (taken.has(k)) why = 'something is already lying there';
    else {
      const z = zoneAt(tx + 0.5, ty + 0.5);
      if (z?.bookable && lockedOut(bookings, z.id, p, now)) why = `${z.name} is booked right now`;
    }
    out.set(k, { x: tx, y: ty, ok: !why, why });
  }
  return out;
}

// Can p put something down on the tile at (x, y)? null if so, else why not.
export function placeError(p, x, y, opts) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return 'say where to put it';
  const t = placeTiles(p, opts).get(`${tx},${ty}`);
  if (!t) return `that's too far: you can put things down within ${PLACE_RANGE} tiles of you`;
  return t.why;
}

// The free tile nearest to p (their own first), for "put it down here".
export function nearestPlace(p, opts) {
  let best = null, bd = Infinity;
  for (const t of placeTiles(p, opts).values()) {
    const d = Math.hypot(t.x + 0.5 - p.x, t.y + 0.5 - p.y);
    if (t.ok && d < bd) { bd = d; best = t; }
  }
  return best;
}
