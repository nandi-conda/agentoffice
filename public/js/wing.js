// The channel wing: a hallway system under the core office with one
// procedurally generated room per channel. Shared by the browser, the
// server and agents, so it must stay free of DOM APIs.
//
// Everyone builds the same rooms from the same short list
// ({ id, channel, slot, tier }, decided by the wing entity on the server):
// the slot fixes where a room is, the tier how big it is, and the channel
// name seeds its theme and furniture. Nothing else is sent.
//
//        core office (48 x 32)
//   ─────┬────────┬────────────────┬────────┬──────  y=31, doors into the hall
//        main hallway (3 tiles high, grows east as halls are added)
//   ─────┬─┐   ┌──┴──────┬─┐   ┌───┴──────────────  y=35
//    room 0│ A │room 1   room 6│ B │room 7
//    room 2│   │room 3         │   │ …               each hall: 3 rows of 2 rooms
//    room 4│   │room 5         │   │                 (it grows south as rows fill)
//
// Slots fill hall A first; a slot whose channel went away stays empty until
// the next new channel takes it, so rooms never move under people.

export const CORE_W = 48;
export const CORE_H = 32;
export const HALL_Y = 32; // the main hallway's first row (the core's bottom wall is y=31)
const TOP = HALL_Y + 3; // wall row between the main hallway and the first rooms
const PITCH_X = 24; // a hall and its two room columns
const PITCH_Y = 9; // a room row, sharing walls with the next
const ROWS = 3; // room rows per hall
export const PER_HALL = ROWS * 2;
export const MAX_ROOMS = 24;
// Doors from the core into the main hallway: under the lobby, kitchen and lounge.
export const CORE_DOORS = [6, 7, 20, 21, 37, 38];

// Room interiors by tier. A slot is 9 x 8 inside, so 'l' fills it.
export const TIERS = { s: { w: 5, h: 4 }, m: { w: 7, h: 6 }, l: { w: 9, h: 8 } };
export const tierFor = (members = 0) => (members >= 9 ? 'l' : members >= 4 ? 'm' : 's');

