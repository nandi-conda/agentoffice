// Vector renderer. Everything except the character sprites is drawn as
// shapes every frame, so the office stays sharp at any zoom and pixel
// density. Sprites are drawn at whole-number scale with smoothing off.

import { W, H, ZONES, FURNITURE, grid, zoneAt } from './map.js';
import { CORE_W, CORE_H } from './wing.js';
import { ROOMS, roomStatus, fmtTime } from './rooms.js';
import { WALL_H, daylight, markedName, statusColor, colorFor, roundRect, wrapText } from './style.js';
import { roleBadge } from './roles.js';
import { WALK } from './sprites.js';

const FLOORS = {
  wood: { base: '#ead7bb', line: 'rgba(120,80,40,0.10)', kind: 'planks' },
  carpetBlue: { base: '#c9d4e6', line: 'rgba(30,58,138,0.07)', kind: 'dots' },
  carpetGreen: { base: '#cfe0cf', line: 'rgba(20,83,45,0.07)', kind: 'dots' },
  carpetPlum: { base: '#ddcfe0', line: 'rgba(88,28,135,0.08)', kind: 'dots' },
  tile: { base: '#f3f4f6', alt: '#e5e7eb', kind: 'checker' },
  stone: { base: '#e9e6e1', line: 'rgba(87,83,78,0.12)', kind: 'grid' },
  rug: { base: '#e6d8c3', line: 'rgba(120,80,40,0.09)', kind: 'planks' },
  carpetTeal: { base: '#c7e3df', line: 'rgba(17,94,89,0.08)', kind: 'dots' },
  carpetAmber: { base: '#ecdcbc', line: 'rgba(146,64,14,0.08)', kind: 'dots' },
  moss: { base: '#d3e2c4', line: 'rgba(54,83,20,0.10)', kind: 'grid' },
};

const HEIGHTS = {
  desk: 0.5, chair: 0.32, stool: 0.3, table: 0.5, roundtable: 0.5, sofa: 0.45, counter: 0.7,
  coffee: 0.95, fridge: 1.45, bookshelf: 1.5, arcade: 1.35, plant: 0.4, whiteboard: 1.25,
  reception: 0.8, pomodoro: 1.5, sign: 0.9, jukebox: 1.3, vending: 1.6, eightball: 0.95, kiosk: 1.35, rally: 1.5, sprite: 1, screen: 1.2, panel: 0.5, board: 1.3, coffeetable: 0.3, beanbag: 0.35, rug: 0,
};

// How tall an object stands: an uploaded one with its own pixels is as tall
// as its sprite (16 rows to a tile).
const heightOf = (f) => (f.type === 'sprite' && f.sprite ? f.sprite.rows.length / 16 : HEIGHTS[f.type]);

