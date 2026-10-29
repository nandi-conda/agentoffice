// Byte Snake, the game the arcade cabinets play, and one of the browser games a plugin's panel can ask for
// (Ui::game("snake", action)): mounted into el above the panel, and a
// finished round's score goes to onScore. Returns { stop }.
export function mountSnake(el, { onScore }) {
  const N = 20, CELL = 22;
  el.innerHTML = `
    <div class="arcade">
      <p class="muted small">Arrow keys or WASD. Eat the bugs, ship the features.</p>
      <canvas class="snake" width="${N * CELL}" height="${N * CELL}"></canvas>
    </div>`;
  const cv = el.querySelector('.snake');
  const ctx = cv.getContext('2d');

  let snake, dir, next, food, score, dead, timer;
  function reset() {
    snake = [[10, 10], [9, 10], [8, 10]]; dir = [1, 0]; next = dir; score = 0; dead = false;
    place();
    clearInterval(timer); timer = setInterval(tick, 110);
  }
  function place() {
    do { food = [(Math.random() * N) | 0, (Math.random() * N) | 0]; } while (snake.some((s) => s[0] === food[0] && s[1] === food[1]));
  }
  function tick() {
    dir = next;
    const head = [snake[0][0] + dir[0], snake[0][1] + dir[1]];
    if (head[0] < 0 || head[1] < 0 || head[0] >= N || head[1] >= N || snake.some((s) => s[0] === head[0] && s[1] === head[1])) {
      dead = true; clearInterval(timer);
      if (score > 0) onScore(score);
      draw(); return;
    }
    snake.unshift(head);
    if (head[0] === food[0] && head[1] === food[1]) { score += 10; place(); } else snake.pop();
    draw();
  }
  function draw() {
    ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + y) % 2) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    // the bug
    const [fx, fy] = food;
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath(); ctx.ellipse(fx * CELL + 11, fy * CELL + 12, 6, 7, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#f43f5e'; ctx.lineWidth = 1.5;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(fx * CELL + 11, fy * CELL + 10); ctx.lineTo(fx * CELL + 11 + s * 9, fy * CELL + 6); ctx.stroke(); }
    snake.forEach(([x, y], i) => {
      ctx.fillStyle = i === 0 ? '#86efac' : `hsl(${140 + i * 3}, 70%, ${55 - Math.min(i, 20)}%)`;
      ctx.beginPath(); ctx.roundRect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4, 6); ctx.fill();
    });
    ctx.fillStyle = '#fff'; ctx.font = '600 14px Inter, system-ui'; ctx.fillText(`score ${score}`, 10, 20);
    if (dead) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 26px Inter, system-ui';
      ctx.fillText('segfault!', cv.width / 2, cv.height / 2 - 10);
      ctx.font = '500 14px Inter, system-ui'; ctx.fillText('press space to retry', cv.width / 2, cv.height / 2 + 18);
      ctx.textAlign = 'left';
    }
  }
  const keys = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
  const onKey = (e) => {
    const k = keys[e.key];
    if (k && !(k[0] === -dir[0] && k[1] === -dir[1])) { next = k; e.preventDefault(); e.stopPropagation(); }
    if (e.key === ' ' && dead) { reset(); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey, true);
  reset();
  return { stop() { clearInterval(timer); window.removeEventListener('keydown', onKey, true); } };
}
