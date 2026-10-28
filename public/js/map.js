// Shared office layout. Imported by both the browser client and the Node
// server, so it must stay free of DOM APIs.
//
// Coordinates are in tiles: x grows to the right, y grows downward.

export const W = 48;
export const H = 32;

// Zone kinds decide who hears whom:
//   open  - proximity: you hear people within HEAR_RADIUS tiles
//   room  - private: everyone inside hears everyone inside, nobody outside
//   quiet - focus den: text only, shared pomodoro, no voice
//
// Bookable rooms take reservations (see rooms.js). `av` rooms add video and
// screen share to the voice call; `door` is the spot just outside, where
// people are shown out when a locked booking starts.
export const HEAR_RADIUS = 6;

export const ZONES = [
  { id: 'focus', name: 'Deep Work Den', kind: 'quiet', x0: 1, y0: 1, x1: 12, y1: 12, floor: 'carpetBlue' },
  { id: 'booths', name: 'Phone Booths', kind: 'open', x0: 1, y0: 14, x1: 12, y1: 18, floor: 'wood' },
  { id: 'booth1', name: 'Booth 1', kind: 'room', x0: 1, y0: 14, x1: 3, y1: 16, floor: 'carpetPlum', bookable: true, av: false, seats: 1, door: { x: 2.5, y: 18.5 } },
  { id: 'booth2', name: 'Booth 2', kind: 'room', x0: 5, y0: 14, x1: 7, y1: 16, floor: 'carpetPlum', bookable: true, av: false, seats: 1, door: { x: 6.5, y: 18.5 } },
  { id: 'booth3', name: 'Booth 3', kind: 'room', x0: 9, y0: 14, x1: 11, y1: 16, floor: 'carpetPlum', bookable: true, av: false, seats: 1, door: { x: 10.5, y: 18.5 } },
  { id: 'lobby', name: 'Lobby', kind: 'open', x0: 1, y0: 20, x1: 12, y1: 30, floor: 'stone' },
  { id: 'open', name: 'Open Office', kind: 'open', x0: 14, y0: 1, x1: 33, y1: 19, floor: 'wood' },
  { id: 'board', name: 'Boardroom', kind: 'room', x0: 35, y0: 1, x1: 46, y1: 10, floor: 'carpetGreen', bookable: true, av: true, seats: 8, door: { x: 33.5, y: 6.5 } },
  { id: 'huddle', name: 'Huddle Room', kind: 'room', x0: 35, y0: 12, x1: 46, y1: 19, floor: 'carpetGreen', bookable: true, av: true, seats: 4, door: { x: 33.5, y: 16.5 } },
  { id: 'kitchen', name: 'Kitchen', kind: 'open', x0: 14, y0: 21, x1: 26, y1: 30, floor: 'tile' },
  { id: 'lounge', name: 'Lounge', kind: 'open', x0: 28, y0: 21, x1: 46, y1: 30, floor: 'rug' },
];

// Furniture. `solid` items block movement; `seat` items can be sat on.
// w/h are the footprint in tiles.
export const FURNITURE = [];
export const DESKS = [];
export const SEATS = [];

const add = (f) => { FURNITURE.push(f); return f; };

function desk(id, x, y, facing) {
  // A desk is 2 tiles wide. The chair sits on the side the worker faces from.
  const d = add({ type: 'desk', id, x, y, w: 2, h: 1, solid: true, facing });
  const cy = facing === 'up' ? y + 1 : y - 1;
  const seat = add({ type: 'chair', id: `${id}-chair`, x: x + 0.5, y: cy, w: 1, h: 1, seat: true, facing, desk: id });
  DESKS.push({ id, x, y, w: 2, seat: { x: x + 1, y: cy + 0.5 }, facing });
  SEATS.push({ id: seat.id, x: x + 1, y: cy + 0.5, facing, desk: id });
}

// Open office: six pods of four desks.
let n = 1;
for (const py of [3, 9, 15]) {
  for (const px of [16, 23]) {
    desk(`desk-${n++}`, px, py, 'down');
    desk(`desk-${n++}`, px + 2, py, 'down');
    desk(`desk-${n++}`, px, py + 1, 'up');
    desk(`desk-${n++}`, px + 2, py + 1, 'up');
  }
}
// Window-side hot desks along the right of the open office.
desk(`desk-${n++}`, 30, 3, 'up');
desk(`desk-${n++}`, 30, 7, 'up');

