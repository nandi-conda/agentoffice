// Character sprites. rpg.actor sheets follow a 3x4 grid of 48px frames:
// rows are down, left, right, up; columns are step, idle, step.
// Players without an rpg.actor sprite get a stock rpg.actor character built
// from the generator's parts (stock.js); if that art can't be reached they
// get a drawn sheet in the same format, so the renderer only ever deals with
// one layout.

import { stockSheet } from './stock.js';

export const FRAME = 48;
export const WALK = [0, 1, 2, 1];

// Sheet row facing a velocity: 0 down, 1 left, 2 right, 3 up. Keeps the
// current row until the walk turns well away from it (over 60 degrees), so a
// diagonal doesn't flip the character between two rows every few frames.
const FACING = [[0, 1], [-1, 0], [1, 0], [0, -1]];
export function facing(dir, vx, vy) {
  const len = Math.hypot(vx, vy);
  if (!len) return dir;
  const f = FACING[dir];
  if (f && (f[0] * vx + f[1] * vy) / len > 0.5) return dir;
  return Math.abs(vx) > Math.abs(vy) ? (vx < 0 ? 1 : 2) : vy < 0 ? 3 : 0;
}

const images = new Map();

export function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (images.has(url)) return images.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  images.set(url, p);
  return p;
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296; };
}

const SKIN = ['#f5d0b5', '#e8b796', '#c98e66', '#a86d4a', '#7a4a30', '#5a3522'];
const HAIR = ['#2b1d16', '#5b3a24', '#a0522d', '#d9a441', '#e7e2d6', '#3b4252', '#b83b5e', '#3f7cac'];
const SHIRT = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b', '#f97316'];
const PANTS = ['#1f2937', '#374151', '#1e3a8a', '#3f3f46', '#78350f', '#14532d'];

// Draws a small, chunky pixel character. Agents get a robot variant.
export function generateSheet(seedText, kind = 'human') {
  const c = document.createElement('canvas');
  c.width = FRAME * 3; c.height = FRAME * 4;
  const g = c.getContext('2d');
  const r = rng(hash(seedText));
  const pick = (a) => a[(r() * a.length) | 0];
  const skin = kind === 'agent' ? '#cbd5e1' : pick(SKIN);
  const hair = kind === 'agent' ? '#94a3b8' : pick(HAIR);
  const shirt = pick(SHIRT), pants = pick(PANTS);
  const longHair = r() < 0.4;
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      const ox = col * FRAME, oy = row * FRAME;
      const step = col === 1 ? 0 : col === 0 ? -1 : 1;
      const bob = col === 1 ? 0 : 1;
      const cx = ox + 24, top = oy + 12 + bob;
      // shadow
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(cx - 9, oy + 44, 18, 3);
      // legs
      if (row === 0 || row === 3) {
        px(cx - 6, top + 26, 5, 7 + (step < 0 ? -1 : 0), pants);
        px(cx + 1, top + 26, 5, 7 + (step > 0 ? -1 : 0), pants);
        px(cx - 6, top + 32 + (step < 0 ? -1 : 0), 5, 2, '#111827');
        px(cx + 1, top + 32 + (step > 0 ? -1 : 0), 5, 2, '#111827');
      } else {
        const dir = row === 1 ? -1 : 1;
        px(cx - 3 + step * 3 * dir, top + 26, 5, 7, pants);
        px(cx - 3 - step * 3 * dir, top + 26, 5, 7, shade(pants, -20));
        px(cx - 3 + step * 3 * dir + (dir > 0 ? 1 : -1), top + 32, 6, 2, '#111827');
      }
      // body
      px(cx - 8, top + 14, 16, 13, shirt);
      px(cx - 8, top + 24, 16, 3, shade(shirt, -25));
      if (kind === 'agent') px(cx - 3, top + 17, 6, 4, '#22d3ee');
      // arms
      if (row === 0 || row === 3) {
        px(cx - 11, top + 15 + (step > 0 ? 1 : 0), 3, 10, shade(shirt, -15));
        px(cx + 8, top + 15 + (step < 0 ? 1 : 0), 3, 10, shade(shirt, -15));
        px(cx - 11, top + 25 + (step > 0 ? 1 : 0), 3, 2, skin);
        px(cx + 8, top + 25 + (step < 0 ? 1 : 0), 3, 2, skin);
      } else {
        px(cx - 2 - step * 2, top + 15, 4, 10, shade(shirt, -15));
        px(cx - 2 - step * 2, top + 25, 4, 2, skin);
      }
      // head
      px(cx - 8, top, 16, 14, skin);
      px(cx - 8, top + 12, 16, 2, shade(skin, -18));
      if (kind === 'agent') {
        px(cx - 1, top - 4, 2, 4, '#64748b');
        px(cx - 2, top - 6, 4, 2, '#f43f5e');
      }
      // hair / face per direction
      if (row === 0) {
        px(cx - 9, top - 2, 18, 5, hair);
        px(cx - 9, top + 2, 3, longHair ? 12 : 4, hair);
        px(cx + 6, top + 2, 3, longHair ? 12 : 4, hair);
        const eye = kind === 'agent' ? '#06b6d4' : '#1f2937';
        px(cx - 5, top + 6, 3, 3, eye);
        px(cx + 2, top + 6, 3, 3, eye);
        px(cx - 2, top + 10, 4, 1, shade(skin, -40));
      } else if (row === 3) {
        px(cx - 9, top - 2, 18, 12, hair);
        if (longHair) px(cx - 8, top + 10, 16, 6, hair);
      } else {
        const d = row === 1 ? -1 : 1;
        px(cx - 9, top - 2, 18, 5, hair);
        px(cx - 9 * 1 + (d > 0 ? 0 : 9), top + 2, 9, longHair ? 13 : 7, hair);
        px(cx + d * 4 - 1, top + 6, 3, 3, kind === 'agent' ? '#06b6d4' : '#1f2937');
      }
    }
  }
  return c;
}

export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v) => Math.max(0, Math.min(255, v));
  const r = cl((n >> 16) + amt), g = cl(((n >> 8) & 255) + amt), b = cl((n & 255) + amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Resolves the sheets a peer needs. Returns { base, emotes: {name: {sheet, talk}} }
// with images (or canvases) ready to draw.
export async function sheetsFor(peer) {
  const s = peer.actor?.sprite;
  const fallback = async () => {
    const seed = peer.did || peer.name;
    const base = await stockSheet(seed, peer.kind) || generateSheet(seed, peer.kind);
    return { base, emotes: {}, frame: FRAME, cols: 3, rpg: false };
  };
  if (!s?.sheet) return fallback();
  const base = await loadImage(s.sheet);
  if (!base) return fallback();
  const emotes = {};
  await Promise.all(Object.entries(s.emotes || {}).map(async ([name, e]) => {
    const [sheet, talk] = await Promise.all([loadImage(e.sheet), loadImage(e.talk)]);
    if (sheet) emotes[name] = { sheet, talk, label: e.label };
  }));
  return { base, emotes, frame: s.frameWidth || FRAME, cols: s.columns || 3, rpg: true };
}
