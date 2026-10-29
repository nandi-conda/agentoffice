// The inventory panel: what you carry, what's lying on the floor near you,
// and what you can do with each. A modal on desktop; on phones the modal is
// a bottom sheet (style.css). Every action goes to the server as
// { t: 'inv', op: 'use' | 'drop' | 'give' | 'pickup', id, to?, qty? }, and
// the server answers with { t: 'inv', items } (see server/office.js).

import { PICKUP_RANGE, GIVE_RANGE, GUEST_SLOTS, MAX_SLOTS, label, useButton } from './items.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NEAR_FLOOR = 6; // tiles: floor things worth listing

// ctx: { send, me(), items(), floor(), peers(), keeps(), walkTo(x, y, then) }
export function openInventory(modal, ctx) {
  let giving = null; // stack id whose "give to…" row is open
  const render = () => {
    const me = ctx.me(), items = ctx.items();
    const dist = (o) => Math.hypot(o.x - me.x, o.y - me.y);
    const near = ctx.floor().map((e) => ({ e, d: dist(e) })).filter((x) => x.d <= NEAR_FLOOR).sort((a, b) => a.d - b.d);
    const people = ctx.peers().filter((p) => p.id !== me.id && p.kind !== 'freeq' && dist(p) <= GIVE_RANGE);
    const slots = ctx.keeps() ? MAX_SLOTS : GUEST_SLOTS;
    modal.body.innerHTML = `
      <h2>🎒 Your things <span class="muted small">${items.length}/${slots}</span></h2>
      ${items.length ? `<ul class="inv-list">${items.map((s) => `
        <li class="inv-row" data-id="${esc(s.id)}">
          <span class="inv-emoji" aria-hidden="true">${esc(s.emoji)}</span>
          <span class="inv-name"><b>${esc(s.name)}</b>${s.qty > 1 ? ` <span class="muted">×${s.qty}</span>` : ''}${s.from ? `<small class="muted">from the ${esc(s.from)}</small>` : ''}</span>
          <span class="inv-acts">
            <button class="btn primary inv-use">${esc(useButton(s))}</button>
            <button class="btn inv-give" ${people.length ? '' : 'disabled title="Nobody within 3 tiles"'}>Give</button>
            <button class="btn ghost inv-drop">Drop</button>
          </span>
          ${giving === s.id ? `<span class="inv-to">${people.map((p) => `<button class="btn ghost inv-to-btn" data-to="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</span>` : ''}
        </li>`).join('')}</ul>`
        : '<p class="muted small">Nothing yet. Grab a coffee in the Kitchen, get a snack from the vending machine, or pick up something someone left lying around.</p>'}
      ${near.length ? `<h3>On the floor nearby</h3><ul class="inv-list">${near.map(({ e, d }) => `
        <li class="inv-row" data-floor="${esc(e.id)}">
          <span class="inv-emoji" aria-hidden="true">${esc(e.item.emoji)}</span>
          <span class="inv-name"><b>${esc(e.item.name)}</b>${e.item.qty > 1 ? ` <span class="muted">×${e.item.qty}</span>` : ''}<small class="muted">left by ${esc(e.by || 'someone')}</small></span>
          <span class="inv-acts"><button class="btn inv-pick">${d <= PICKUP_RANGE ? 'Pick up' : 'Walk & pick up'}</button></span>
        </li>`).join('')}</ul>` : ''}
      <p class="muted tiny">${ctx.keeps() ? 'Your things stay with you between visits.' : 'As a guest you carry a few things for this visit only. Sign in to keep them.'}${matchMedia('(pointer: coarse)').matches ? '' : ' Press <kbd>I</kbd> to open this, <kbd>E</kbd> to pick up what\'s at your feet.'}</p>`;
    const row = (el) => el.closest('.inv-row');
    modal.body.querySelectorAll('.inv-use').forEach((b) => b.addEventListener('click', () => ctx.send({ t: 'inv', op: 'use', id: row(b).dataset.id })));
    modal.body.querySelectorAll('.inv-drop').forEach((b) => b.addEventListener('click', () => ctx.send({ t: 'inv', op: 'drop', id: row(b).dataset.id })));
    modal.body.querySelectorAll('.inv-give').forEach((b) => b.addEventListener('click', () => {
      const id = row(b).dataset.id;
      if (people.length === 1) return ctx.send({ t: 'inv', op: 'give', id, to: people[0].id });
      giving = giving === id ? null : id;
      render();
    }));
    modal.body.querySelectorAll('.inv-to-btn').forEach((b) => b.addEventListener('click', () => { ctx.send({ t: 'inv', op: 'give', id: row(b).dataset.id, to: b.dataset.to }); giving = null; }));
    modal.body.querySelectorAll('.inv-pick').forEach((b) => b.addEventListener('click', () => {
      const e = ctx.floor().find((x) => x.id === row(b).dataset.floor);
      if (!e) return;
      if (Math.hypot(e.x - me.x, e.y - me.y) <= PICKUP_RANGE) ctx.send({ t: 'inv', op: 'pickup', id: e.id });
      else { modal.close(); ctx.walkTo(e.x, e.y, { floorItem: e.id, x: e.x, y: e.y, w: 0, h: 0 }); }
    }));
  };
  modal.open('', 'inv-modal');
  render();
  return { refresh: render };
}

// The floor thing within reach of (x, y), nearest first.
export function nearestFloorItem(floor, x, y, max = PICKUP_RANGE) {
  let best = null, bd = max;
  for (const e of floor) {
    const d = Math.hypot(e.x - x, e.y - y);
    if (d <= bd) { bd = d; best = e; }
  }
  return best;
}

export { label };
