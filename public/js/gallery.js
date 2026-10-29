// Objects people upload (docs/uploads.md): a WASM plugin (or, on Cloudflare,
// a JS one) that is a real object: it stands in a room, drawn the way its
// manifest says, or someone carries it in their inventory. The server keeps
// the list (gallery:main) and sends it as { t: 'gallery', items }; each one
// standing in a room becomes a map object here, drawn, prompted and used
// exactly like the office's own (render.js, objects.js).

import { ask } from './ask.js';
import { FURNITURE } from './map.js';
import { readManifest, LOOKS, CARRIED, SURFACES, lookOf } from './manifest.js';
import { PERMISSIONS, LEVELS, levelOf, levelRole, uploadError } from './permissions.js';
import { can } from './roles.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Uploaded as an item: not on the map, one thing its uploader carries (the Skeleton Key).
const carriedLook = (look) => look === CARRIED;
const upLabel = (look) => (carriedLook(look) ? 'Put it in my inventory' : 'Place it next to me');
const MAX_KB = 512;

// Put the objects standing in rooms into FURNITURE, so they draw, prompt
// and interact like the office's own: the look is the furniture type. They
// aren't solid: the server's walls don't know about them.
export function syncGallery(items = []) {
  for (let i = FURNITURE.length - 1; i >= 0; i--) if (FURNITURE[i].uploaded) FURNITURE.splice(i, 1);
  for (const it of items) {
    if (it.carried || !Number.isFinite(it.x)) continue;
    const type = lookOf(it.look === 'sprite' && !it.sprite ? null : it.look);
    FURNITURE.push({
      ...it, type, w: 1, h: 1, solid: false, interact: SURFACES[type] || 'plugin', plugin: 'upload', uploaded: true,
    });
  }
}

// What a plugin may do beyond the basics, in words: "Open booked rooms (privileged)".
const perms = (list) => list.map((p) => PERMISSIONS[p]?.label || p).join(', ');
const levelTag = (it) => (it.level && it.level !== 'basic' ? ` · ${LEVELS[it.level].label.toLowerCase()}: ${esc(perms(it.permissions || []))}` : '');

