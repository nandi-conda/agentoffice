// Shared whiteboard. Strokes use 0..1 coordinates so the full-size editor
// and the tiny board drawn in the boardroom share one source of truth.

export const WB_W = 1200, WB_H = 640;

export function createBoard() {
  const canvas = document.createElement('canvas');
  canvas.width = WB_W; canvas.height = WB_H;
  const ctx = canvas.getContext('2d');
  let strokes = [];

  function drawStroke(s, c = ctx, w = WB_W, h = WB_H) {
    c.strokeStyle = s.color; c.lineWidth = s.size * (w / WB_W);
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    s.points.forEach(([x, y], i) => (i ? c.lineTo(x * w, y * h) : c.moveTo(x * w, y * h)));
    c.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, WB_W, WB_H);
    for (const s of strokes) drawStroke(s);
  }

  return {
    canvas,
    set(list) { strokes = list.slice(); redraw(); },
    add(s) { strokes.push(s); drawStroke(s); },
    clear() { strokes = []; redraw(); },
    drawStroke,
    get strokes() { return strokes; },
  };
}

export function openEditor(modal, board, send) {
  const colors = ['#1f2937', '#ef4444', '#2563eb', '#16a34a', '#f59e0b', '#a855f7', '#ffffff'];
  let color = colors[0], size = 4;
  modal.open(`
    <div class="wb">
      <div class="wb-head">
        <h2>Boardroom whiteboard</h2>
        <div class="wb-tools">
          ${colors.map((c) => `<button class="swatch" data-c="${c}" style="background:${c}" aria-label="colour ${c}"></button>`).join('')}
          <select class="wb-size"><option value="3">Fine</option><option value="6" selected>Marker</option><option value="16">Chunky</option><option value="40">Eraser-size</option></select>
          <button class="btn ghost wb-clear">Clear</button>
        </div>
      </div>
      <canvas class="wb-canvas" width="${WB_W}" height="${WB_H}"></canvas>
      <p class="muted small">Everyone in the office sees this board live. It's also drawn on the wall in the boardroom.</p>
    </div>`, 'wide');
  const el = modal.body;
  const cv = el.querySelector('.wb-canvas');
  const c = cv.getContext('2d');
  const paint = () => { c.fillStyle = '#fff'; c.fillRect(0, 0, WB_W, WB_H); c.drawImage(board.canvas, 0, 0); };
  paint();
  size = 6;
  el.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', () => {
    color = b.dataset.c;
    el.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
  }));
  el.querySelector('.swatch').classList.add('on');
  el.querySelector('.wb-size').addEventListener('change', (e) => (size = +e.target.value));
  el.querySelector('.wb-clear').addEventListener('click', () => { if (confirm('Clear the whiteboard for everyone?')) send({ t: 'wb', op: 'clear' }); });

  let cur = null;
  const pt = (e) => {
    const r = cv.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); cur = { points: [pt(e)], color: color === '#ffffff' ? '#ffffff' : color, size }; });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const p = pt(e), last = cur.points[cur.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.002) return;
    cur.points.push(p);
    board.drawStroke({ ...cur, points: [last, p] }, c);
    if (cur.points.length >= 300) finish();
  });
  const finish = () => {
    if (!cur) return;
    if (cur.points.length === 1) cur.points.push([cur.points[0][0] + 0.001, cur.points[0][1]]);
    board.add(cur);
    send({ t: 'wb', op: 'stroke', points: cur.points, color: cur.color, size: cur.size });
    const tail = cur.points[cur.points.length - 1];
    cur = cur.points.length >= 300 ? { points: [tail], color: cur.color, size: cur.size } : null;
  };
  cv.addEventListener('pointerup', () => { finish(); cur = null; });
  cv.addEventListener('pointercancel', () => { finish(); cur = null; });
  return { repaint: paint };
}
