// Raster -> vector tracing for character sprites.
//
// Each frame is split into flat colour regions. Every region's pixel
// boundary is traced into closed loops, the staircase corners are smoothed
// with Chaikin subdivision, and the result is kept as Path2D objects in
// frame units. A traced silhouette, slightly fattened and filled with a dark
// ink colour, sits underneath to give the characters a clean outline and
// to hide hairline seams between neighbouring regions.

const cache = new WeakMap(); // image -> Map(frameKey -> traced frame)

export function tracedFrame(img, col, row, fr) {
  let m = cache.get(img);
  if (!m) { m = new Map(); cache.set(img, m); }
  const key = `${col},${row}`;
  let t = m.get(key);
  if (t === undefined) {
    try { t = traceFrame(img, col * fr, row * fr, fr); } catch { t = null; }
    m.set(key, t);
  }
  return t;
}

function traceFrame(img, sx, sy, fr) {
  const c = document.createElement('canvas');
  c.width = fr; c.height = fr;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, sx, sy, fr, fr, 0, 0, fr, fr);
  const { data } = g.getImageData(0, 0, fr, fr);

  // Group opaque pixels by exact colour. Faint pixels (baked shadows) are
  // dropped; the renderer draws its own contact shadow.
  const regions = new Map();
  const solid = new Uint8Array(fr * fr);
  for (let i = 0; i < fr * fr; i++) {
    const a = data[i * 4 + 3];
    if (a < 160) continue;
    const r = data[i * 4], gg = data[i * 4 + 1], b = data[i * 4 + 2];
    const k = (r << 16) | (gg << 8) | b;
    let reg = regions.get(k);
    if (!reg) { reg = { color: `rgb(${r},${gg},${b})`, lum: 0.3 * r + 0.59 * gg + 0.11 * b, mask: new Uint8Array(fr * fr), n: 0 }; regions.set(k, reg); }
    reg.mask[i] = 1; reg.n++;
    solid[i] = 1;
  }
  if (!regions.size) return { layers: [], outline: null };

  const ink = [...regions.values()].sort((a, b) => a.lum - b.lum)[0];
  const outline = loopsToPath(traceMask(solid, fr), 2);
  // Big regions first so small details (eyes, highlights) land on top.
  const layers = [...regions.values()]
    .sort((a, b) => b.n - a.n)
    .map((r) => ({ color: r.color, path: loopsToPath(traceMask(r.mask, fr), r.n < 6 ? 1 : 2) }));
  return { layers, outline, ink: ink.lum < 90 ? ink.color : 'rgb(38,30,28)' };
}

// Trace the boundary of a binary mask into closed loops of lattice points.
// Edges are oriented with the inside on the right, so outer boundaries and
// holes come out with opposite winding and 'evenodd' fills them correctly.
function traceMask(mask, n) {
  const at = (x, y) => x >= 0 && y >= 0 && x < n && y < n && mask[y * n + x] === 1;
  const out = new Map(); // "x,y" -> list of [nx, ny]
  const push = (x0, y0, x1, y1) => {
    const k = x0 * 1000 + y0;
    let l = out.get(k); if (!l) { l = []; out.set(k, l); }
    l.push([x1, y1]);
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) push(x, y, x + 1, y);
    if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) push(x, y + 1, x, y);
  }
  const loops = [];
  for (const [k, list] of out) {
    while (list.length) {
      const sx = Math.floor(k / 1000), sy = k % 1000;
      const loop = [[sx, sy]];
      let [cx, cy] = list.pop();
      let px = sx, py = sy;
      let guard = 0;
      while (!(cx === sx && cy === sy) && guard++ < 20000) {
        loop.push([cx, cy]);
        const l = out.get(cx * 1000 + cy);
        if (!l || !l.length) break;
        let pick = 0;
        if (l.length > 1) {
          // At a saddle, prefer turning right to keep diagonal pixels separate.
          const dx = cx - px, dy = cy - py;
          let best = -9;
          l.forEach(([nx, ny], i) => {
            const ex = nx - cx, ey = ny - cy;
            const cross = dx * ey - dy * ex;
            const score = cross > 0 ? 2 : cross === 0 ? 1 : 0;
            if (score > best) { best = score; pick = i; }
          });
        }
        const [nx, ny] = l.splice(pick, 1)[0];
        px = cx; py = cy; cx = nx; cy = ny;
      }
      if (loop.length >= 4) loops.push(simplify(loop));
    }
  }
  return loops;
}

// Drop collinear points so smoothing works on corners only.
function simplify(loop) {
  const out = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out.length >= 3 ? out : loop;
}

function chaikin(pts, iters) {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      q.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = q;
  }
  return p;
}

function loopsToPath(loops, iters) {
  const path = new Path2D();
  for (const loop of loops) {
    const pts = chaikin(loop, iters);
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
  }
  return path;
}

// Draw a traced frame with its top-left at (x, y), scaled so one source
// pixel covers `scale` CSS pixels.
export function drawTraced(ctx, t, x, y, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  if (t.outline) {
    ctx.strokeStyle = t.ink; ctx.lineWidth = 1.6;
    ctx.stroke(t.outline);
    ctx.fillStyle = t.ink; ctx.fill(t.outline, 'evenodd');
  }
  for (const l of t.layers) {
    ctx.fillStyle = l.color;
    ctx.strokeStyle = l.color; ctx.lineWidth = 0.45;
    ctx.fill(l.path, 'evenodd');
    ctx.stroke(l.path);
  }
  ctx.restore();
}