// '#a78bfa' -> [167, 139, 250] (null when it isn't a colour).
function rgb(hex) {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})(?:[0-9a-f]{1,2})?$/i.exec(hex || '');
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
// A darker shade, for the side of a cabinet.
const shade = (hex, k = 0.62) => { const c = rgb(hex); return c ? `rgb(${c.map((v) => Math.round(v * k)).join(',')})` : '#1f2937'; };
// The colour as a light: see-through.
const glowOf = (hex, a) => { const c = rgb(hex); return c ? `rgba(${c.join(',')},${a})` : `rgba(167,139,250,${a})`; };

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = 1, vw = 0, vh = 0;
  const view = { T: 32, k: 1, ox: 0, oy: 0 };

  function resize() {
    // Phones at 3x spend most of their battery on fill; 2x looks the same at arm's length.
    dpr = Math.min(window.devicePixelRatio || 1, matchMedia('(pointer: coarse)').matches ? 2 : 4);
    vw = canvas.clientWidth; vh = canvas.clientHeight;
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
  }

  // The zoom (k, device pixels per sprite pixel) that fits the whole office
  // in the map region; read fresh each time since the office can grow.
  const fitZoom = () => (dpr * Math.min(vw / (W + 2), vh / (H + 2))) / 32;

  const S = (v) => v * view.T;

  function setCamera(cam, k) {
    view.k = k;
    view.T = 32 * (k / dpr);
    // No clamping: the view is recomputed for whatever zoom and camera you pick.
    // Snap the camera offset to device pixels to avoid shimmering.
    view.ox = Math.round((vw / 2 - cam.x * view.T) * dpr) / dpr;
    view.oy = Math.round((vh / 2 - cam.y * view.T) * dpr) / dpr;
  }

  const toScreen = (x, y) => ({ x: x * view.T + view.ox, y: y * view.T + view.oy });
  const toWorld = (sx, sy) => ({ x: (sx - view.ox) / view.T, y: (sy - view.oy) / view.T });

  // ---- primitives (world-space, in tiles) -----------------------------
  function box(x, y, w, h, hgt, top, front, r = 0.08) {
    // soft contact shadow
    ctx.fillStyle = 'rgba(30,27,24,0.13)';
    roundRect(ctx, S(x + 0.06), S(y + h - 0.12), S(w), S(0.26), S(0.12)); ctx.fill();
    ctx.fillStyle = front;
    roundRect(ctx, S(x), S(y + h - hgt - 0.02), S(w), S(hgt + 0.02), S(r)); ctx.fill();
    ctx.fillStyle = top;
    roundRect(ctx, S(x), S(y - hgt), S(w), S(h), S(r)); ctx.fill();
  }

  function ellipse(cx, cy, rx, ry, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.ellipse(S(cx), S(cy), S(rx), S(ry), 0, 0, Math.PI * 2); ctx.fill();
  }

  // ---- floors ------------------------------------------------------------
  function drawFloors(vis, freeq = {}) {
    // The core office's footing; the wing's halls and rooms bring their own
    // floors, and the rest is outside.
    ctx.fillStyle = '#d9d4cc';
    ctx.fillRect(S(0), S(0), S(CORE_W), S(CORE_H));
    for (const z of ZONES) {
      if (z.kind === 'room' && z.id.startsWith('booth')) continue;
      floorRect(z, vis);
    }
    for (const z of ZONES) if (z.id.startsWith('booth')) floorRect(z, vis);
  }

  function floorRect(z, vis) {
    const f = FLOORS[z.floor] || FLOORS.wood;
    const x0 = z.x0, y0 = z.y0, w = z.x1 - z.x0 + 1, h = z.y1 - z.y0 + 1;
    if (x0 > vis.x1 || x0 + w < vis.x0 || y0 > vis.y1 || y0 + h < vis.y0) return;
    ctx.fillStyle = f.base;
    ctx.fillRect(S(x0), S(y0), S(w), S(h));
    ctx.save();
    ctx.beginPath(); ctx.rect(S(x0), S(y0), S(w), S(h)); ctx.clip();
    const ys = Math.max(y0, Math.floor(vis.y0)), ye = Math.min(y0 + h, Math.ceil(vis.y1));
    const xs = Math.max(x0, Math.floor(vis.x0)), xe = Math.min(x0 + w, Math.ceil(vis.x1));
    if (f.kind === 'planks') {
      ctx.strokeStyle = f.line; ctx.lineWidth = Math.max(1, S(0.03));
      ctx.beginPath();
      for (let y = ys; y < ye; y += 0.5) {
        ctx.moveTo(S(xs), S(y)); ctx.lineTo(S(xe), S(y));
        const off = ((y * 2) % 3) * 0.7;
        for (let x = xs - 3 + off; x < xe; x += 2.1) { ctx.moveTo(S(x), S(y)); ctx.lineTo(S(x), S(y + 0.5)); }
      }
      ctx.stroke();
    } else if (f.kind === 'dots') {
      ctx.fillStyle = f.line;
      for (let y = ys; y < ye; y += 0.5) for (let x = xs + ((y * 2) % 2) * 0.25; x < xe; x += 0.5) {
        ctx.beginPath(); ctx.arc(S(x + 0.12), S(y + 0.25), S(0.05), 0, 7); ctx.fill();
      }
    } else if (f.kind === 'checker') {
      ctx.fillStyle = f.alt;
      for (let y = ys; y < ye; y++) for (let x = xs; x < xe; x++) if ((x + y) % 2) ctx.fillRect(S(x), S(y), S(1), S(1));
    } else if (f.kind === 'grid') {
      ctx.strokeStyle = f.line; ctx.lineWidth = Math.max(1, S(0.025));
      ctx.beginPath();
      for (let y = ys - (ys % 2); y < ye; y += 2) { ctx.moveTo(S(xs), S(y)); ctx.lineTo(S(xe), S(y)); }
      for (let x = xs - (xs % 2); x < xe; x += 2) { ctx.moveTo(S(x), S(ys)); ctx.lineTo(S(x), S(ye)); }
      ctx.stroke();
    }
    // inner edge shading gives each room some depth
    const g = ctx.createLinearGradient(0, S(y0), 0, S(y0 + 1.2));
    g.addColorStop(0, 'rgba(0,0,0,0.10)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(S(x0), S(y0), S(w), S(1.2));
    ctx.restore();
  }

  // ---- walls -------------------------------------------------------------
  // Walls and glass; void (3, outside the building) is neither floor nor wall.
  const isW = (x, y) => x >= 0 && y >= 0 && x < W && y < H && (grid[y * W + x] === 1 || grid[y * W + x] === 2);
  const isVoid = (x, y) => x < 0 || y < 0 || x >= W || y >= H || grid[y * W + x] === 3;

  // Walls are drawn thin (cutaway style): a dark cap along the wall line and
  // a lit face wherever the wall isn't continued toward the camera.
  const T0 = 0.32, T1 = 0.68;
  function drawWall(x, y, light) {
    const v = grid[y * W + x];
    const below = isW(x, y + 1);
    const l = isW(x - 1, y) ? 0 : T0, r = isW(x + 1, y) ? 1 : T1;
    const t = isW(x, y - 1) ? 0 : T0, b = below ? 1 : T1;
    const outer = isVoid(x, y - 1) || isVoid(x, y + 1) || isVoid(x - 1, y) || isVoid(x + 1, y);
    if (!below) {
      const fy = y + T1 - WALL_H;
      if (v === 2) {
        ctx.fillStyle = 'rgba(186,230,253,0.30)';
        ctx.fillRect(S(x + l), S(fy), S(r - l), S(WALL_H));
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        if ((x + y) % 2 === 0) ctx.fillRect(S(x + 0.2), S(fy + 0.12), S(0.06), S(WALL_H - 0.25));
        ctx.fillStyle = 'rgba(71,85,105,0.7)';
        ctx.fillRect(S(x + l), S(y + T1 - 0.05), S(r - l), S(0.05));
      } else {
        const g = ctx.createLinearGradient(0, S(fy), 0, S(fy + WALL_H));
        g.addColorStop(0, '#f3efe8'); g.addColorStop(1, '#dcd4c8');
        ctx.fillStyle = g;
        ctx.fillRect(S(x + l), S(fy), S(r - l), S(WALL_H));
        ctx.fillStyle = '#b6aa99';
        ctx.fillRect(S(x + l), S(y + T1 - 0.09), S(r - l), S(0.09));
        if (y === 0 && x > 0 && x < W - 1 && x % 3 !== 0 && !isW(x, 1)) drawWindow(x, y, light);
      }
    }
    ctx.fillStyle = v === 2 ? '#8494a8' : outer ? '#3f3a36' : '#57534e';
    ctx.fillRect(S(x + T0), S(y + T0 - WALL_H), S(T1 - T0), S(T1 - T0));
    if (l === 0) ctx.fillRect(S(x), S(y + T0 - WALL_H), S(T1), S(T1 - T0));
    if (r === 1) ctx.fillRect(S(x + T0), S(y + T0 - WALL_H), S(1 - T0), S(T1 - T0));
    if (t === 0) ctx.fillRect(S(x + T0), S(y - WALL_H), S(T1 - T0), S(T1));
    if (b === 1) ctx.fillRect(S(x + T0), S(y + T0 - WALL_H), S(T1 - T0), S(1 - T0));
  }

  function drawWindow(x, y, light) {
    const wx = S(x + 0.1), wy = S(y + T1 - WALL_H + 0.14), ww = S(0.8), wh = S(WALL_H - 0.36);
    const g = ctx.createLinearGradient(0, wy, 0, wy + wh);
    g.addColorStop(0, light.sky[0]); g.addColorStop(1, light.sky[1]);
    ctx.fillStyle = '#8b7d6b'; ctx.fillRect(wx - S(0.04), wy - S(0.04), ww + S(0.08), wh + S(0.08));
    ctx.fillStyle = g; ctx.fillRect(wx, wy, ww, wh);
    if (light.night) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      const s = (x * 7919) % 13;
      ctx.fillRect(wx + ww * (s / 13), wy + wh * 0.3, Math.max(1, S(0.03)), Math.max(1, S(0.03)));
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.moveTo(wx, wy + wh * 0.7); ctx.lineTo(wx + ww * 0.5, wy); ctx.lineTo(wx + ww * 0.7, wy); ctx.lineTo(wx, wy + wh); ctx.fill();
    }
    ctx.fillStyle = '#8b7d6b'; ctx.fillRect(wx + ww / 2 - S(0.02), wy, S(0.04), wh);
  }

  // ---- furniture ---------------------------------------------------------
  function drawFurniture(f, st) {
    const hgt = heightOf(f) ?? 0.5;
    const { x, y, w, h } = f;
    switch (f.type) {
      case 'desk': return drawDesk(f, st);
      case 'chair': return drawChairSeat(f);
      case 'stool':
        ellipse(x + 0.5, y + 0.62, 0.34, 0.14, 'rgba(0,0,0,0.12)');
        ellipse(x + 0.5, y + 0.52, 0.06, 0.2, '#57534e');
        ellipse(x + 0.5, y + 0.3, 0.32, 0.2, '#e76f51');
        ellipse(x + 0.5, y + 0.26, 0.26, 0.15, '#f4a261');
        return;
      case 'table':
        box(x, y, w, h, hgt, '#c49a6c', '#8a6240', 0.25);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        roundRect(ctx, S(x + 0.2), S(y - hgt + 0.15), S(w - 0.4), S(0.2), S(0.1)); ctx.fill();
        return;
      case 'roundtable':
        ellipse(x + w / 2, y + h - 0.1, w / 2, 0.22, 'rgba(0,0,0,0.12)');
        ellipse(x + w / 2, y + h / 2 + 0.05, w / 2 - 0.02, h / 2 - 0.02, '#8a6240');
        ellipse(x + w / 2, y + h / 2 - hgt + 0.05, w / 2, h / 2, '#c49a6c');
        ellipse(x + w / 2 - 0.2, y + h / 2 - hgt - 0.1, w / 4, h / 6, 'rgba(255,255,255,0.12)');
        if (f.id.startsWith('k-table')) { drawMug(x + 0.6, y + 0.7 - hgt, '#e11d48'); drawMug(x + 1.3, y + 1.1 - hgt, '#0ea5e9'); }
        return;
      case 'coffeetable':
        box(x, y, w, h, hgt, '#9c6644', '#6f4518', 0.15);
        drawMug(x + 0.5, y + 0.6 - hgt, '#f59e0b');
        ctx.fillStyle = '#334155'; roundRect(ctx, S(x + 1), S(y + 0.8 - hgt), S(0.6), S(0.4), S(0.05)); ctx.fill();
        return;
      case 'sofa': return drawSofa(f);
      case 'beanbag':
        ellipse(x + 0.5, y + 0.75, 0.48, 0.18, 'rgba(0,0,0,0.12)');
        ellipse(x + 0.5, y + 0.5, 0.48, 0.38, f.id === 'bean1' ? '#e76f51' : '#2a9d8f');
        ellipse(x + 0.4, y + 0.35, 0.22, 0.14, 'rgba(255,255,255,0.18)');
        return;
      case 'plant': return drawPlant(f, st);
      case 'bookshelf': return drawShelf(f);
      case 'counter': return drawCounter(f);
      case 'coffee': return drawCoffee(f, st);
      case 'fridge':
        box(x + 0.1, y, w - 0.2, h, hgt, '#f8fafc', '#e2e8f0', 0.12);
        ctx.fillStyle = '#cbd5e1'; ctx.fillRect(S(x + 0.1), S(y + h - hgt + 0.55), S(w - 0.2), S(0.03));
        ctx.fillStyle = '#94a3b8'; roundRect(ctx, S(x + 0.25), S(y + h - hgt + 0.2), S(0.06), S(0.3), S(0.03)); ctx.fill();
        roundRect(ctx, S(x + 0.25), S(y + h - hgt + 0.7), S(0.06), S(0.4), S(0.03)); ctx.fill();
        // fridge magnets
        for (const [mx, my, c] of [[1.1, 0.8, '#ef4444'], [1.4, 0.95, '#22c55e'], [1.2, 1.15, '#3b82f6']]) {
          ctx.fillStyle = c; ctx.beginPath(); ctx.arc(S(x + mx), S(y + h - hgt + my), S(0.05), 0, 7); ctx.fill();
        }
        return;
      case 'arcade': return drawArcade(f, st);
      case 'jukebox': return drawJukebox(f, st);
      case 'vending': return drawVending(f, st);
      case 'eightball': return drawEightBall(f, st);
      case 'kiosk': return drawKiosk(f, st);
      case 'rally': return drawRally(f, st);
      case 'sprite': return drawSprite(f, st);
      case 'whiteboard': return drawWhiteboard(f, st);
      case 'board': return drawNoticeboard(f, st);
      case 'reception': return drawReception(f, st);
      case 'pomodoro': return drawPomodoro(f, st);
      case 'screen': return drawScreen(f, st);
      case 'panel': return drawPanel(f, st);
      case 'rug': return drawRug(f);
      case 'sign': return drawSign(f, st);
    }
  }

  // A room's wall screen: a live screen share for people in the room,
  // otherwise the current booking (or "free").
  function drawScreen(f, st) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.screen;
    ctx.fillStyle = '#334155'; ctx.fillRect(S(x + w / 2 - 0.04), S(y + h - 0.6), S(0.08), S(0.6));
    box(x, y + 0.6, w, 0.15, 0.12, '#475569', '#334155', 0.04);
    ctx.fillStyle = '#0f172a'; roundRect(ctx, S(x - 0.1), S(y + h - hgt - 0.1), S(w + 0.2), S(0.95), S(0.06)); ctx.fill();
    const sx = x - 0.02, sy = y + h - hgt - 0.02, sw = w + 0.04, sh = 0.79;
    const feed = st.screenFeed?.zone === f.zone ? st.screenFeed.video : null;
    if (feed && feed.readyState >= 2 && feed.videoWidth) {
      ctx.fillStyle = '#000'; ctx.fillRect(S(sx), S(sy), S(sw), S(sh));
      const r = Math.min(sw / feed.videoWidth, sh / feed.videoHeight);
      const dw = feed.videoWidth * r, dh = feed.videoHeight * r;
      ctx.drawImage(feed, S(sx + (sw - dw) / 2), S(sy + (sh - dh) / 2), S(dw), S(dh));
      st.lights.push({ x: x + w / 2, y: y + h + 0.4, r: 2, c: 'rgba(191,219,254,0.5)' });
      return;
    }
    const g = ctx.createLinearGradient(S(x), S(y), S(x + w), S(y + 1));
    g.addColorStop(0, '#1e3a8a'); g.addColorStop(1, '#7c3aed');
    ctx.fillStyle = g; ctx.fillRect(S(sx), S(sy), S(sw), S(sh));
    const { current, next } = f.zone ? roomStatus(st.bookings || [], f.zone, st.serverNow()) : {};
    const lines = current ? [current.title, `until ${fmtTime(current.end)}`] : next ? ['free', `next ${fmtTime(next.start)}`] : ['free'];
    ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.textAlign = 'center';
    ctx.font = `600 ${S(0.16)}px Inter, system-ui`;
    ctx.fillText(clipText(lines[0], S(w - 0.1)), S(x + w / 2), S(sy + (lines[1] ? 0.32 : 0.45)));
    if (lines[1]) { ctx.font = `500 ${S(0.12)}px Inter, system-ui`; ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fillText(lines[1], S(x + w / 2), S(sy + 0.55)); }
    ctx.textAlign = 'left';
  }

  const STATE_COLOR = { free: '#22c55e', soon: '#f59e0b', busy: '#ef4444' };

  // Booking panel: a little tablet hung on the wall by the door.
  function drawPanel(f, st) {
    const { state } = roomStatus(st.bookings || [], f.zone, st.serverNow());
    const cx = f.x + 0.5, top = f.y + 0.68 - 1.15;
    // An uploaded one stands on a post of its own instead of hanging by a door.
    if (f.uploaded) { ctx.fillStyle = '#475569'; ctx.fillRect(S(cx - 0.03), S(top + 0.3), S(0.06), S(f.y + 0.9 - top - 0.3)); ellipse(cx, f.y + 0.9, 0.18, 0.06, '#475569'); }
    ctx.fillStyle = '#1f2937'; roundRect(ctx, S(cx - 0.2), S(top), S(0.4), S(0.32), S(0.05)); ctx.fill();
    ctx.fillStyle = STATE_COLOR[state]; roundRect(ctx, S(cx - 0.16), S(top + 0.04), S(0.32), S(0.24), S(0.03)); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(S(cx - 0.1), S(top + 0.1), S(0.2), S(0.03));
    ctx.fillRect(S(cx - 0.1), S(top + 0.16), S(0.13), S(0.03));
    st.lights.push({ x: cx, y: top + 0.4, r: 0.7, c: state === 'busy' ? 'rgba(239,68,68,0.45)' : state === 'soon' ? 'rgba(245,158,11,0.45)' : 'rgba(34,197,94,0.4)' });
  }


  function drawMug(x, y, c) {
    ctx.fillStyle = c; roundRect(ctx, S(x - 0.08), S(y - 0.1), S(0.16), S(0.18), S(0.03)); ctx.fill();
    ctx.strokeStyle = c; ctx.lineWidth = S(0.03);
    ctx.beginPath(); ctx.arc(S(x + 0.1), S(y), S(0.05), -1.4, 1.4); ctx.stroke();
    ctx.fillStyle = '#3f2a1d'; ctx.beginPath(); ctx.ellipse(S(x), S(y - 0.1), S(0.07), S(0.025), 0, 0, 7); ctx.fill();
  }

  function drawDesk(f, st) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.desk;
    const claim = st.desks[f.id];
    const owner = claim && st.ownerOnline(claim.owner);
    box(x + 0.04, y, w - 0.08, h, hgt, '#f5f3ef', '#b8ab9a', 0.06);
    if (claim) {
      ctx.fillStyle = colorFor(claim.owner);
      ctx.fillRect(S(x + 0.04), S(y + h - hgt + 0.04), S(w - 0.08), S(0.05));
    }
    const top = y - hgt;
    const lit = st.light.night || owner;
    if (f.facing === 'up') {
      // monitor faces the camera
      ctx.fillStyle = '#334155'; ctx.fillRect(S(x + 0.95), S(top + 0.35), S(0.1), S(0.18));
      ctx.fillStyle = '#1f2937'; roundRect(ctx, S(x + 0.45), S(top - 0.25), S(1.1), S(0.62), S(0.05)); ctx.fill();
      ctx.fillStyle = owner ? '#0b1220' : '#111827';
      ctx.fillRect(S(x + 0.5), S(top - 0.2), S(1.0), S(0.5));
      const use = st.deskUse?.[f.id];
      const feed = use?.video;
      if (feed && feed.readyState >= 2 && feed.videoWidth) {
        // a screen shared to this desk's monitor
        ctx.fillStyle = '#000'; ctx.fillRect(S(x + 0.5), S(top - 0.2), S(1.0), S(0.5));
        const r = Math.min(1.0 / feed.videoWidth, 0.5 / feed.videoHeight);
        const dw = feed.videoWidth * r, dh = feed.videoHeight * r;
        ctx.drawImage(feed, S(x + 0.5 + (1.0 - dw) / 2), S(top - 0.2 + (0.5 - dh) / 2), S(dw), S(dh));
        st.lights.push({ x: x + 1, y: y + 0.2, r: 1.4, c: 'rgba(191,219,254,0.45)' });
      } else if (use?.pc) {
        // the workstation is up: a little desktop with windows
        const g = ctx.createLinearGradient(S(x + 0.5), S(top - 0.2), S(x + 1.5), S(top + 0.3));
        g.addColorStop(0, '#1e3a8a'); g.addColorStop(1, '#7c3aed');
        ctx.fillStyle = g; ctx.fillRect(S(x + 0.5), S(top - 0.2), S(1.0), S(0.5));
        ctx.fillStyle = 'rgba(255,252,247,0.9)';
        ctx.fillRect(S(x + 0.58), S(top - 0.14), S(0.48), S(0.3));
        ctx.fillRect(S(x + 1.0), S(top - 0.06), S(0.42), S(0.26));
        ctx.fillStyle = use.color || '#38bdf8';
        ctx.fillRect(S(x + 0.58), S(top - 0.14), S(0.48), S(0.05));
        ctx.fillRect(S(x + 1.0), S(top - 0.06), S(0.42), S(0.05));
        ctx.fillStyle = 'rgba(15,23,42,0.7)'; ctx.fillRect(S(x + 0.5), S(top + 0.25), S(1.0), S(0.05));
        st.lights.push({ x: x + 1, y: y + 0.2, r: 1.2, c: 'rgba(167,139,250,0.4)' });
      } else if (owner) {
        const t = st.time / 1000;
        const cols = ['#38bdf8', '#a78bfa', '#4ade80', '#f472b6', '#facc15'];
        for (let i = 0; i < 5; i++) {
          const len = 0.25 + ((Math.sin(i * 3.1 + Math.floor(t * 0.5 + i)) + 1) / 2) * 0.55;
          ctx.fillStyle = cols[(i + (claim.owner.length)) % cols.length];
          ctx.fillRect(S(x + 0.55 + (i % 2) * 0.08), S(top - 0.15 + i * 0.09), S(len), S(0.04));
        }
      }
      // keyboard
      ctx.fillStyle = '#d6d3d1'; roundRect(ctx, S(x + 0.6), S(top + 0.6), S(0.8), S(0.2), S(0.03)); ctx.fill();
    } else {
      // monitor back
      ctx.fillStyle = '#334155'; ctx.fillRect(S(x + 0.95), S(top + 0.5), S(0.1), S(0.2));
      ctx.fillStyle = '#475569'; roundRect(ctx, S(x + 0.45), S(top + 0.35), S(1.1), S(0.45), S(0.05)); ctx.fill();
      ctx.fillStyle = '#64748b'; ctx.beginPath(); ctx.arc(S(x + 1), S(top + 0.57), S(0.05), 0, 7); ctx.fill();
      // a computer in use glows on the far side
      const use = st.deskUse?.[f.id];
      if (use?.pc || use?.video) {
        ctx.fillStyle = use.video ? 'rgba(191,219,254,0.85)' : 'rgba(167,139,250,0.8)';
        ctx.fillRect(S(x + 0.47), S(top + 0.33), S(1.06), S(0.04));
        st.lights.push({ x: x + 1, y: y + 1.1, r: 1.2, c: use.video ? 'rgba(191,219,254,0.4)' : 'rgba(167,139,250,0.35)' });
      }
      ctx.fillStyle = '#d6d3d1'; roundRect(ctx, S(x + 0.6), S(top + 0.1), S(0.8), S(0.18), S(0.03)); ctx.fill();
    }
    // desk props, picked per desk so the floor feels lived in
    const r = (f.id.charCodeAt(f.id.length - 1) + f.id.length) % 4;
    if (r === 0) drawMug(x + 1.75, top + 0.55, '#ef4444');
    if (r === 1) { ellipse(x + 0.22, top + 0.55, 0.12, 0.08, '#a16207'); ellipse(x + 0.22, top + 0.42, 0.14, 0.12, '#16a34a'); }
    if (r === 2) { ctx.fillStyle = '#fde68a'; ctx.fillRect(S(x + 1.62), S(top + 0.45), S(0.22), S(0.22)); }
    // desk lamp
    if (r !== 3) {
      ctx.strokeStyle = '#1f2937'; ctx.lineWidth = S(0.035);
      ctx.beginPath(); ctx.moveTo(S(x + 0.2), S(top + 0.3)); ctx.lineTo(S(x + 0.28), S(top - 0.05)); ctx.lineTo(S(x + 0.42), S(top + 0.02)); ctx.stroke();
      ctx.fillStyle = lit ? '#fde047' : '#374151';
      ctx.beginPath(); ctx.ellipse(S(x + 0.44), S(top + 0.06), S(0.08), S(0.05), 0.5, 0, 7); ctx.fill();
      if (lit) st.lights.push({ x: x + 0.45, y: y + 0.4, r: 1.6, c: 'rgba(253,224,71,0.55)' });
    }
    if (claim) {
      // nameplate on the desk front
      ctx.font = `600 ${Math.max(7, S(0.17))}px Inter, system-ui`;
      ctx.fillStyle = 'rgba(41,37,36,0.75)';
      ctx.textAlign = 'center';
      ctx.fillText(claim.name.slice(0, 14), S(x + w / 2), S(y + h - 0.12));
      ctx.textAlign = 'left';
    }
  }

  function drawChairSeat(f) {
    const { x, y } = f;
    ellipse(x + 0.5, y + 0.78, 0.32, 0.12, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = '#1f2937'; ctx.fillRect(S(x + 0.46), S(y + 0.45), S(0.08), S(0.3));
    ctx.fillStyle = '#334155';
    roundRect(ctx, S(x + 0.15), S(y + 0.18), S(0.7), S(0.42), S(0.14)); ctx.fill();
    ctx.fillStyle = '#475569';
    roundRect(ctx, S(x + 0.18), S(y + 0.15), S(0.64), S(0.34), S(0.12)); ctx.fill();
  }

  function drawChairBack(f) {
    const { x, y } = f;
    ctx.fillStyle = '#1e293b';
    if (f.facing === 'up') { roundRect(ctx, S(x + 0.14), S(y + 0.25), S(0.72), S(0.55), S(0.12)); ctx.fill(); }
    else if (f.facing === 'down') { roundRect(ctx, S(x + 0.14), S(y - 0.35), S(0.72), S(0.55), S(0.12)); ctx.fill(); }
    else {
      const bx = f.facing === 'left' ? x + 0.7 : x + 0.12;
      roundRect(ctx, S(bx), S(y - 0.2), S(0.18), S(0.75), S(0.08)); ctx.fill();
    }
  }

  function drawSofa(f) {
    const { x, y, w, h } = f;
    const c = f.color || (f.id === 'lobby-sofa' ? ['#0f766e', '#115e59', '#14b8a6'] : ['#4f46e5', '#3730a3', '#6366f1']);
    ellipse(x + w / 2, y + h + 0.05, w / 2, 0.2, 'rgba(0,0,0,0.12)');
    if (f.facing === 'up') {
      // seen from behind: tall back at the front
      box(x, y - 0.1, w, h, 0.4, c[2], c[1], 0.15);
      box(x, y + 0.3, w, 0.7, 0.75, c[0], c[1], 0.18);
    } else {
      box(x, y - 0.25, w, 0.45, 0.85, c[0], c[1], 0.15);
      box(x + 0.05, y + 0.15, w - 0.1, 0.85, 0.42, c[2], c[1], 0.15);
      for (let i = 1; i < w; i++) { ctx.fillStyle = c[1]; ctx.fillRect(S(x + i - 0.01), S(y + 0.15 - 0.42), S(0.02), S(0.8)); }
      box(x - 0.08, y - 0.05, 0.3, 1.05, 0.6, c[0], c[1], 0.12);
      box(x + w - 0.22, y - 0.05, 0.3, 1.05, 0.6, c[0], c[1], 0.12);
    }
  }

  function drawPlant(f, st) {
    const cx = f.x + 0.5, base = f.y + 0.85;
    ellipse(cx, base, 0.32, 0.12, 'rgba(0,0,0,0.15)');
    ctx.fillStyle = '#c2703d';
    ctx.beginPath();
    ctx.moveTo(S(cx - 0.28), S(base - 0.45)); ctx.lineTo(S(cx + 0.28), S(base - 0.45));
    ctx.lineTo(S(cx + 0.2), S(base)); ctx.lineTo(S(cx - 0.2), S(base)); ctx.fill();
    ctx.fillStyle = '#a65a2e'; ctx.fillRect(S(cx - 0.3), S(base - 0.5), S(0.6), S(0.08));
    const sway = Math.sin(st.time / 1400 + f.x * 1.7) * 0.04;
    const leaves = [[-0.2, -0.85, 0.26, '#15803d'], [0.2, -0.9, 0.25, '#16a34a'], [0, -1.15, 0.3, '#22c55e'], [-0.12, -1.35, 0.2, '#4ade80'], [0.15, -1.3, 0.18, '#22c55e']];
    for (const [dx, dy, r, c] of leaves) {
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.ellipse(S(cx + dx + sway * (-dy)), S(base + dy), S(r), S(r * 0.8), dx, 0, 7); ctx.fill();
    }
  }

  function drawShelf(f) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.bookshelf;
    box(x, y, w, h, hgt, '#8b5e3c', '#6b4423', 0.05);
    const fy = y + h - hgt;
    const cols = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#0ea5e9', '#f97316', '#84cc16'];
    for (let row = 0; row < 3; row++) {
      const ry = fy + 0.1 + row * 0.47;
      ctx.fillStyle = '#4a2f18'; ctx.fillRect(S(x + 0.06), S(ry), S(w - 0.12), S(0.4));
      let bx = x + 0.1, i = row * 3 + (x | 0);
      while (bx < x + w - 0.2) {
        const bw = 0.09 + ((i * 37) % 5) * 0.025, bh = 0.26 + ((i * 13) % 4) * 0.03;
        ctx.fillStyle = cols[i % cols.length];
        if ((i * 7) % 11 === 0) {
          ctx.save(); ctx.translate(S(bx), S(ry + 0.4)); ctx.rotate(-0.25); ctx.fillRect(0, -S(bh), S(bw), S(bh)); ctx.restore();
          bx += 0.12;
        } else ctx.fillRect(S(bx), S(ry + 0.4 - bh), S(bw), S(bh));
        bx += bw + 0.015; i++;
      }
    }
  }

  function drawCounter(f) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.counter;
    box(x, y, w, h, hgt, '#eef2f5', '#5b6b7f', 0.04);
    for (let i = 0; i < w; i++) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = Math.max(1, S(0.02));
      ctx.strokeRect(S(x + i + 0.08), S(y + h - hgt + 0.1), S(0.84), S(hgt - 0.2));
      ctx.fillStyle = '#cbd5e1'; ctx.fillRect(S(x + i + 0.45), S(y + h - hgt + 0.18), S(0.1), S(0.03));
    }
    // sink + tap
    ctx.fillStyle = '#cbd5e1'; roundRect(ctx, S(x + 2.2), S(y - hgt + 0.25), S(1.2), S(0.55), S(0.1)); ctx.fill();
    ctx.fillStyle = '#94a3b8'; ctx.fillRect(S(x + 2.75), S(y - hgt + 0.08), S(0.1), S(0.25));
    // fruit bowl
    ellipse(x + 5.2, y - hgt + 0.55, 0.35, 0.16, '#d97706');
    for (const [dx, c] of [[-0.15, '#ef4444'], [0.05, '#facc15'], [0.2, '#84cc16']]) ellipse(x + 5.2 + dx, y - hgt + 0.43, 0.1, 0.1, c);
  }

  function drawCoffee(f, st) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.coffee;
    box(x + 0.08, y, w - 0.16, h, hgt, '#27272a', '#18181b', 0.1);
    const fy = y + h - hgt;
    ctx.fillStyle = '#3f3f46'; roundRect(ctx, S(x + 0.2), S(fy + 0.1), S(0.6), S(0.3), S(0.04)); ctx.fill();
    ctx.fillStyle = '#22d3ee'; ctx.fillRect(S(x + 0.25), S(fy + 0.15), S(0.25), S(0.08));
    ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(S(x + 0.68), S(fy + 0.2), S(0.04), 0, 7); ctx.fill();
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(S(x + 0.3), S(fy + 0.5), S(0.4), S(0.35));
    drawMug(x + 0.5, fy + 0.82, '#f8fafc');
    if (st.time - st.lastCoffee < 6000 || st.light.morning) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = S(0.03);
      for (let i = 0; i < 2; i++) {
        const t = st.time / 600 + i;
        ctx.beginPath();
        ctx.moveTo(S(x + 0.45 + i * 0.1), S(fy + 0.7));
        ctx.bezierCurveTo(S(x + 0.35 + Math.sin(t) * 0.1), S(fy + 0.5), S(x + 0.6 + Math.cos(t) * 0.1), S(fy + 0.35), S(x + 0.5), S(fy + 0.15));
        ctx.stroke();
      }
    }
  }

  function drawArcade(f, st) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.arcade;
    // The Lounge's first cabinet is violet; any other is its glow colour.
    const body = f.id === 'arcade' ? '#7c3aed' : f.glow || '#db2777';
    const c = [body, shade(body, 0.7)];
    box(x + 0.06, y, w - 0.12, h, hgt, c[0], c[1], 0.08);
    const fy = y + h - hgt;
    ctx.fillStyle = '#fde047'; ctx.fillRect(S(x + 0.12), S(fy + 0.06), S(0.76), S(0.14));
    ctx.fillStyle = '#0b1020'; roundRect(ctx, S(x + 0.14), S(fy + 0.26), S(0.72), S(0.48), S(0.05)); ctx.fill();
    const t = st.time / 300;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = ['#4ade80', '#f472b6', '#38bdf8', '#facc15'][i];
      ctx.fillRect(S(x + 0.2 + ((t + i * 0.13) % 0.55)), S(fy + 0.32 + i * 0.1), S(0.07), S(0.07));
    }
    ctx.fillStyle = '#1f2937'; ctx.fillRect(S(x + 0.1), S(fy + 0.8), S(0.8), S(0.18));
    ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(S(x + 0.35), S(fy + 0.88), S(0.05), 0, 7); ctx.fill();
    ctx.fillStyle = '#3b82f6'; ctx.beginPath(); ctx.arc(S(x + 0.6), S(fy + 0.88), S(0.05), 0, 7); ctx.fill();
    st.lights.push({ x: x + 0.5, y: y + 1.2, r: 1.4, c: glowOf(body, 0.5) });
  }

  // ---- plugin objects ------------------------------------------------------
  // Each can glow in a colour its plugin picks (st.objects[id].display.glow).
  const objGlow = (f, st, d) => st.objects?.[f.id]?.display?.glow || d;

  function drawJukebox(f, st) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.jukebox;
    const on = !!st.objects?.[f.id]?.display?.label;
    const glow = objGlow(f, st, '#a78bfa');
    box(x + 0.05, y, w - 0.1, h, hgt, '#7c2d12', '#431407', 0.1);
    const fy = y + h - hgt;
    // arched top
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.ellipse(S(x + 0.5), S(fy + 0.28), S(0.42), S(0.26), 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#fde68a'; ctx.fillRect(S(x + 0.14), S(fy + 0.3), S(0.72), S(0.3));
    for (let i = 0; i < 5; i++) {
      const lvl = on ? 0.5 + 0.5 * Math.abs(Math.sin(st.time / 180 + i * 1.3)) : 0.2;
      ctx.fillStyle = ['#f472b6', '#38bdf8', '#4ade80', '#facc15', '#fb923c'][i];
      ctx.fillRect(S(x + 0.2 + i * 0.13), S(fy + 0.58 - 0.24 * lvl), S(0.08), S(0.24 * lvl));
    }
    ctx.fillStyle = '#1c1917'; ctx.fillRect(S(x + 0.2), S(fy + 0.72), S(0.6), S(0.08));
    ctx.fillRect(S(x + 0.2), S(fy + 0.86), S(0.6), S(0.08));
    if (on) {
      const t = st.time / 900;
      ctx.fillStyle = glow; ctx.font = `${S(0.32)}px system-ui`; ctx.textAlign = 'center';
      ctx.fillText('♪', S(x + 0.5 + 0.35 * Math.sin(t)), S(fy - 0.15 - ((t * 0.4) % 0.5)));
      ctx.textAlign = 'left';
      st.lights.push({ x: x + 0.5, y: y + 1.2, r: 1.8, c: 'rgba(167,139,250,0.45)' });
    }
  }

  function drawVending(f, st) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.vending;
    const glow = objGlow(f, st, '#38bdf8');
    box(x + 0.04, y, w - 0.08, h, hgt, '#dc2626', '#991b1b', 0.06);
    const fy = y + h - hgt;
    ctx.fillStyle = '#e0f2fe'; roundRect(ctx, S(x + 0.1), S(fy + 0.1), S(0.55), S(1.1), S(0.04)); ctx.fill();
    const snacks = ['#f59e0b', '#7c2d12', '#22c55e', '#0ea5e9', '#eab308'];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
      ctx.fillStyle = snacks[(r * 3 + c) % snacks.length];
      ctx.fillRect(S(x + 0.14 + c * 0.17), S(fy + 0.16 + r * 0.26), S(0.12), S(0.16));
    }
    ctx.fillStyle = '#1f2937'; ctx.fillRect(S(x + 0.7), S(fy + 0.15), S(0.2), S(0.5));
    ctx.fillStyle = glow; ctx.fillRect(S(x + 0.72), S(fy + 0.18), S(0.16), S(0.08));
    ctx.fillStyle = '#111827'; ctx.fillRect(S(x + 0.14), S(fy + 1.28), S(0.5), S(0.16));
    st.lights.push({ x: x + 0.5, y: y + 1.1, r: 1.3, c: 'rgba(56,189,248,0.35)' });
  }

  function drawEightBall(f, st) {
    const { x, y } = f;
    const hgt = HEIGHTS.eightball;
    // little pedestal
    box(x + 0.25, y + 0.3, 0.5, 0.6, hgt - 0.35, '#e7e5e4', '#a8a29e', 0.04);
    const cy = y + 0.9 - hgt + 0.1;
    const wob = 0.02 * Math.sin(st.time / 400);
    ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.arc(S(x + 0.5 + wob), S(cy), S(0.3), 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.arc(S(x + 0.42 + wob), S(cy - 0.1), S(0.08), 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(S(x + 0.5 + wob), S(cy), S(0.13), 0, 7); ctx.fill();
    ctx.fillStyle = '#0f172a'; ctx.font = `700 ${S(0.17)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('8', S(x + 0.5 + wob), S(cy + 0.01));
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  function drawKiosk(f, st) {
    const { x, y } = f;
    const hgt = HEIGHTS.kiosk;
    const glow = objGlow(f, st, f.glow || '#22d3ee');
    ctx.fillStyle = '#64748b'; ctx.fillRect(S(x + 0.44), S(y + 0.3), S(0.12), S(0.65));
    ellipse(x + 0.5, y + 0.92, 0.3, 0.1, '#475569');
    const fy = y + 1 - hgt;
    ctx.fillStyle = '#1e293b'; roundRect(ctx, S(x + 0.08), S(fy), S(0.84), S(0.66), S(0.08)); ctx.fill();
    ctx.fillStyle = glow; roundRect(ctx, S(x + 0.14), S(fy + 0.06), S(0.72), S(0.5), S(0.05)); ctx.fill();
    if (f.emoji) {
      // An uploaded one shows its emoji on the screen.
      ctx.font = `${S(0.36)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(f.emoji, S(x + 0.5), S(fy + 0.32));
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    } else {
      // a friendly face that blinks
      const blink = (st.time % 4000) < 150;
      ctx.fillStyle = '#0f172a';
      for (const ex of [0.36, 0.64]) ctx.fillRect(S(x + ex - 0.04), S(fy + 0.2), S(0.08), S(blink ? 0.02 : 0.1));
      ctx.beginPath(); ctx.arc(S(x + 0.5), S(fy + 0.36), S(0.1), 0.1 * Math.PI, 0.9 * Math.PI); ctx.lineWidth = Math.max(1, S(0.03)); ctx.strokeStyle = '#0f172a'; ctx.stroke();
    }
    st.lights.push({ x: x + 0.5, y: y + 0.9, r: 1.2, c: 'rgba(34,211,238,0.35)' });
  }

  // The Office Rally flag: a chequered flag on a pole that waves faster
  // (and glows) while a race is gathering or on.
  function drawRally(f, st) {
    const { x, y } = f;
    const hgt = HEIGHTS.rally;
    const glow = objGlow(f, st, '#f59e0b');
    const live = !!st.objects?.[f.id]?.display?.label;
    ellipse(x + 0.5, y + 0.9, 0.28, 0.1, '#57534e');
    ctx.fillStyle = '#78716c'; ctx.fillRect(S(x + 0.27), S(y + 0.9 - hgt), S(0.06), S(hgt));
    const top = y + 0.9 - hgt + 0.04;
    const t = st.time / (live ? 140 : 420);
    // 4 x 3 chequers, each column bent by the wave.
    for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) {
      const dy = 0.04 * Math.sin(t + c * 0.9);
      ctx.fillStyle = (c + r) % 2 ? '#111827' : '#f8fafc';
      ctx.fillRect(S(x + 0.33 + c * 0.13), S(top + r * 0.12 + dy), S(0.13) + 0.5, S(0.12) + 0.5);
    }
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(S(x + 0.3), S(top - 0.04), S(0.06), 0, 7); ctx.fill();
    if (live) st.lights.push({ x: x + 0.5, y: y + 0.6, r: 1.4, c: 'rgba(245,158,11,0.35)' });
  }

  // An object drawn in its plugin's own pixels (the manifest's sprite): 16
  // to a tile, standing on its tile, centred.
  function drawSprite(f, st) {
    const { x, y } = f;
    const sp = f.sprite;
    if (!sp) return drawKiosk(f, st);
    const px = 1 / 16, rows = sp.rows, w = Math.max(...rows.map((r) => r.length));
    const left = x + (1 - w * px) / 2, top = y + 0.95 - rows.length * px;
    ctx.fillStyle = 'rgba(30,27,24,0.13)';
    roundRect(ctx, S(left + 0.04), S(y + 0.82), S(w * px), S(0.2), S(0.1)); ctx.fill();
    // One rect per run of a colour, a pixel's overlap so no seams show.
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j];
      for (let i = 0; i < r.length;) {
        const c = sp.palette[r[i]];
        let n = 1;
        while (i + n < r.length && r[i + n] === r[i]) n++;
        if (c) { ctx.fillStyle = c; ctx.fillRect(S(left + i * px), S(top + j * px), S(n * px) + 0.5, S(px) + 0.5); }
        i += n;
      }
    }
    const glow = objGlow(f, st, f.glow);
    if (glow) st.lights.push({ x: x + 0.5, y: y + 0.9, r: 1.1, c: glowOf(glow, 0.3) });
  }

  // A channel room's name plate on the hall wall beside its door, coloured
  // by who may walk in (green: anyone; amber: the door has a policy).
  function drawSign(f, st) {
    const r = st.wing?.find((x) => x.id === f.zone);
    const open = r?.access?.open !== false;
    const cx = f.x + (f.side === 'w' ? 0.78 : 0.22), top = f.y + T1 - WALL_H + 0.18;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    roundRect(ctx, S(cx - 0.3), S(top + 0.05), S(0.6), S(0.5), S(0.08)); ctx.fill();
    ctx.fillStyle = open ? '#15803d' : '#b45309';
    roundRect(ctx, S(cx - 0.32), S(top), S(0.64), S(0.5), S(0.08)); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.max(7, S(0.3))}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('#', S(cx), S(top + 0.26));
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // Readable plates for the signs: "#freeq · 📜 accept rules", on the hall side.
  function drawSignLabels(st) {
    if (view.T < 18) return;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const f of FURNITURE) {
      if (f.type !== 'sign') continue;
      const r = st.wing?.find((x) => x.id === f.zone);
      if (!r) continue;
      const a = r.access || { icon: '🚪', text: 'open', open: true };
      // Over the room's side of the wall, so two facing signs never collide.
      const s = toScreen(f.x + (f.side === 'w' ? 0.1 : 0.9), f.y - 0.55);
      if (s.x < -200 || s.x > vw + 200 || s.y < -20 || s.y > vh + 20) continue;
      const label = `${a.icon} ${clipText(r.channel, 140)} · ${a.text}`;
      const lw = ctx.measureText(label).width + 14, lh = 18;
      const x = f.side === 'w' ? s.x - lw : s.x;
      ctx.fillStyle = a.open ? 'rgba(21,128,61,0.9)' : 'rgba(146,64,14,0.92)';
      roundRect(ctx, x, s.y - lh / 2, lw, lh, 9); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 7, s.y + 0.5);
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawWhiteboard(f, st) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.whiteboard;
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(S(x + 0.3), S(y + h - 0.6), S(0.06), S(0.6));
    ctx.fillRect(S(x + w - 0.36), S(y + h - 0.6), S(0.06), S(0.6));
    const bx = x, by = y + h - hgt - 0.1, bw = w, bh = hgt - 0.35;
    ctx.fillStyle = '#cbd5e1'; roundRect(ctx, S(bx - 0.05), S(by - 0.05), S(bw + 0.1), S(bh + 0.1), S(0.05)); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(S(bx), S(by), S(bw), S(bh));
    const wb = f.uploaded ? st.boards?.get(f.id)?.canvas : st.wbCanvas;
    if (wb) ctx.drawImage(wb, S(bx), S(by), S(bw), S(bh));
    ctx.fillStyle = '#94a3b8'; ctx.fillRect(S(bx), S(by + bh), S(bw), S(0.06));
    for (const [i, c] of [['0', '#ef4444'], ['1', '#2563eb'], ['2', '#16a34a']]) {
      ctx.fillStyle = c; ctx.fillRect(S(bx + 0.4 + i * 0.25), S(by + bh - 0.02), S(0.18), S(0.05));
    }
  }

  function drawNoticeboard(f, st) {
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.board;
    ctx.fillStyle = '#78716c'; ctx.fillRect(S(x + w / 2 - 0.04), S(y + h - 0.5), S(0.08), S(0.5));
    const bx = x - 0.1, by = y + h - hgt - 0.05, bw = w + 0.2, bh = hgt - 0.45;
    ctx.fillStyle = '#7c5a3a'; roundRect(ctx, S(bx - 0.05), S(by - 0.05), S(bw + 0.1), S(bh + 0.1), S(0.05)); ctx.fill();
    ctx.fillStyle = '#c8a97e'; ctx.fillRect(S(bx), S(by), S(bw), S(bh));
    // An uploaded board shows its own notes (display.data), a narrower one fewer.
    const notes = f.uploaded ? st.objects?.[f.id]?.display?.data?.notes || [] : st.notes;
    const cols = Math.max(1, Math.floor((bw - 0.1) / 0.52));
    notes.slice(0, cols * 2).forEach((n, i) => {
      const nx = bx + 0.1 + (i % cols) * 0.52, ny = by + 0.08 + Math.floor(i / cols) * 0.38;
      ctx.save(); ctx.translate(S(nx + 0.2), S(ny + 0.15)); ctx.rotate(((i * 37) % 7 - 3) * 0.03);
      ctx.fillStyle = n.color; ctx.fillRect(-S(0.18), -S(0.14), S(0.36), S(0.3));
      ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(0, -S(0.1), S(0.03), 0, 7); ctx.fill();
      ctx.restore();
    });
  }

  function drawReception(f, st) {
    if (f.uploaded) return drawBell(f, st);
    const { x, y, w, h } = f;
    const hgt = HEIGHTS.reception;
    box(x, y, w, h, hgt, '#f5f0e8', '#3d5a80', 0.2);
    ctx.fillStyle = '#98c1d9'; ctx.fillRect(S(x), S(y + h - hgt + 0.08), S(w), S(0.05));
    ctx.font = `700 ${S(0.24)}px Inter, system-ui`; ctx.fillStyle = '#f5f0e8'; ctx.textAlign = 'center';
    ctx.fillText('agent office', S(x + w / 2), S(y + h - hgt + 0.45));
    ctx.font = `500 ${S(0.14)}px Inter, system-ui`; ctx.fillStyle = 'rgba(245,240,232,0.75)';
    ctx.fillText(`☕ ${st.counters.coffees || 0}  ·  🍅 ${st.counters.pomodoros || 0}  ·  👋 ${st.counters.waves || 0}`, S(x + w / 2), S(y + h - hgt + 0.66));
    ctx.textAlign = 'left';
    // laptop + bell
    ctx.fillStyle = '#9ca3af'; roundRect(ctx, S(x + 0.6), S(y - hgt + 0.5), S(0.7), S(0.45), S(0.04)); ctx.fill();
    ctx.fillStyle = '#e5e7eb'; ctx.fillRect(S(x + 0.65), S(y - hgt + 0.55), S(0.6), S(0.3));
    ellipse(x + 3.8, y - hgt + 0.8, 0.14, 0.08, '#d97706');
    ellipse(x + 3.8, y - hgt + 0.72, 0.1, 0.1, '#fbbf24');
  }

  // An uploaded reception plugin: a desk bell on a little stand.
  function drawBell(f, st) {
    const { x, y } = f;
    box(x + 0.2, y + 0.4, 0.6, 0.5, 0.6, '#f5f0e8', '#3d5a80', 0.08);
    const top = y + 0.9 - 0.6;
    ellipse(x + 0.5, top - 0.02, 0.2, 0.08, '#d97706');
    ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(S(x + 0.5), S(top - 0.04), S(0.15), Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.arc(S(x + 0.5), S(top - 0.2), S(0.03), 0, 7); ctx.fill();
  }

  function drawPomodoro(f, st) {
    const { x, y, w, h } = f;
    const p = (f.uploaded ? { phase: 'idle', ...st.objects?.[f.id]?.display?.data } : st.pomo[f.zone]) || { phase: 'idle' };
    const cx = x + w / 2, cy = y + h - 1.0, r = 0.62;
    ctx.fillStyle = '#57534e'; ctx.fillRect(S(cx - 0.05), S(cy), S(0.1), S(1.0));
    ellipse(cx, y + h - 0.05, 0.4, 0.12, 'rgba(0,0,0,0.15)');
    ellipse(cx, cy, r + 0.08, r + 0.08, '#292524');
    ellipse(cx, cy, r, r, '#fafaf9');
    const total = (p.phase === 'break' ? p.breakMin : p.focusMin) * 60000 || 1;
    const left = Math.max(0, (p.endsAt || 0) - st.serverNow());
    const frac = p.phase === 'idle' ? 0 : left / total;
    const col = p.phase === 'focus' ? '#ef4444' : p.phase === 'break' ? '#22c55e' : '#d6d3d1';
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(S(cx), S(cy));
    ctx.arc(S(cx), S(cy), S(r - 0.06), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.closePath(); ctx.fill();
    ellipse(cx, cy, r * 0.62, r * 0.62, '#fafaf9');
    ctx.fillStyle = '#292524'; ctx.textAlign = 'center';
    ctx.font = `700 ${S(0.26)}px Inter, system-ui`;
    const mm = Math.floor(left / 60000), ss = Math.floor(left / 1000) % 60;
    ctx.fillText(p.phase === 'idle' ? '25:00' : `${mm}:${String(ss).padStart(2, '0')}`, S(cx), S(cy + 0.06));
    ctx.font = `600 ${S(0.11)}px Inter, system-ui`; ctx.fillStyle = '#78716c';
    ctx.fillText(p.phase === 'idle' ? 'press E' : p.phase === 'focus' ? `focus · round ${p.round}` : 'break', S(cx), S(cy + 0.22));
    ctx.textAlign = 'left';
    // tomato leaf on top
    ctx.fillStyle = '#16a34a';
    ctx.beginPath(); ctx.ellipse(S(cx - 0.1), S(cy - r - 0.04), S(0.14), S(0.05), -0.4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(S(cx + 0.1), S(cy - r - 0.04), S(0.14), S(0.05), 0.4, 0, 7); ctx.fill();
  }

  function drawRug(f) {
    const { x, y, w, h } = f;
    ctx.fillStyle = '#b45309'; roundRect(ctx, S(x), S(y), S(w), S(h), S(0.3)); ctx.fill();
    ctx.fillStyle = '#f59e0b'; roundRect(ctx, S(x + 0.2), S(y + 0.2), S(w - 0.4), S(h - 0.4), S(0.2)); ctx.fill();
    ctx.fillStyle = '#fef3c7'; roundRect(ctx, S(x + 0.4), S(y + 0.4), S(w - 0.8), S(h - 0.8), S(0.15)); ctx.fill();
    ctx.fillStyle = '#f59e0b';
    for (let i = 0; i < w - 1; i++) {
      for (const yy of [y + 0.75, y + h - 0.75]) {
        const cx = x + 1 + i, r = 0.16;
        ctx.beginPath(); ctx.moveTo(S(cx), S(yy - r)); ctx.lineTo(S(cx + r), S(yy)); ctx.lineTo(S(cx), S(yy + r)); ctx.lineTo(S(cx - r), S(yy)); ctx.fill();
      }
    }
    ctx.strokeStyle = 'rgba(180,83,9,0.35)'; ctx.lineWidth = S(0.04);
    roundRect(ctx, S(x + 0.9), S(y + 1.2), S(w - 1.8), S(h - 2.4), S(0.4)); ctx.stroke();
  }

  // ---- placing something --------------------------------------------------------
  // The tiles you can put it on, and where it would land under the mouse.
  function drawPlaceTiles(pl, st) {
    const a = 0.16 + 0.06 * Math.sin(st.time / 250);
    ctx.fillStyle = `rgba(34,197,94,${a})`;
    ctx.strokeStyle = 'rgba(22,163,74,0.55)'; ctx.lineWidth = 1;
    for (const t of pl.tiles) {
      roundRect(ctx, S(t.x + 0.06), S(t.y + 0.06), S(0.88), S(0.88), S(0.12));
      ctx.fill(); ctx.stroke();
    }
  }
  function drawPlaceGhost(pl, st) {
    const { x, y, ok } = pl.hover;
    ctx.strokeStyle = ok ? 'rgba(22,163,74,0.95)' : 'rgba(220,38,38,0.9)'; ctx.lineWidth = 2;
    ctx.fillStyle = ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.22)';
    roundRect(ctx, S(x + 0.04), S(y + 0.04), S(0.92), S(0.92), S(0.14)); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = ok ? 0.75 : 0.35;
    drawDrop({ id: 'ghost', x: x + 0.5, y: y + 0.5, item: { emoji: pl.emoji, qty: 1 } }, st);
    ctx.globalAlpha = 1;
  }

  // ---- things on the floor ---------------------------------------------------
  // An emoji with a shadow, bobbing a little so it reads as something to pick up.
  function drawDrop(e, st) {
    const bob = Math.sin(st.time / 400 + e.x * 3) * 0.04;
    ellipse(e.x, e.y, 0.24, 0.09, 'rgba(0,0,0,0.22)');
    if (st.floorTarget === e.id) {
      ctx.strokeStyle = 'rgba(37,99,235,0.9)'; ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]); ctx.lineDashOffset = -st.time / 60;
      ctx.beginPath(); ctx.ellipse(S(e.x), S(e.y), S(0.36), S(0.15), 0, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = `${Math.max(10, S(0.5))}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#1c1917';
    ctx.fillText(e.item.emoji, S(e.x), S(e.y - 0.08 + bob));
    if (e.item.qty > 1) {
      ctx.font = `700 ${Math.max(8, S(0.22))}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = '#1c1917';
      ctx.fillText(`×${e.item.qty}`, S(e.x + 0.3), S(e.y + 0.05));
    }
    ctx.textAlign = 'left';
  }

  // ---- characters --------------------------------------------------------
  function drawPeer(p, st) {
    const sheets = p.sheets;
    const s = toScreen(p.rx, p.ry);
    const k = view.k;
    const fr = sheets?.frame || 48;
    const sw = fr * k / dpr;
    // floor marks: status ring and voice ring
    const ringY = p.ry + 0.08;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, view.ox * dpr, view.oy * dpr);
    ctx.lineWidth = Math.max(1.5, S(0.06));
    ctx.strokeStyle = statusColor(p.status);
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.ellipse(S(p.rx), S(ringY), S(0.36), S(0.14), 0, 0, 7); ctx.stroke();
    if (p.speaking) {
      ctx.strokeStyle = '#4ade80'; ctx.globalAlpha = 0.5 + 0.3 * Math.sin(st.time / 120);
      ctx.beginPath(); ctx.ellipse(S(p.rx), S(ringY), S(0.5), S(0.2), 0, 0, 7); ctx.stroke();
    }
    ctx.restore();

    if (sheets) {
      const emote = p.emote && sheets.emotes[p.emote];
      const talking = p.speaking || st.time - (p.lastChat || 0) < 1400;
      let img = sheets.base;
      if (emote) img = talking && emote.talk ? emote.talk : emote.sheet;
      else if (talking && sheets.emotes.neutral?.talk) img = sheets.emotes.neutral.talk;
      const cols = Math.max(1, Math.floor(img.width / fr));
      const order = cols === 3 ? WALK : pingPong(cols);
      // Keep the walk cycle going while a remote avatar is still gliding to its last spot.
      const walking = p.moving || Math.abs(p.x - p.rx) + Math.abs(p.y - p.ry) > 0.05;
      const col = walking ? order[Math.floor(st.time / 100) % order.length] : Math.min(1, cols - 1);
      const row = Math.min(p.dir, Math.floor(img.height / fr) - 1);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const dx = Math.round(s.x * dpr - (fr * k) / 2);
      const dy = Math.round((s.y + S(0.18)) * dpr - fr * k);
      ctx.drawImage(img, col * fr, row * fr, fr, fr, dx, dy, fr * k, fr * k);
      ctx.restore();
    }
    if (p.cup) {
      const cx = p.rx + (p.dir === 1 ? -0.38 : 0.38), cy = p.ry - 0.55;
      drawMug(cx, cy, '#f8fafc');
    }
    p.headY = s.y + S(0.18) - sw * 0.92;
  }

  function pingPong(n) { const a = []; for (let i = 0; i < n; i++) a.push(i); for (let i = n - 2; i > 0; i--) a.push(i); return a; }

  // ---- labels ------------------------------------------------------------
  // Every in-world label is a pill drawn in screen space after the lighting, so
  // walls and furniture never cover it. Labels are laid out in priority order
  // (you, nearby people, objects, rooms) and one that would land on another is
  // nudged up or left out. They grow a little with zoom and thin out with distance.
  const PILL = { dark: 'rgba(28,25,23,0.8)', me: 'rgba(37,99,235,0.94)', agent: 'rgba(8,145,178,0.92)', freeq: 'rgba(109,40,217,0.9)' };
  const ZONE_DOT = { open: '#22c55e', room: '#a78bfa', quiet: '#f87171' };
  let placed = [], lsc = 1, far = false;
  const font = (w = 600) => `${w} ${Math.round(11 * lsc)}px Inter, system-ui, sans-serif`;
  const hits = (r) => placed.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);

  // Measures a pill: { text, bg, dot?, caps? } -> its width at the current scale.
  function pillWidth(pl) {
    ctx.font = font();
    const tw = ctx.measureText(pl.text).width + (pl.caps ? pl.text.length * 0.6 * lsc : 0);
    return Math.ceil(tw + (pl.text ? 14 : 4) * lsc + (pl.dot ? 9 * lsc : 0) + (pl.text ? 0 : 6 * lsc));
  }
  function drawPill(pl, x, y, w, h) {
    ctx.fillStyle = pl.bg;
    roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
    let tx = x + 7 * lsc;
    if (pl.dot) {
      ctx.fillStyle = pl.dot;
      ctx.beginPath(); ctx.arc(tx + 2.5 * lsc, y + h / 2, 3.5 * lsc, 0, 7); ctx.fill();
      tx += 9 * lsc;
    }
    if (!pl.text) return;
    ctx.font = font(); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
    if (pl.caps && 'letterSpacing' in ctx) ctx.letterSpacing = `${0.6 * lsc}px`;
    ctx.fillText(pl.text, tx, y + h / 2 + 0.5);
    if (pl.caps && 'letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.textBaseline = 'alphabetic';
  }
  // Lays out a row of pills. anchor: 'center' puts the row's bottom centre at
  // (x, y); 'left' puts its top-left there. Tries `nudges` steps upward on a
  // collision and returns the placed rect, or null when there was no room.
  // With `spots`, a function (w, h) -> candidate top-left corners, the row goes
  // in the first spot that collides with neither a placed label nor `avoid`.
  function placeRow(pills, x, y, { anchor = 'center', nudges = 2, force = false, alpha = 1, maxW = Infinity, spots = null, avoid = [] } = {}) {
    const h = Math.round(18 * lsc), gap = Math.round(4 * lsc);
    let ws = pills.map(pillWidth);
    // Too wide for its space: drop trailing pills, then clip the first one.
    while (pills.length > 1 && ws.reduce((a, b) => a + b + gap, -gap) > maxW) { pills = pills.slice(0, -1); ws = ws.slice(0, -1); }
    if (ws[0] > maxW) {
      ctx.font = font();
      pills = [{ ...pills[0], text: clipText(pills[0].text, Math.max(16, maxW - (ws[0] - ctx.measureText(pills[0].text).width))) }];
      ws = [Math.min(ws[0], maxW)];
    }
    const w = ws.reduce((a, b) => a + b + gap, -gap);
    if (spots) {
      const free = (r) => !hits(r) && !avoid.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
      const spot = spots(w, h).map(([sx, sy]) => ({ x: Math.round(sx), y: Math.round(sy), w, h })).find(free);
      if (!spot) return null;
      [x, y] = [spot.x, spot.y]; anchor = 'left'; nudges = 0;
    }
    let rx = Math.round(anchor === 'center' ? x - w / 2 : x), ry = Math.round(anchor === 'center' ? y - h : y);
    if (rx + w < 0 || rx > vw || ry + h < 0 || ry > vh) return null;
    let i = 0;
    while (hits({ x: rx, y: ry, w, h }) && i < nudges) { ry -= h + gap; i++; }
    if (!force && hits({ x: rx, y: ry, w, h })) return null;
    const r = { x: rx, y: ry, w, h };
    placed.push(r);
    ctx.globalAlpha = alpha;
    pills.forEach((pl, j) => { drawPill(pl, rx, ry, ws[j], h); rx += ws[j] + gap; });
    ctx.globalAlpha = 1;
    return r;
  }

  function clipText(text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
    return `${t}…`;
  }

  // How visible a label at world (x, y) should be from where you stand.
  const fade = (me, x, y, near, far) => {
    if (!me) return 1;
    const d = Math.hypot(me.rx - x, me.ry - y);
    return d <= near ? 1 : d >= far ? 0 : 1 - (d - near) / (far - near);
  };

  function drawPeerLabel(p, st, me, later) {
    const isMe = p === me;
    const s = toScreen(p.rx, p.ry);
    const top = p.headY ?? s.y - S(1.4);
    const talking = p.bubble && st.time - p.bubble.at < 7000;
    // Far out, only you and whoever's talking keep a name; everyone else is a dot.
    const alpha = isMe || talking ? 1 : far ? 0.9 : fade(me, p.rx, p.ry, 8, 15);
    const named = isMe || talking || !far;
    let r = null;
    if (alpha > 0.05 && named) {
      // Owners, admins and moderators wear their role's badge (public/js/roles.js).
      const badge = roleBadge(p.role);
      const name = `${badge ? `${badge} ` : ''}${markedName(p.name, p.kind)}`;
      const extra = `${p.video ? ' 📹' : ''}${p.screen ? ' 🖥️' : ''}${p.audio ? (p.speaking ? ' 🔊' : ' 🎙️') : ''}${p.muted > st.serverNow() ? ' 🔇' : ''}`;
      r = placeRow([{ text: name + extra, bg: isMe ? PILL.me : PILL[p.kind] || PILL.dark, dot: statusColor(p.status) }], s.x, top - 2, { force: isMe || talking, alpha });
    }
    // Crowded or far away: a status dot still says someone's there.
    if (!r && alpha > 0.05) {
      ctx.globalAlpha = alpha; ctx.fillStyle = statusColor(p.status);
      ctx.beginPath(); ctx.arc(s.x, top - 6 * lsc, 3.5 * lsc, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    }
    const ly = r ? r.y : top - 2;
    // emote fallback (no rpg.actor sheet for it)
    if (p.emote && !(p.sheets?.emotes?.[p.emote])) {
      later.push(() => {
        ctx.font = `${Math.round(20 * lsc)}px system-ui`; ctx.textAlign = 'center';
        ctx.fillText(EMOJI[p.emote] || '✨', r ? r.x + r.w + 12 * lsc : s.x + 16 * lsc, ly - 2);
        ctx.textAlign = 'left';
      });
    }
    if (talking) {
      // Reserve the bubble's space so other names keep clear of it.
      const { bw, bh } = bubbleSize(p.bubble.text);
      let bottom = ly - 4;
      for (let i = 0; i < 6 && hits({ x: s.x - bw / 2, y: bottom - bh - 6, w: bw, h: bh + 6 }); i++) bottom -= 10;
      placed.push({ x: s.x - bw / 2, y: bottom - bh - 6, w: bw, h: bh + 6 });
      later.push(() => drawBubble(s.x, bottom, p.bubble.text, Math.min(1, (7000 - (st.time - p.bubble.at)) / 600), p.bubble.scope === 'office' ? '#fef3c7' : '#ffffff'));
    }
  }

  // Status labels and speech over plugin objects (the jukebox's song, etc).
  function drawObjectLabel(f, st, me, later) {
    const o = f.plugin && st.objects?.[f.id];
    if (!o) return;
    const lift = f.type === 'jukebox' ? 0.75 : 0.15; // clear of the jukebox's floating notes
    const s = toScreen(f.x + f.w / 2, f.y + f.h - (heightOf(f) ?? 0.5) - lift);
    const label = o.display?.label && (!o.display.until || o.display.until > st.serverNow()) ? o.display.label : null;
    let top = s.y;
    if (label && !far) {
      const r = placeRow([{ text: label, bg: PILL.dark }], s.x, s.y, { alpha: fade(me, f.x, f.y, 10, 18) });
      if (r) top = r.y;
    }
    if (o.bubble && st.time - o.bubble.at < 8000) later.push(() => drawBubble(s.x, top - 4, o.bubble.text, Math.min(1, (8000 - (st.time - o.bubble.at)) / 600), '#ecfeff'));
  }

  // Each area's name in its top-left corner, with the booking state of a
  // bookable room and the freeq channel it's bridged to alongside.
  function drawZoneLabel(z, st, obstacles) {
    if (z.id === 'booths' || z.label === false) return;
    const a = toScreen(z.x0 + 0.1, z.y0 + 0.1), b = toScreen(z.x1 + 0.9, z.y1 + 0.9);
    // Only the visible part of the area counts, so its name stays in view while you're in it.
    const x0 = Math.max(a.x, 8), y0 = Math.max(a.y, 8), x1 = Math.min(b.x, vw - 8), y1 = Math.min(b.y, vh - 8);
    if (x1 - x0 < 40 || y1 - y0 < 20) return;
    let maxW = x1 - x0;
    const pills = [];
    const fq = st.freeq?.[z.id];
    // A channel room's name is on the sign by its door (and in the HUD once
    // you're in), so inside it the label says what the channel is about.
    if (z.gen) {
      const topic = fq?.topic || st.wing?.find((r) => r.id === z.id)?.topic;
      if (!topic) return;
      pills.push({ text: `💬 ${topic}`, bg: fq ? PILL.freeq : PILL.dark });
      maxW = Math.min(maxW, 360 * lsc);
    }
    const room = z.bookable && ROOMS.find((r) => r.id === z.id);
    const small = z.x1 - z.x0 < 4;
    let dot = ZONE_DOT[z.kind] || ZONE_DOT.open;
    if (room) {
      const { state, current, next } = roomStatus(st.bookings || [], room.id, st.serverNow());
      dot = STATE_COLOR[state];
      if (small) pills.push({ text: state === 'busy' ? `${z.name} · busy` : state === 'soon' ? `${z.name} · ${fmtTime(next.start)}` : z.name, bg: PILL.dark, dot });
      else {
        pills.push({ text: z.name.toUpperCase(), bg: PILL.dark, caps: true });
        pills.push({ text: state === 'busy' ? `🔒 ${current.title} · until ${fmtTime(current.end)}` : state === 'soon' ? `free until ${fmtTime(next.start)}` : room.av ? 'free · A/V' : 'free', bg: PILL.dark, dot });
      }
    } else if (!z.gen) pills.push({ text: z.name.toUpperCase(), bg: PILL.dark, dot, caps: true });
    // The count is who's drawn here, so it always matches the avatars.
    if (fq && !z.gen) { const n = fq.here ?? fq.members; pills.push({ text: `${fq.channel}${n ? ` · ${n}` : ''}`, bg: PILL.freeq }); }
    // Free floor or wall only: scan the area from its top-left, row by row, for
    // a spot clear of furniture, people and other labels. No room, no label.
    const step = Math.max(12, view.T / 2);
    const spots = (w, h) => {
      const out = [];
      for (let y = y0; y + h <= y1; y += step) for (let x = x0; x + w <= x1; x += step) out.push([x, y]);
      return out;
    };
    placeRow(pills, x0, y0, { maxW, alpha: 0.92, spots, avoid: obstacles });
  }

  // Screen boxes of everything an area label must not cover.
  function labelObstacles(st) {
    const out = [];
    for (const f of FURNITURE) {
      if (f.type === 'rug') continue;
      const hgt = heightOf(f) ?? 0.4;
      const p = toScreen(f.x - 0.05, f.y - hgt - 0.05), q = toScreen(f.x + f.w + 0.05, f.y + f.h + 0.05);
      if (q.x < 0 || p.x > vw || q.y < 0 || p.y > vh) continue;
      out.push({ x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y });
    }
    for (const p of st.peers) {
      const t = toScreen(p.rx - 0.45, p.ry - 1.5), u = toScreen(p.rx + 0.45, p.ry + 0.25);
      out.push({ x: t.x, y: t.y, w: u.x - t.x, h: u.y - t.y });
    }
    return out;
  }

  // The interaction prompt is a DOM button (so it stays tappable); the renderer
  // only finds it a spot just above the target object and keeps labels off it.
  let promptAt = null;
  function placePrompt(st) {
    promptAt = null;
    let f = st.promptTarget, size = st.promptSize;
    if (!f || !size?.w) return;
    // Sitting at a desk, the prompt (use the computer) belongs on the monitor, not the chair.
    if (f.desk) f = FURNITURE.find((d) => d.id === f.desk && d.type === 'desk') || f;
    const lift = f.type === 'jukebox' ? 0.6 : f.type === 'desk' ? 0.75 : 0.1;
    const top = toScreen(f.x + f.w / 2, f.y + f.h - (heightOf(f) ?? 0.5) - lift);
    const x = Math.max(6, Math.min(vw - size.w - 6, top.x - size.w / 2));
    const y = Math.max(6, Math.min(vh - size.h - 6, top.y - size.h - 10));
    placed.push({ x, y, w: size.w, h: size.h + 8 });
    promptAt = { x, y, tail: Math.max(14, Math.min(size.w - 14, top.x - x)) };
  }

  function drawLabelLayer(st) {
    placed = [];
    // Labels shrink more slowly than the map, down to a legible floor.
    lsc = Math.max(0.7, Math.min(1.3, Math.sqrt(view.k / dpr)));
    far = view.k / dpr < 0.5;
    placePrompt(st);
    const me = st.peers.find((p) => p.id === st.meId);
    const later = [];
    const byDist = (x, y) => (me ? Math.hypot(me.rx - x, me.ry - y) : 0);
    if (me) drawPeerLabel(me, st, me, later);
    // People talking keep their names, so they're placed before the rest.
    const talking = (p) => (p.bubble && st.time - p.bubble.at < 7000 ? 0 : 1);
    const others = st.peers.filter((q) => q !== me).sort((a, b) => talking(a) - talking(b) || byDist(a.rx, a.ry) - byDist(b.rx, b.ry));
    for (const p of others) drawPeerLabel(p, st, me, later);
    for (const f of FURNITURE) drawObjectLabel(f, st, me, later);
    const obstacles = labelObstacles(st);
    for (const z of ZONES) drawZoneLabel(z, st, obstacles);
    for (const fn of later) fn();
  }

  function bubbleSize(text) {
    ctx.font = '500 12.5px Inter, system-ui, sans-serif';
    const lines = wrapText(ctx, text, 200).slice(0, 4);
    return { lines, bw: Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18, bh: lines.length * 16 + 10 };
  }
  // A speech bubble whose tail points down at (x, bottom).
  function drawBubble(x, bottom, text, alpha, fill) {
    ctx.globalAlpha = alpha;
    const { lines, bw, bh } = bubbleSize(text);
    const bx = Math.round(Math.max(6, Math.min(vw - bw - 6, x - bw / 2))), byy = Math.round(bottom - bh - 6);
    ctx.fillStyle = fill;
    ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    roundRect(ctx, bx, byy, bw, bh, 10); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 6, byy + bh - 1); ctx.lineTo(x, byy + bh + 6); ctx.lineTo(x + 6, byy + bh - 1); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#1c1917'; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, bx + 9, byy + 6 + i * 16));
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }

  // ---- lighting ----------------------------------------------------------
  function drawLighting(st) {
    const L = st.light;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (L.tint) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = L.tint;
      ctx.fillRect(0, 0, vw, vh);
    }
    ctx.globalCompositeOperation = 'screen';
    // sunlight from the north windows
    if (L.sun > 0) {
      for (let x = 1; x < CORE_W - 1; x++) {
        if (x % 3 === 0 || isW(x, 1)) continue;
        const a = toScreen(x + 0.1, 0.7), b = toScreen(x + 0.9, 0.7);
        const c = toScreen(x + 1.6, 4.2), d = toScreen(x + 0.8, 4.2);
        const g = ctx.createLinearGradient(0, a.y, 0, c.y);
        g.addColorStop(0, `rgba(255,236,190,${0.22 * L.sun})`); g.addColorStop(1, 'rgba(255,236,190,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.fill();
      }
    }
    for (const l of st.lights) {
      const s = toScreen(l.x, l.y);
      const r = S(l.r) * (L.night ? 1 : 0.6);
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      g.addColorStop(0, l.c); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.globalAlpha = L.night ? 1 : 0.35;
      ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  // ---- frame -------------------------------------------------------------
  function draw(st) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2b2622';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setCamera(st.cam, st.k);
    ctx.setTransform(dpr, 0, 0, dpr, view.ox * dpr, view.oy * dpr);
    const tl = toWorld(0, 0), br = toWorld(vw, vh);
    const vis = { x0: tl.x - 2, y0: tl.y - 2, x1: br.x + 2, y1: br.y + 3 };
    st.lights = [];
    st.light = daylight(st.clock);

    drawFloors(vis, st.freeq || {});
    for (const f of FURNITURE) if (f.type === 'rug') drawRug(f);
    if (st.place) drawPlaceTiles(st.place, st);
    // den lights dim during a focus session
    const den = st.pomo.focus;
    if (den && den.phase === 'focus') {
      ctx.fillStyle = 'rgba(30,27,75,0.12)';
      ctx.fillRect(S(1), S(1), S(12), S(12));
    }

    // painter's algorithm on the bottom edge of every drawable
    const items = [];
    for (let y = Math.max(0, Math.floor(vis.y0)); y < Math.min(H, Math.ceil(vis.y1)); y++)
      for (let x = Math.max(0, Math.floor(vis.x0)); x < Math.min(W, Math.ceil(vis.x1)); x++)
        if (grid[y * W + x] === 1 || grid[y * W + x] === 2) items.push({ k: y + T1 + 0.01, x, y, wall: true });
    for (const f of FURNITURE) {
      if (f.type === 'rug') continue;
      if (f.x > vis.x1 || f.x + f.w < vis.x0 || f.y > vis.y1 + 2 || f.y + f.h < vis.y0) continue;
      if (f.type === 'chair') {
        items.push({ k: f.y + 0.5, f });
        items.push({ k: f.facing === 'up' ? f.y + 1.05 : f.y + 0.3, back: f });
      } else items.push({ k: f.seat ? f.y + 0.5 : f.type === 'panel' ? f.y + 0.7 : f.y + f.h, f });
    }
    for (const e of st.floor || []) {
      if (e.x < vis.x0 || e.x > vis.x1 || e.y < vis.y0 || e.y > vis.y1) continue;
      items.push({ k: e.y, drop: e });
    }
    for (const p of st.peers) {
      items.push({ k: p.ry + 0.2, p });
    }
    items.sort((a, b) => a.k - b.k);
    for (const it of items) {
      if (it.wall) drawWall(it.x, it.y, st.light);
      else if (it.f) drawFurniture(it.f, st);
      else if (it.back) drawChairBack(it.back);
      else if (it.p) drawPeer(it.p, st);
      else if (it.drop) drawDrop(it.drop, st);
    }

    // mouse hover: a faint outline on what a click would use
    if (st.hover && st.hover !== st.target) {
      const f = st.hover;
      const hgt = heightOf(f) ?? 0.4;
      ctx.strokeStyle = 'rgba(37,99,235,0.45)'; ctx.lineWidth = 1.5;
      roundRect(ctx, S(f.x - 0.05), S(f.y - hgt - 0.05), S(f.w + 0.1), S(f.h + hgt + 0.1), 6); ctx.stroke();
    }
    // interaction target highlight
    if (st.target) {
      const f = st.target;
      const hgt = heightOf(f) ?? 0.4;
      ctx.fillStyle = `rgba(96,165,250,${0.12 + 0.06 * Math.sin(st.time / 250)})`;
      roundRect(ctx, S(f.x - 0.05), S(f.y - hgt - 0.05), S(f.w + 0.1), S(f.h + hgt + 0.1), 6); ctx.fill();
      ctx.strokeStyle = 'rgba(37,99,235,0.9)'; ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]); ctx.lineDashOffset = -st.time / 60;
      roundRect(ctx, S(f.x - 0.05), S(f.y - hgt - 0.05), S(f.w + 0.1), S(f.h + hgt + 0.1), 6); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (st.place?.hover) drawPlaceGhost(st.place, st);
    if (st.walkTarget) {
      const t = st.walkTarget;
      ctx.strokeStyle = 'rgba(37,99,235,0.8)'; ctx.lineWidth = 2;
      const r = 0.25 + 0.05 * Math.sin(st.time / 150);
      ctx.beginPath(); ctx.ellipse(S(t.x), S(t.y), S(r), S(r * 0.45), 0, 0, 7); ctx.stroke();
    }

    drawLighting(st);

    // labels sit above the lighting so they stay readable at night
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLabelLayer(st);
    drawSignLabels(st);
    const z = zoneAt(st.cam.x, st.cam.y);
    return z;
  }

  function hitPeer(sx, sy, peers, radius = 28) {
    let best = null, bd = radius;
    for (const p of peers) {
      const s = toScreen(p.rx, p.ry);
      const d = Math.hypot(sx - s.x, sy - (s.y - S(0.6)));
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  return { resize, draw, fitZoom, get promptAt() { return promptAt; }, get size() { return { w: vw, h: vh }; }, toWorld, toScreen, hitPeer, get dpr() { return dpr; } };
}

export const EMOJI = {
  wave: '👋', happy: '😄', sad: '😢', angry: '😠', silly: '😜', tired: '🥱', pout: '😤',
  bruh: '😑', blink: '😉', neutral: '🙂', love: '❤️', clap: '👏', idea: '💡', party: '🎉',
  thumbs: '👍', coffee: '☕', focus: '🎧',
};