// '#General Chat' -> 'general-chat'
export const slugOf = (channel) => String(channel || '').toLowerCase().replace(/^#+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'room';
export const channelKey = (channel) => `#${String(channel || '').trim().replace(/^#+/, '').toLowerCase()}`;

// ---- seeded randomness --------------------------------------------------------

export function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// ---- geometry -------------------------------------------------------------------

// Where slot n is: which hall, which side of it, which row.
export function slotAt(slot) {
  const hall = Math.floor(slot / PER_HALL), k = slot % PER_HALL;
  const side = k % 2 ? 'e' : 'w', row = Math.floor(k / 2);
  const bx = hall * PITCH_X, top = TOP + row * PITCH_Y;
  return { hall, side, row, bx, top, cx0: bx + 11, cx1: bx + 13 };
}

// A room's interior rectangle and its door (in the hall wall, facing the hall).
export function roomRect(slot, tier) {
  const s = slotAt(slot), { w, h } = TIERS[tier] || TIERS.s;
  // Rooms hang from the wall row above them, so walls are never two thick.
  const y0 = s.top + 1, y1 = y0 + h - 1;
  const x0 = s.side === 'w' ? s.bx + 10 - w : s.bx + 15, x1 = x0 + w - 1;
  const wallX = s.side === 'w' ? s.bx + 10 : s.bx + 14;
  const dy = y0 + Math.floor((h - 1) / 2);
  const doors = h >= 6 ? [dy, dy + 1] : [dy];
  // Just outside, in the hall: where people are sent to walk in.
  const outside = { x: s.side === 'w' ? wallX + 1.5 : wallX - 0.5, y: doors[0] + 0.5 + (doors.length - 1) / 2 };
  return { ...s, x0, y0, x1, y1, w, h, wallX, doors, outside };
}

// The size of the whole map for these rooms.
export function extent(rooms) {
  if (!rooms.length) return { W: CORE_W, H: CORE_H, halls: [] };
  const halls = new Map(); // hall -> deepest row used
  for (const r of rooms) { const s = slotAt(r.slot); halls.set(s.hall, Math.max(halls.get(s.hall) ?? 0, s.row)); }
  const nHalls = Math.max(...halls.keys()) + 1, rows = Math.max(...halls.values()) + 1;
  return {
    W: Math.max(CORE_W, nHalls * PITCH_X + 1),
    H: Math.max(CORE_H, TOP + rows * PITCH_Y + 1),
    halls: [...halls].sort((a, b) => a[0] - b[0]).map(([hall, row]) => ({ hall, rows: row + 1 })),
    hallX1: Math.max(CORE_W - 2, nHalls * PITCH_X - 1),
  };
}

// ---- themes and furniture --------------------------------------------------------
// Only furniture the renderer already draws, and nothing interactive: a
// channel room is somewhere to stand and talk.

const THEMES = [
  { id: 'lounge', floors: ['rug', 'carpetPlum', 'carpetTeal'], sets: ['sofas', 'sofas', 'beanbags'], wall: ['bookshelf'], plants: 0.6, rug: true },
  { id: 'study', floors: ['carpetBlue', 'wood'], sets: ['table', 'table', 'round'], wall: ['bookshelf', 'bookshelf'], plants: 0.4 },
  { id: 'garden', floors: ['carpetGreen', 'moss'], sets: ['round', 'beanbags', 'grove'], wall: [], plants: 1, rug: false },
  { id: 'cafe', floors: ['tile', 'wood'], sets: ['round', 'round', 'table'], wall: ['counter'], plants: 0.5 },
  { id: 'library', floors: ['carpetAmber', 'wood'], sets: ['table', 'sofas'], wall: ['bookshelf', 'bookshelf', 'bookshelf'], plants: 0.3, rug: true },
  { id: 'den', floors: ['carpetTeal', 'carpetPlum', 'stone'], sets: ['beanbags', 'sofas', 'round'], wall: ['bookshelf'], plants: 0.5, rug: true },
];
const SOFAS = [['#4f46e5', '#3730a3', '#6366f1'], ['#0f766e', '#115e59', '#14b8a6'], ['#b45309', '#92400e', '#f59e0b'], ['#be123c', '#9f1239', '#f43f5e'], ['#475569', '#334155', '#64748b']];

// A furniture set's footprint and its pieces, relative to its top-left corner.
const SETS = {
  sofas: (r) => {
    const color = pick(r, SOFAS);
    return { w: 4, h: 3, items: [
      { type: 'sofa', dx: 0, dy: 0, w: 4, h: 1, solid: true, facing: 'down', color },
      { type: 'coffeetable', dx: 1, dy: 1, w: 2, h: 1, solid: true },
      { type: 'sofa', dx: 0, dy: 2, w: 4, h: 1, solid: true, facing: 'up', color },
    ] };
  },
  round: () => ({ w: 4, h: 2, items: [
    { type: 'roundtable', dx: 1, dy: 0, w: 2, h: 2, solid: true },
    { type: 'stool', dx: 0, dy: 0.5, w: 1, h: 1, seat: true, facing: 'right' },
    { type: 'stool', dx: 3, dy: 0.5, w: 1, h: 1, seat: true, facing: 'left' },
  ] }),
  table: (r) => {
    const w = r() < 0.5 ? 3 : 4;
    const items = [{ type: 'table', dx: 0, dy: 1, w, h: 1, solid: true }];
    for (let i = 0; i < w; i += 2) {
      items.push({ type: 'chair', dx: i, dy: 0, w: 1, h: 1, seat: true, facing: 'down' });
      items.push({ type: 'chair', dx: i, dy: 2, w: 1, h: 1, seat: true, facing: 'up' });
    }
    return { w, h: 3, items };
  },
  beanbags: (r) => ({ w: 3, h: 2, items: [
    { type: 'beanbag', dx: 0, dy: 0, w: 1, h: 1, seat: true, facing: 'right' },
    { type: 'beanbag', dx: 2, dy: r() < 0.5 ? 0 : 1, w: 1, h: 1, seat: true, facing: 'left' },
    { type: 'beanbag', dx: 1, dy: 1, w: 1, h: 1, seat: true, facing: 'up' },
  ] }),
  grove: () => ({ w: 3, h: 2, items: [
    { type: 'plant', dx: 0, dy: 0, w: 1, h: 1, solid: true },
    { type: 'plant', dx: 2, dy: 0, w: 1, h: 1, solid: true },
    { type: 'beanbag', dx: 1, dy: 1, w: 1, h: 1, seat: true, facing: 'up' },
  ] }),
};

// Furniture for one room: the theme comes from the channel name, the layout
// from the name and the room's size. Anything that would cut part of the
// room off from the door is left out.
export function furnish(room) {
  const r = rng(hash(room.channel));
  const theme = pick(r, THEMES);
  const floor = pick(r, theme.floors);
  const { x0, y0, x1, y1, w, h } = room;
  const doorX = room.side === 'w' ? x1 : x0; // the inside column by the door
  const items = [];
  const taken = new Set();
  const key = (x, y) => `${x},${y}`;
  const cells = (f) => {
    const out = [];
    for (let y = Math.floor(f.y); y < Math.ceil(f.y + f.h); y++) for (let x = Math.floor(f.x); x < Math.ceil(f.x + f.w); x++) out.push([x, y]);
    return out;
  };
  const inside = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  // Never right inside the door.
  const reserved = new Set(room.doors.map((y) => key(doorX, y)));
  const fits = (f) => cells(f).every(([x, y]) => inside(x, y) && !taken.has(key(x, y)) && !taken.has(`s${key(x, y)}`) && !reserved.has(key(x, y)));
  const reachable = () => {
    const seen = new Set(), todo = room.doors.map((y) => [doorX, y]);
    for (const [x, y] of todo) seen.add(key(x, y));
    while (todo.length) {
      const [x, y] = todo.pop();
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const k = key(nx, ny);
        if (!inside(nx, ny) || seen.has(k) || taken.has(k)) continue;
        seen.add(k); todo.push([nx, ny]);
      }
    }
    let open = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!taken.has(key(x, y))) open++;
    return seen.size === open;
  };
  // Place a group of pieces together, or not at all.
  const place = (group) => {
    if (!group.every(fits)) return false;
    const solid = group.filter((f) => f.solid).flatMap(cells).map(([x, y]) => key(x, y));
    // Seats aren't solid, but keep them clear of other pieces too.
    const all = group.flatMap(cells).map(([x, y]) => key(x, y));
    for (const k of solid) taken.add(k);
    if (!reachable()) { for (const k of solid) taken.delete(k); return false; }
    for (const k of all) if (!solid.includes(k)) taken.add(`s${k}`);
    items.push(...group);
    return true;
  };

  // A rug under the middle of bigger rooms.
  if (theme.rug && w >= 7 && h >= 6) items.push({ type: 'rug', x: x0 + 1, y: y0 + 1, w: w - 2, h: h - 2 });

  // Along the back wall (the top row): shelves or a counter.
  if (h >= 5) {
    for (const type of theme.wall) {
      const fw = type === 'counter' ? Math.min(4, w - 2) : between(r, 2, 3);
      if (fw < 2) continue;
      for (let tries = 0; tries < 4; tries++) {
        const fx = between(r, x0, x1 - fw + 1);
        if (place([{ type, x: fx, y: y0, w: fw, h: 1, solid: true }])) break;
      }
    }
  }

  // Furniture sets: one in a small room, a few in a big one.
  const want = w * h >= 60 ? 3 : w * h >= 36 ? 2 : 1;
  for (let i = 0, tries = 0; i < want && tries < 24; tries++) {
    const make = SETS[pick(r, theme.sets)];
    const set = make(r);
    if (set.w > w || set.h > h) continue;
    const sx = between(r, x0, x1 - set.w + 1), sy = between(r, h >= 5 ? y0 + 1 : y0, y1 - set.h + 1);
    const group = set.items.map(({ dx, dy, ...f }) => ({ ...f, x: sx + dx, y: sy + dy }));
    if (place(group)) i++;
  }

  // Plants in the corners away from the door.
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].filter(([x]) => x !== doorX);
  for (const [x, y] of corners) if (r() < theme.plants) place([{ type: 'plant', x, y, w: 1, h: 1, solid: true }]);

  return { theme: theme.id, floor, items };
}