// Deep Work Den: three rows of solo desks facing the clock.
for (const [dx, dy] of [[2, 5], [5, 5], [8, 5], [2, 8], [5, 8], [8, 8]]) {
  desk(`den-${dx}-${dy}`, dx, dy, 'up');
}
add({ type: 'pomodoro', id: 'pomodoro', x: 5.5, y: 1, w: 2, h: 1, solid: true, zone: 'focus', interact: 'pomodoro' });
add({ type: 'plant', id: 'p-den1', x: 1, y: 11, w: 1, h: 1, solid: true });
add({ type: 'plant', id: 'p-den2', x: 11, y: 11, w: 1, h: 1, solid: true });
add({ type: 'bookshelf', id: 'den-shelf', x: 1, y: 1, w: 3, h: 1, solid: true });

// Boardroom
add({ type: 'table', id: 'board-table', x: 37, y: 4, w: 8, h: 3, solid: true });
for (let i = 0; i < 4; i++) {
  for (const [cy, f] of [[3, 'down'], [7, 'up']]) {
    const id = `board-chair-${i}-${cy}`;
    add({ type: 'chair', id, x: 37.5 + i * 2, y: cy, w: 1, h: 1, seat: true, facing: f });
    SEATS.push({ id, x: 38 + i * 2, y: cy + 0.5, facing: f });
  }
}
add({ type: 'whiteboard', id: 'whiteboard', x: 38, y: 1, w: 6, h: 1, solid: true, interact: 'whiteboard' });
add({ type: 'screen', id: 'board-screen', x: 44, y: 1, w: 2, h: 1, solid: true, zone: 'board' });
add({ type: 'plant', id: 'p-board', x: 46, y: 10, w: 1, h: 1, solid: true });

// Huddle room
add({ type: 'roundtable', id: 'huddle-table', x: 39, y: 14, w: 3, h: 3, solid: true });
for (const [x, y, f] of [[38, 15, 'right'], [42, 15, 'left'], [40, 13, 'down'], [40, 17, 'up']]) {
  const id = `huddle-chair-${x}-${y}`;
  add({ type: 'chair', id, x, y, w: 1, h: 1, seat: true, facing: f });
  SEATS.push({ id, x: x + 0.5, y: y + 0.5, facing: f });
}
add({ type: 'screen', id: 'huddle-screen', x: 44, y: 12, w: 2, h: 1, solid: true, zone: 'huddle' });

// Booking panels: wall tablets beside each bookable room's door, showing
// whether the room is free. They hang on the wall, so they don't block.
for (const [zone, x, y] of [['board', 34, 5], ['huddle', 34, 15], ['booth1', 3, 17], ['booth2', 7, 17], ['booth3', 11, 17]]) {
  add({ type: 'panel', id: `panel-${zone}`, x, y, w: 1, h: 1, zone, interact: 'room' });
}
add({ type: 'plant', id: 'p-hud', x: 35, y: 19, w: 1, h: 1, solid: true });

// Phone booths: a stool each.
for (const bx of [1, 5, 9]) {
  const id = `booth-stool-${bx}`;
  add({ type: 'stool', id, x: bx + 1, y: 15, w: 1, h: 1, seat: true, facing: 'up' });
  SEATS.push({ id, x: bx + 1.5, y: 15.5, facing: 'up' });
}

// Lobby
add({ type: 'reception', id: 'reception', x: 3, y: 22, w: 5, h: 2, solid: true });
add({ type: 'sofa', id: 'lobby-sofa', x: 2, y: 28, w: 3, h: 1, solid: true, facing: 'up' });
add({ type: 'plant', id: 'p-lob1', x: 1, y: 20, w: 1, h: 1, solid: true });
add({ type: 'plant', id: 'p-lob2', x: 11, y: 20, w: 1, h: 1, solid: true });
add({ type: 'plant', id: 'p-lob3', x: 11, y: 29, w: 1, h: 1, solid: true });
add({ type: 'kiosk', id: 'kiosk', x: 10, y: 22, w: 1, h: 1, solid: true, interact: 'plugin', plugin: 'kiosk', name: 'Help kiosk', prompt: 'Ask the help kiosk' });
add({ type: 'board', id: 'noticeboard', x: 8, y: 20, w: 2, h: 1, solid: true, interact: 'noticeboard' });