const by = (it) => (!it.owner ? '' : it.owner.handle ? `@${it.owner.handle}` : it.owner.name);

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The 🧩 panel: what's out there, yours to remove, and an upload form.
// request(op, req) → Promise of the server's answer ({ ok } or { error }).
export function openGallery(modal, { me, items, request, toast, walkTo, moderator = false }) {
  // Moderators can remove anyone's (the office checks again).
  // A carried one is whoever holds it's: they throw it away from the 🎒.
  const mine = (it) => (me.did && it.owner?.did === me.did) || moderator;
  const list = items.length
    ? `<div class="obj-items">${items.map((it) => `
        <div class="obj-item gal-item" data-id="${esc(it.id)}">
          <span><b>${esc(it.emoji)} ${esc(it.name)}</b><br><small class="muted">${esc(it.doc || it.prompt)}</small></span>
          <span class="gal-acts"><small class="muted">${it.owner ? `by ${esc(by(it))} · ` : ''}${it.lang} ${Math.ceil(it.size / 1024)} KB${levelTag(it)}</small>
            ${it.carried ? '<small class="muted">carried by someone</small>' : '<button class="btn ghost gal-go">Walk there</button>'}${mine(it) ? '<button class="btn ghost gal-rm">Remove</button>' : ''}</span>
        </div>`).join('')}</div>`
    : '<p class="muted small">Nothing uploaded yet.</p>';
  const form = me.did ? `
      <h3>Upload one</h3>
      <p class="small muted">A WebAssembly module (≤ ${MAX_KB} KB) that speaks the office's JSON ABI, or a JS module exporting <code>interact()</code> where the office runs on Cloudflare. It stands up in the room next to you, drawn the way you pick; anyone can use it, and only you can pick it up (it goes into your 🎒, to put down somewhere else) or remove it. <a href="/docs/uploads/" target="_blank" rel="noopener">How to write one</a> · <button type="button" class="linkish gal-example">try the example guestbook</button>${can(me.role, LEVELS.privileged.cap) ? ' · <button type="button" class="linkish gal-key">the Skeleton Key</button> (admins only: one key for your inventory that opens booked rooms)' : ''}</p>
      <p class="small gal-perm" hidden></p>
      <div class="gal-form">
        <label class="small"><b>File</b><input type="file" class="gal-file" accept=".wasm,.js,.mjs,application/wasm,text/javascript"></label>
        <label class="small"><b>Name</b><input class="gal-name" maxlength="40" placeholder="Guestbook"></label>
        <label class="small"><b>Prompt</b><input class="gal-prompt" maxlength="60" placeholder="Sign the guestbook"></label>
        <label class="small"><b>What it does</b><input class="gal-doc" maxlength="280" placeholder="Leave a note for the office"></label>
        <div class="row">
          <label class="small"><b>Emoji</b><input class="gal-emoji" maxlength="8" value="🧩"></label>
          <label class="small"><b>Colour</b><input type="color" class="gal-glow" value="#a78bfa"></label>
          <label class="small"><b>Looks like</b><select class="gal-look">${Object.entries(LOOKS).map(([k, v]) => `<option value="${k}"${k === 'sprite' ? ' hidden disabled' : ''}>${esc(v)}</option>`).join('')}</select></label>
        </div>
        <p class="small gal-err" hidden></p>
        <button class="btn primary gal-up">Place it next to me</button>
      </div>`
    : '<p class="small muted">Sign in with your AT Protocol handle to upload your own.</p>';
  modal.open(`<h2>🧩 Uploaded objects</h2>
    <p class="small muted">Plugins people made and put in the office. They run sandboxed, with no network.</p>
    ${list}${form}`, 'gallery-modal');

  const b = modal.body;
  b.querySelectorAll('.gal-item').forEach((row) => {
    const it = items.find((x) => x.id === row.dataset.id);
    row.querySelector('.gal-go')?.addEventListener('click', () => { modal.close(); walkTo(it.x + 0.5, it.y + 1.5); });
    row.querySelector('.gal-rm')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (!(await ask(btn, `Remove ${it.name}? Its code and memory are deleted.`, 'Remove'))) return;
      e.target.disabled = true;
      const r = await request('remove', { id: it.id });
      if (r.error) { toast(esc(r.error)); e.target.disabled = false; } else { toast(`${esc(it.emoji)} ${esc(it.name)} is gone.`); row.remove(); }
    });
  });
  if (!me.did) return;

  let file = null; // { name, lang, bytes }
  const err = (t) => { const p = b.querySelector('.gal-err'); p.textContent = t || ''; p.hidden = !t; };
  const take = (name, bytes) => {
    const lang = /\.m?js$/i.test(name) ? 'js' : 'wasm';
    if (bytes.byteLength > MAX_KB * 1024) return err(`That file is ${Math.ceil(bytes.byteLength / 1024)} KB; ${MAX_KB} KB at most.`);
    file = { name, lang, bytes };
    err('');
    // A module built with the agentoffice-plugin crate says what it is.
    const m = lang === 'wasm' ? readManifest(bytes) : null;
    const set = (c, v) => { if (v) b.querySelector(c).value = v; };
    // What it asks for beyond the basics decides who may upload it.
    const need = b.querySelector('.gal-perm'), list = m?.permissions || [];
    need.hidden = !list.length;
    if (list.length) {
      const lv = levelOf(list), no = uploadError(me.role, list, m.name || 'It');
      need.textContent = `${no ? '⛔' : '🔐'} Needs ${perms(list)} (${LEVELS[lv].label.toLowerCase()}): only ${levelRole(lv)}s and up can upload it.${no ? ' You can\'t.' : ''}`;
      need.classList.toggle('gal-no', !!no);
    }
    if (m) {
      set('.gal-name', m.name); set('.gal-prompt', m.prompt); set('.gal-doc', m.doc);
      set('.gal-emoji', m.emoji); set('.gal-glow', /^#[0-9a-f]{6}$/i.test(m.glow) ? m.glow : '');
      // Its own drawing is only on offer when the module has one.
      const own = b.querySelector('.gal-look option[value=sprite]');
      own.hidden = own.disabled = !m.sprite;
      if (own.disabled && b.querySelector('.gal-look').value === 'sprite') b.querySelector('.gal-look').value = 'kiosk';
      if (LOOKS[m.look]) set('.gal-look', m.look);
    }
    b.querySelector('.gal-up').textContent = upLabel(b.querySelector('.gal-look').value);
    const nm = b.querySelector('.gal-name');
    if (!nm.value) nm.value = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).slice(0, 40);
  };
  b.querySelector('.gal-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) take(f.name, await f.arrayBuffer());
  });
  b.querySelector('.gal-example').addEventListener('click', async () => {
    const r = await fetch('/plugins/guestbook.wasm');
    if (!r.ok) return err('Couldn\'t load the example.');
    take('guestbook.wasm', await r.arrayBuffer()); // its manifest fills in the form
  });
  b.querySelector('.gal-key')?.addEventListener('click', async () => {
    const r = await fetch('/plugins/skeleton_key.wasm');
    if (!r.ok) return err('Couldn\'t load the Skeleton Key.');
    take('skeleton_key.wasm', await r.arrayBuffer());
  });
  b.querySelector('.gal-look').addEventListener('change', (e) => { b.querySelector('.gal-up').textContent = upLabel(e.target.value); });
  b.querySelector('.gal-up').addEventListener('click', async (e) => {
    if (!file) return err('Pick a .wasm (or .js) file first.');
    const val = (c) => b.querySelector(c).value.trim();
    if (!val('.gal-name')) return err('Give it a name.');
    e.target.disabled = true;
    e.target.textContent = 'Uploading…';
    const r = await request('upload', {
      name: val('.gal-name'), lang: file.lang, code: toBase64(file.bytes),
      prompt: val('.gal-prompt') || undefined, doc: val('.gal-doc') || undefined,
      emoji: val('.gal-emoji') || undefined, glow: val('.gal-glow'), look: val('.gal-look'),
    });
    if (r.error) { err(r.error); e.target.disabled = false; e.target.textContent = upLabel(val('.gal-look')); return; }
    modal.close();
    toast(`${esc(r.object.emoji)} <b>${esc(r.object.name)}</b> is ${r.object.carried ? 'in your inventory' : 'on the floor next to you'}.`);
  });
}