// ---- the whole wing ----------------------------------------------------------------
// rooms: [{ id, channel, slot, tier }]. Returns the map size, the cells to
// carve ({ x, y, v } with v 0 floor, 1 wall, 3 void), and the zones,
// furniture and seats it adds.
export function buildWing(rooms) {
  rooms = rooms.filter((r) => Number.isInteger(r.slot) && r.slot >= 0 && r.slot < MAX_ROOMS);
  const ext = extent(rooms);
  const out = { W: ext.W, H: ext.H, cells: [], zones: [], furniture: [], seats: [] };
  if (!rooms.length) return out;
  const set = (x, y, v) => out.cells.push({ x, y, v });
  const fill = (xa, ya, xb, yb, v) => { for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) set(x, y, v); };

  // The main hallway, walled in, with doors up into the core.
  const hx1 = ext.hallX1;
  fill(CORE_W, 0, ext.W - 1, CORE_H - 2, 3); // beside the core: outside
  fill(0, CORE_H - 1, hx1 + 1, CORE_H - 1, 1);
  fill(0, HALL_Y, hx1 + 1, TOP, 1);
  fill(1, HALL_Y, hx1, TOP - 1, 0);
  for (const x of CORE_DOORS) set(x, CORE_H - 1, 0);
  out.zones.push({ id: 'hall', name: 'Hallway', kind: 'open', x0: 1, y0: HALL_Y, x1: hx1, y1: TOP - 1, floor: 'stone', gen: true, label: false });

  // The halls running south, each as deep as its last row of rooms.
  for (const { hall, rows } of ext.halls) {
    const s = slotAt(hall * PER_HALL), end = TOP + rows * PITCH_Y;
    fill(s.cx0 - 1, TOP, s.cx1 + 1, end, 1);
    fill(s.cx0, TOP, s.cx1, end - 1, 0);
    out.zones.push({ id: `hall-${hall}`, name: `Hall ${String.fromCharCode(65 + hall)}`, kind: 'open', x0: s.cx0, y0: TOP, x1: s.cx1, y1: end - 1, floor: 'stone', gen: true, label: false });
  }

  for (const room of rooms) {
    const rect = roomRect(room.slot, room.tier);
    const look = furnish({ ...rect, channel: room.channel });
    fill(rect.x0 - 1, rect.y0 - 1, rect.x1 + 1, rect.y1 + 1, 1);
    fill(rect.x0, rect.y0, rect.x1, rect.y1, 0);
    for (const y of rect.doors) set(rect.wallX, y, 0);
    out.zones.push({
      id: room.id, name: room.channel, kind: 'room', x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1, floor: look.floor,
      gen: true, channel: room.channel, theme: look.theme, tier: room.tier, slot: room.slot, door: rect.outside, side: rect.side,
    });
    // The name plate on the hall wall beside the door.
    const signY = rect.doors[0] - 1;
    out.furniture.push({ type: 'sign', id: `sign-${room.id}`, x: rect.wallX, y: signY, w: 1, h: 1, zone: room.id, text: room.channel, side: rect.side, gen: true, interact: 'sign', name: `${room.channel} sign` });
    look.items.forEach((f, i) => {
      const id = `${room.id}-${f.type}-${i}`;
      out.furniture.push({ ...f, id, zone: room.id, gen: true });
      if (f.seat) out.seats.push({ id, x: f.x + 0.5, y: f.y + 0.5, facing: f.facing, zone: room.id });
    });
  }
  return out;
}