// Kitchen
add({ type: 'counter', id: 'counter', x: 14, y: 21, w: 7, h: 1, solid: true });
add({ type: 'coffee', id: 'coffee', x: 23, y: 21, w: 1, h: 1, solid: true, interact: 'coffee' });
add({ type: 'fridge', id: 'fridge', x: 25, y: 21, w: 2, h: 1, solid: true });
for (const [tx, ty] of [[16, 25], [21, 25]]) {
  add({ type: 'roundtable', id: `k-table-${tx}`, x: tx, y: ty, w: 2, h: 2, solid: true });
  for (const [cx, cy, f] of [[tx - 1, ty + 0.5, 'right'], [tx + 2, ty + 0.5, 'left']]) {
    const id = `k-chair-${cx}-${cy}`;
    add({ type: 'stool', id, x: cx, y: cy, w: 1, h: 1, seat: true, facing: f });
    SEATS.push({ id, x: cx + 0.5, y: cy + 0.5, facing: f });
  }
}
add({ type: 'vending', id: 'vending', x: 21, y: 21, w: 1, h: 1, solid: true, interact: 'plugin', plugin: 'vending', name: 'Vending machine', prompt: 'Get a snack' });
add({ type: 'plant', id: 'p-kit', x: 14, y: 30, w: 1, h: 1, solid: true });

// Lounge
add({ type: 'rug', id: 'rug', x: 31, y: 23, w: 8, h: 5 });
add({ type: 'sofa', id: 'sofa1', x: 32, y: 22, w: 4, h: 1, solid: true, facing: 'down' });
add({ type: 'sofa', id: 'sofa2', x: 32, y: 28, w: 4, h: 1, solid: true, facing: 'up' });
add({ type: 'coffeetable', id: 'ctable', x: 33, y: 24, w: 2, h: 2, solid: true });
add({ type: 'arcade', id: 'arcade', x: 44, y: 21, w: 1, h: 1, solid: true, interact: 'arcade' });
add({ type: 'arcade', id: 'arcade2', x: 45, y: 21, w: 1, h: 1, solid: true, interact: 'arcade' });
add({ type: 'bookshelf', id: 'shelf', x: 38, y: 21, w: 3, h: 1, solid: true });
add({ type: 'beanbag', id: 'bean1', x: 41, y: 26, w: 1, h: 1, seat: true, facing: 'left' });
add({ type: 'beanbag', id: 'bean2', x: 43, y: 27, w: 1, h: 1, seat: true, facing: 'up' });
SEATS.push({ id: 'bean1', x: 41.5, y: 26.5, facing: 'left' });
SEATS.push({ id: 'bean2', x: 43.5, y: 27.5, facing: 'up' });
// Interactive objects run by plugin Workers (see docs/plugins.md). `plugin`
// names the handler; on Cloudflare it's reached through the PLUGIN_<NAME> binding.
add({ type: 'jukebox', id: 'jukebox', x: 29, y: 21, w: 1, h: 1, solid: true, interact: 'plugin', plugin: 'jukebox', name: 'Jukebox', prompt: 'Pick a song on the jukebox' });
add({ type: 'eightball', id: 'eightball', x: 42, y: 21, w: 1, h: 1, solid: true, interact: 'plugin', plugin: 'eightball', name: 'Magic 8-ball', prompt: 'Ask the magic 8-ball' });
add({ type: 'plant', id: 'p-lou1', x: 46, y: 30, w: 1, h: 1, solid: true });
add({ type: 'plant', id: 'p-lou2', x: 28, y: 30, w: 1, h: 1, solid: true });
add({ type: 'plant', id: 'p-open1', x: 14, y: 1, w: 1, h: 1, solid: true });
add({ type: 'plant', id: 'p-open2', x: 33, y: 19, w: 1, h: 1, solid: true });

// ---- walls ---------------------------------------------------------------
// 0 floor, 1 wall, 2 glass, 3 void (outside)
export const grid = new Uint8Array(W * H);
const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) grid[y * W + x] = v; };
const hline = (x0, x1, y, v = 1) => { for (let x = x0; x <= x1; x++) set(x, y, v); };
const vline = (x, y0, y1, v = 1) => { for (let y = y0; y <= y1; y++) set(x, y, v); };
const door = (x, y) => set(x, y, 0);

hline(0, W - 1, 0); hline(0, W - 1, H - 1); vline(0, 0, H - 1); vline(W - 1, 0, H - 1);
// Den
hline(0, 13, 13); vline(13, 0, 13); door(13, 10);
// Booth strip
hline(0, 13, 19); vline(13, 13, 19);
door(13, 18); door(6, 19); door(7, 19);
for (const bx of [4, 8]) vline(bx, 13, 17, 2);
hline(1, 3, 17, 2); hline(5, 7, 17, 2); hline(9, 11, 17, 2);
door(2, 17); door(6, 17); door(10, 17);
vline(12, 13, 17, 2);
// Lobby -> rest of office
vline(13, 19, H - 1); door(13, 24); door(13, 25);
// Boardroom (glass)
vline(34, 1, 11, 2); hline(35, W - 2, 11, 2); door(34, 6); door(34, 7);
// Huddle (glass)
vline(34, 11, 20, 2); hline(35, W - 2, 20, 2); door(34, 16);
// Kitchen / lounge separator and the corridor wall above them
hline(13, 33, 20); door(21, 20); door(22, 20); door(29, 20); door(30, 20);
vline(27, 20, H - 1); door(27, 24); door(27, 25);

