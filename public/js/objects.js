// Panels for plugin-run objects (jukebox, vending machine, 8-ball…).
// A plugin never sends HTML: it sends a small description (title, text,
// items, buttons, a list, a text input) which is rendered here, escaped.
// Every action goes back to the server as { t: 'use', id, action, input }.

import { localize } from './time.js';
import { mountSnake } from './snake.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// **bold** and line breaks are the only formatting plugins get.
// Times arrive as <t:ms> stamps (the SDK's stamp()) and show in local time.
const rich = (s) => esc(localize(s)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

// Draw a plugin's panel into el; use(action, input) is called for each choice.
// Shared by the objects on the map and the workstation apps that run on plugins.
export function renderUi(el, ui, title, use) {
  el.innerHTML = `
    <h2>${esc(ui.title || title)}</h2>
    ${ui.text ? `<p class="obj-text">${rich(ui.text)}</p>` : ''}
    ${ui.items?.length ? `<div class="obj-items">${ui.items.map((it, i) => `
      <button class="obj-item" data-i="${i}" ${it.disabled ? 'disabled data-off' : ''}>
        <span>${esc(it.label)}</span>${it.detail ? `<small class="muted">${esc(localize(it.detail))}</small>` : ''}
      </button>`).join('')}</div>` : ''}
    ${ui.list?.rows?.length ? `<p class="small"><b>${esc(ui.list.title)}</b></p><ol class="obj-list small">${ui.list.rows.map((r) => `<li>${esc(localize(r))}</li>`).join('')}</ol>` : ''}
    ${ui.input ? `<div class="row obj-ask"><input maxlength="${ui.input.maxLength}" placeholder="${esc(ui.input.placeholder)}"><button class="btn primary obj-send">${esc(ui.input.button)}</button></div>` : ''}
    ${ui.buttons?.length ? `<div class="row">${ui.buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : 'ghost'} obj-btn" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}`;
  el.querySelectorAll('.obj-item').forEach((b) => b.addEventListener('click', () => use(ui.items[+b.dataset.i].action)));
  el.querySelectorAll('.obj-btn').forEach((b) => b.addEventListener('click', () => use(ui.buttons[+b.dataset.i].action)));
  const inp = el.querySelector('.obj-ask input');
  if (inp) {
    const go = () => inp.value.trim() && use(ui.input.action, inp.value.trim());
    el.querySelector('.obj-send').addEventListener('click', go);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    inp.focus();
  }
}

// The browser games a panel can ask for (Ui::game): kind -> mount(el, { onScore }).
const GAMES = { snake: mountSnake };

// One object's panel, for any object: the office's own and uploaded ones
// alike. f.entity: another object whose plugin this one shares (the second
// arcade cabinet). opts.pickUp: shown when it's yours to pick up.
export function openObject(modal, f, send, { mine = false, pickUp = null } = {}) {
  const id = f.entity || f.id;
  let game = null; // { kind, stop }
  const ui = () => modal.body.querySelector('.obj-ui');
  const use = (action, input = null) => {
    ui().querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    send({ t: 'use', id, action, input });
  };
  const stopGame = () => { game?.stop(); game = null; };
  const panel = {
    id,
    show(u) {
      if (!u) return;
      // A game keeps playing while the panel next to it changes (a new high score).
      const want = u.game && GAMES[u.game.kind] ? u.game : null;
      const wrap = modal.body.querySelector('.obj-wrap');
      if (game && game.kind !== want?.kind) { stopGame(); wrap.classList.remove('obj-play'); wrap.querySelector('.obj-game').innerHTML = ''; }
      if (want && !game) {
        wrap.classList.add('obj-play');
        const g = GAMES[want.kind](wrap.querySelector('.obj-game'), { onScore: (n) => send({ t: 'use', id, action: `${want.action}:${n}` }) });
        game = { kind: want.kind, stop: g.stop };
      }
      renderUi(ui(), u, f.name, use);
      const foot = [];
      if (f.owner) foot.push(`<span class="muted small">Set up by ${esc(f.owner.handle ? `@${f.owner.handle}` : f.owner.name)}</span>`);
      if (mine && pickUp) foot.push('<button class="btn ghost obj-pick" title="It goes into your inventory; put it down anywhere">🎒 Pick it up</button>');
      if (foot.length) {
        ui().insertAdjacentHTML('beforeend', `<div class="row obj-by">${foot.join(' ')}</div>`);
        ui().querySelector('.obj-pick')?.addEventListener('click', () => { modal.close(); pickUp(); });
      }
    },
    // The plugin answered without a panel (or failed): let people try again.
    idle() { ui()?.querySelectorAll('button:not([data-off]), input').forEach((el) => { el.disabled = false; }); },
    close: stopGame,
  };
  modal.open(`<div class="obj-wrap"><div class="obj-game"></div><div class="obj-ui"><h2>${esc(f.name)}</h2><p class="muted small">Connecting…</p></div></div>`, 'obj-modal');
  send({ t: 'use', id, action: 'use' });
  return panel;
}
