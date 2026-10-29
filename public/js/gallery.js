// Objects people upload (docs/uploads.md): a WASM plugin (or, on Cloudflare,
// a JS one) placed on the map next to its uploader. The server keeps the list
// (gallery:main) and sends it as { t: 'gallery', items }; each item becomes a
// map object here, used like any other plugin object (objects.js).

import { FURNITURE } from './map.js';
import { readManifest } from './manifest.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const LOOKS = { plinth: 'Plinth with its emoji', kiosk: 'Screen kiosk', jukebox: 'Jukebox', vending: 'Vending machine', eightball: 'Crystal ball' };
const MAX_KB = 512;

// Put the uploaded objects into FURNITURE, so they draw, prompt and
// interact like the built-in ones. They aren't solid: the server's walls
// don't know about them.
export function syncGallery(items = []) {
  for (let i = FURNITURE.length - 1; i >= 0; i--) if (FURNITURE[i].uploaded) FURNITURE.splice(i, 1);
  for (const it of items) {
    FURNITURE.push({
      ...it, type: it.look === 'plinth' || !LOOKS[it.look] ? 'upload' : it.look,
      w: 1, h: 1, solid: false, interact: 'plugin', plugin: 'upload', uploaded: true,
    });
  }
}

const by = (it) => (it.owner.handle ? `@${it.owner.handle}` : it.owner.name);

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
  const mine = (it) => (me.did && it.owner.did === me.did) || moderator;
  const list = items.length
    ? `<div class="obj-items">${items.map((it) => `
        <div class="obj-item gal-item" data-id="${esc(it.id)}">
          <span><b>${esc(it.emoji)} ${esc(it.name)}</b><br><small class="muted">${esc(it.doc || it.prompt)}</small></span>
          <span class="gal-acts"><small class="muted">by ${esc(by(it))} · ${it.lang} ${Math.ceil(it.size / 1024)} KB</small>
            <button class="btn ghost gal-go">Walk there</button>${mine(it) ? '<button class="btn ghost gal-rm">Remove</button>' : ''}</span>
        </div>`).join('')}</div>`
    : '<p class="muted small">Nothing uploaded yet.</p>';
  const form = me.did ? `
      <h3>Upload one</h3>
      <p class="small muted">A WebAssembly module (≤ ${MAX_KB} KB) that speaks the office's JSON ABI, or a JS module exporting <code>interact()</code> where the office runs on Cloudflare. It goes on the floor next to you; anyone can use it, and only you can remove it. <a href="/docs/uploads/" target="_blank" rel="noopener">How to write one</a> · <button type="button" class="linkish gal-example">try the example guestbook</button></p>
      <div class="gal-form">
        <label class="small"><b>File</b><input type="file" class="gal-file" accept=".wasm,.js,.mjs,application/wasm,text/javascript"></label>
        <label class="small"><b>Name</b><input class="gal-name" maxlength="40" placeholder="Guestbook"></label>
        <label class="small"><b>Prompt</b><input class="gal-prompt" maxlength="60" placeholder="Sign the guestbook"></label>
        <label class="small"><b>What it does</b><input class="gal-doc" maxlength="280" placeholder="Leave a note for the office"></label>
        <div class="row">
          <label class="small"><b>Emoji</b><input class="gal-emoji" maxlength="8" value="🧩"></label>
          <label class="small"><b>Colour</b><input type="color" class="gal-glow" value="#a78bfa"></label>
          <label class="small"><b>Looks like</b><select class="gal-look">${Object.entries(LOOKS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
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
    row.querySelector('.gal-go').addEventListener('click', () => { modal.close(); walkTo(it.x + 0.5, it.y + 1.5); });
    row.querySelector('.gal-rm')?.addEventListener('click', async (e) => {
      if (!confirm(`Remove ${it.name}? Its code and memory are deleted.`)) return;
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
    if (m) {
      set('.gal-name', m.name); set('.gal-prompt', m.prompt); set('.gal-doc', m.doc);
      set('.gal-emoji', m.emoji); set('.gal-glow', /^#[0-9a-f]{6}$/i.test(m.glow) ? m.glow : '');
      if (LOOKS[m.look]) set('.gal-look', m.look);
    }
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
    if (r.error) { err(r.error); e.target.disabled = false; e.target.textContent = 'Place it next to me'; return; }
    modal.close();
    toast(`${esc(r.object.emoji)} <b>${esc(r.object.name)}</b> is on the floor next to you.`);
  });
}
