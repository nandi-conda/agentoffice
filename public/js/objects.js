// Panels for plugin-run objects (jukebox, vending machine, 8-ball, kiosk…).
// A plugin never sends HTML: it sends a small description (title, text,
// items, buttons, a list, a text input) which is rendered here, escaped.
// Every action goes back to the server as { t: 'use', id, action, input }.

import { localize } from './time.js';

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

export function openObject(modal, f, send) {
  const use = (action, input = null) => {
    modal.body.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    send({ t: 'use', id: f.id, action, input });
  };
  const panel = {
    id: f.id,
    show(ui) {
      if (!ui) return;
      renderUi(modal.body, ui, f.name, use);
      if (f.owner) modal.body.insertAdjacentHTML('beforeend', `<p class="muted small obj-by">Uploaded by ${esc(f.owner.handle ? `@${f.owner.handle}` : f.owner.name)}</p>`);
    },
    // The plugin answered without a panel (or failed): let people try again.
    idle() { modal.body.querySelectorAll('button:not([data-off]), input').forEach((el) => { el.disabled = false; }); },
  };
  modal.open(`<h2>${esc(f.name)}</h2><p class="muted small">Connecting…</p>`, 'obj-modal');
  send({ t: 'use', id: f.id, action: 'use' });
  return panel;
}
