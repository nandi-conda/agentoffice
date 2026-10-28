import { hash } from './sprites.js';

export const WALL_H = 1.0;

export const STATUS = {
  available: { label: 'Available', color: '#22c55e' },
  focus: { label: 'Focusing', color: '#ef4444' },
  meeting: { label: 'In a meeting', color: '#a855f7' },
  coffee: { label: 'Coffee break', color: '#f59e0b' },
  away: { label: 'Away', color: '#94a3b8' },
};

export const statusColor = (s) => (STATUS[s] || STATUS.available).color;

const PALETTE = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'];
export const colorFor = (s) => PALETTE[hash(String(s)) % PALETTE.length];

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

export function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (let w of words) {
    // A word wider than the line (a long URL) is broken across lines.
    while (ctx.measureText(w).width > maxW && w.length > 1) {
      if (cur) { lines.push(cur); cur = ''; }
      let n = w.length - 1;
      while (n > 1 && ctx.measureText(w.slice(0, n)).width > maxW) n--;
      lines.push(w.slice(0, n)); w = w.slice(n);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Lighting follows the viewer's local clock.
export function daylight(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const keys = [
    [0, [120, 128, 180], 0, ['#0b1026', '#1e2a5a']],
    [5.5, [140, 140, 190], 0, ['#1e2a5a', '#f59e8b']],
    [7, [255, 214, 180], 0.6, ['#7dd3fc', '#fde4c8']],
    [9, [255, 255, 255], 1, ['#60a5fa', '#bae6fd']],
    [16, [255, 250, 240], 1, ['#60a5fa', '#bae6fd']],
    [18.5, [255, 196, 150], 0.6, ['#f97316', '#fda4af']],
    [20, [140, 140, 190], 0, ['#312e81', '#1e1b4b']],
    [24, [120, 128, 180], 0, ['#0b1026', '#1e2a5a']],
  ];
  let i = 0;
  while (i < keys.length - 2 && h >= keys[i + 1][0]) i++;
  const [h0, c0, s0, sky0] = keys[i], [h1, c1, s1] = keys[i + 1];
  const t = (h - h0) / (h1 - h0 || 1);
  const c = mix(c0, c1, t);
  const white = c[0] > 250 && c[1] > 250 && c[2] > 250;
  return {
    tint: white ? null : rgb(c),
    sun: s0 + (s1 - s0) * t,
    sky: sky0,
    night: h < 6.5 || h >= 19.5,
    morning: h >= 7 && h < 10,
  };
}