export const isWall = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return true;
  return grid[y * W + x] !== 0;
};

// Blocked tiles combine walls and solid furniture footprints.
export const blocked = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) blocked[i] = grid[i] ? 1 : 0;
for (const f of FURNITURE) {
  if (!f.solid) continue;
  for (let yy = Math.floor(f.y); yy < Math.ceil(f.y + f.h); yy++)
    for (let xx = Math.floor(f.x); xx < Math.ceil(f.x + f.w); xx++)
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) blocked[yy * W + xx] = 1;
}
export const isBlocked = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return true;
  return blocked[y * W + x] === 1;
};

export const SPAWN = { x: 6.5, y: 26.5 };

// The most specific zone wins (booths sit inside the booth strip).
export function zoneAt(x, y) {
  let best = null;
  for (const z of ZONES) {
    if (x >= z.x0 && x < z.x1 + 1 && y >= z.y0 && y < z.y1 + 1) {
      if (!best || (z.x1 - z.x0) * (z.y1 - z.y0) < (best.x1 - best.x0) * (best.y1 - best.y0)) best = z;
    }
  }
  return best;
}

// Can a listener at b hear a speaker at a? Used for chat and voice.
export function canHear(a, b) {
  const za = zoneAt(a.x, a.y), zb = zoneAt(b.x, b.y);
  if (za && za.kind === 'room') return zb === za;
  if (zb && zb.kind === 'room') return false;
  if (za && za.kind === 'quiet') return zb === za;
  if (zb && zb.kind === 'quiet') return false;
  return Math.hypot(a.x - b.x, a.y - b.y) <= HEAR_RADIUS;
}

// A* over the tile grid with 8-way moves (no corner cutting).
export function findPath(sx, sy, tx, ty) {
  sx = Math.floor(sx); sy = Math.floor(sy); tx = Math.floor(tx); ty = Math.floor(ty);
  if (isBlocked(tx, ty)) {
    // Walk to the nearest open neighbour of a blocked target (e.g. a desk).
    let best = null, bd = Infinity;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (isBlocked(tx + dx, ty + dy)) continue;
      const d = Math.hypot(dx, dy) + Math.hypot(tx + dx - sx, ty + dy - sy) * 0.01;
      if (d < bd) { bd = d; best = [tx + dx, ty + dy]; }
    }
    if (!best) return null;
    [tx, ty] = best;
  }
  const key = (x, y) => y * W + x;
  const g = new Float32Array(W * H).fill(Infinity);
  const came = new Int32Array(W * H).fill(-1);
  const open = [[sx, sy, 0]];
  g[key(sx, sy)] = 0;
  const closed = new Uint8Array(W * H);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][2] < open[bi][2]) bi = i;
    const [x, y] = open.splice(bi, 1)[0];
    const k = key(x, y);
    if (closed[k]) continue;
    closed[k] = 1;
    if (x === tx && y === ty) {
      const path = [];
      let c = k;
      while (c !== -1) { path.push({ x: (c % W) + 0.5, y: Math.floor(c / W) + 0.5 }); c = came[c]; }
      return path.reverse();
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (isBlocked(nx, ny)) continue;
      if (dx && dy && (isBlocked(x + dx, y) || isBlocked(x, y + dy))) continue;
      const nk = key(nx, ny);
      const ng = g[k] + (dx && dy ? 1.414 : 1);
      if (ng < g[nk]) {
        g[nk] = ng; came[nk] = k;
        open.push([nx, ny, ng + Math.hypot(tx - nx, ty - ny)]);
      }
    }
  }
  return null;
}

export function nearestInteractable(x, y, maxDist = 1.6) {
  let best = null, bd = maxDist;
  for (const f of FURNITURE) {
    if (!f.interact && !f.seat) continue;
    const cx = Math.max(f.x, Math.min(x, f.x + f.w));
    const cy = Math.max(f.y, Math.min(y, f.y + f.h));
    const d = Math.hypot(cx - x, cy - y);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

// The plugin-run objects, for the server (one entity each) and the client.
export const PLUGIN_OBJECTS = FURNITURE.filter((f) => f.plugin);
