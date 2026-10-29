// The desk computer: walk up to a desk, press E (or tap the monitor), and your
// workstation comes up over the office. A small desktop with windows and a
// taskbar; the apps are pluggable (registerApp), and the ones that run on
// WASM plugins (apps.js) get a generic window that draws their panels.
//
// Everything that persists lives in your Workstation entity on the server
// (server/entities/workstation.js): this file only calls it, as
// { t: 'ws', ref, method, args } → { t: 'wsr', ref, result | error }.
// On a phone every window is full screen and the desktop is the launcher.

import { ask } from './ask.js';
import { WS_APPS } from './apps.js';
import { renderUi } from './objects.js';
import { ROOMS, roomById, fmtTime, fmtRange, isHolder } from './rooms.js';
import { localize } from './time.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; d.cancel = () => clearTimeout(t); return d; };
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---- the app registry ------------------------------------------------------------
// An app: { id, name, icon, size: [w, h], mount(body, ctx, opts) → { refresh?(desktop), open?(opts), close?() } }.
// ctx: { call(method, ...args), desktop(), office, open(id, opts), close(), toast(text) }.
export const APPS = new Map();
export function registerApp(app) { APPS.set(app.id, app); return app; }

const WALLPAPERS = {
  dusk: 'linear-gradient(135deg, #1e3a8a 0%, #7c3aed 55%, #db2777 100%)',
  forest: 'linear-gradient(160deg, #064e3b 0%, #15803d 50%, #a3e635 100%)',
  paper: 'linear-gradient(160deg, #f5f3ef 0%, #e7e5e4 100%)',
  night: 'radial-gradient(circle at 70% 20%, #334155 0%, #0f172a 60%, #020617 100%)',
};

export function createWorkstation({ send, office }) {
  let root = null, desk = null, bar = null, desktop = null, seq = 0, z = 10;
  const pending = new Map();
  const wins = new Map(); // app id -> { el, app, inst, min }
  const small = () => matchMedia('(max-width: 720px), (pointer: coarse) and (max-height: 520px)').matches;

  function call(method, ...args) {
    const ref = ++seq;
    send({ t: 'ws', ref, method, args });
    return new Promise((resolve, reject) => {
      pending.set(ref, { resolve, reject });
      setTimeout(() => { if (pending.delete(ref)) reject(new Error('the workstation didn\'t answer')); }, 15000);
    });
  }
  function onReply(m) {
    const p = pending.get(m.ref);
    if (!p) return;
    pending.delete(m.ref);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  }

  const ctx = {
    call, office,
    desktop: () => desktop,
    open: (id, opts) => openApp(id, opts),
    toast: (text) => office.toast(esc(text)),
    // After a change: fetch the desktop again and let every window catch up.
    async reload() {
      try { desktop = await call('desktop'); } catch (e) { return ctx.toast(e.message); }
      for (const w of wins.values()) w.inst?.refresh?.(desktop);
      drawIcons();
      return desktop;
    },
  };

  // ---- layout, kept on the server --------------------------------------------
  const savePrefs = debounce(() => {
    if (!desktop) return;
    const prefs = {
      wallpaper: desktop.prefs?.wallpaper || 'dusk',
      wins: [...wins.values()].map((w) => ({ app: w.app.id, x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight, min: w.min, z: +w.el.style.zIndex || 0 })),
    };
    desktop.prefs = prefs;
    call('prefs', prefs).catch(() => {});
  }, 1200);

  function build() {
    root = h(`<div id="workstation" class="ws" role="dialog" aria-label="Workstation" hidden>
      <div class="ws-screen">
        <div class="ws-desk"><div class="ws-icons"></div>
          <button class="ws-focus" hidden title="Open the focus timer"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ws-ring-bg" cx="60" cy="60" r="52"/><circle class="ws-ring" cx="60" cy="60" r="52" pathLength="100"/></svg>
            <span class="ws-focus-time"></span><span class="ws-focus-label"></span></button>
          <div class="ws-toasts"></div></div>
        <div class="ws-menu" hidden></div>
        <div class="ws-bar">
          <button class="ws-start" title="Apps" aria-haspopup="true">▦ <span>Apps</span></button>
          <div class="ws-tasks"></div>
          <button class="ws-share" title="Put your screen on your desk monitor for people nearby">🖥️ <span>Share</span></button>
          <span class="ws-clock"></span>
          <button class="ws-off" title="Close the workstation (Esc)">⏻</button>
        </div>
      </div>
    </div>`);
    document.body.append(root);
    desk = root.querySelector('.ws-desk');
    bar = root.querySelector('.ws-bar');
    bar.querySelector('.ws-off').onclick = () => close();
    root.querySelector('.ws-focus').onclick = () => openApp('timer');
    bar.querySelector('.ws-share').onclick = () => office.share.toggle();
    const menu = root.querySelector('.ws-menu');
    bar.querySelector('.ws-start').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    root.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.ws-menu, .ws-start')) menu.hidden = true; });
    desk.addEventListener('dblclick', (e) => { if (e.target === desk) for (const w of wins.values()) minimize(w, true); });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); }
      e.stopPropagation(); // the office doesn't walk while you type here
    });
    root.addEventListener('keyup', (e) => e.stopPropagation());
    setInterval(tick, 1000);
  }

  function tick() {
    if (!root || root.hidden) return;
    bar.querySelector('.ws-clock').textContent = fmtTime(office.serverNow());
    const share = bar.querySelector('.ws-share');
    share.classList.toggle('on', office.share.on());
    share.querySelector('span').textContent = office.share.on() ? 'Sharing' : 'Share';
    for (const w of wins.values()) w.inst?.tick?.();
    drawFocus();
  }

  // The focus timer, big on the wallpaper behind the windows while it runs.
  function drawFocus() {
    const el = root.querySelector('.ws-focus'), t = desktop?.timer;
    el.hidden = !t;
    if (!t) return;
    const left = Math.max(0, t.endsAt - office.serverNow()), total = t.minutes * 60000;
    el.querySelector('.ws-ring').style.strokeDashoffset = String(100 - (100 * left) / total);
    el.querySelector('.ws-focus-time').textContent = mmss(left);
    el.querySelector('.ws-focus-label').textContent = t.label;
  }

  function drawIcons() {
    const icons = desk.querySelector('.ws-icons');
    const list = [...APPS.values()].filter((a) => !a.hidden);
    icons.innerHTML = list.map((a) => `<button class="ws-icon" data-app="${esc(a.id)}"><span class="ws-glyph">${esc(a.icon)}</span><span>${esc(a.name)}</span></button>`).join('');
    icons.querySelectorAll('.ws-icon').forEach((b) => (b.onclick = () => openApp(b.dataset.app)));
    const menu = root.querySelector('.ws-menu');
    menu.innerHTML = `${list.map((a) => `<button data-app="${esc(a.id)}"><span>${esc(a.icon)}</span>${esc(a.name)}</button>`).join('')}<hr><button data-show><span>🗔</span>Show desktop</button>`;
    menu.querySelectorAll('[data-app]').forEach((b) => (b.onclick = () => { menu.hidden = true; openApp(b.dataset.app); }));
    menu.querySelector('[data-show]').onclick = () => { menu.hidden = true; for (const w of wins.values()) minimize(w, true); };
    desk.parentElement.style.background = WALLPAPERS[desktop?.prefs?.wallpaper] || WALLPAPERS.dusk;
  }

  function drawTasks() {
    const tasks = bar.querySelector('.ws-tasks');
    tasks.innerHTML = [...wins.values()].map((w) => `<button class="ws-task ${w.min ? 'min' : ''} ${w.el.classList.contains('top') ? 'top' : ''}" data-app="${esc(w.app.id)}" title="${esc(w.app.name)}">${esc(w.app.icon)}<span>${esc(w.app.name)}</span></button>`).join('');
    tasks.querySelectorAll('.ws-task').forEach((b) => (b.onclick = () => {
      const w = wins.get(b.dataset.app);
      if (w.min || !w.el.classList.contains('top')) { minimize(w, false); raise(w); } else minimize(w, true);
    }));
  }

  // ---- windows -------------------------------------------------------------------
  function raise(w) {
    for (const o of wins.values()) o.el.classList.remove('top');
    w.el.style.zIndex = ++z;
    w.el.classList.add('top');
    drawTasks();
  }
  function minimize(w, min) {
    w.min = min;
    w.el.hidden = min;
    if (!min) raise(w); else drawTasks();
    savePrefs();
  }
  function closeWin(id) {
    const w = wins.get(id);
    if (!w) return;
    w.inst?.close?.();
    w.el.remove();
    wins.delete(id);
    drawTasks();
    savePrefs();
  }

  function openApp(id, opts = {}, place = null) {
    const app = APPS.get(id);
    if (!app) return ctx.toast(`No app called ${id}`);
    let w = wins.get(id);
    if (w) {
      minimize(w, false);
      w.inst?.open?.(opts);
      return w;
    }
    const [dw, dh] = app.size || [520, 380];
    const el = h(`<section class="ws-win" aria-label="${esc(app.name)}">
      <header class="ws-title"><span class="ws-ticon">${esc(app.icon)}</span><b>${esc(app.name)}</b>
        <button class="ws-min" title="Minimise">–</button><button class="ws-close" title="Close">×</button></header>
      <div class="ws-body"></div>
    </section>`);
    const area = desk.getBoundingClientRect();
    const n = wins.size;
    const x = place?.x ?? Math.max(8, Math.min(area.width - dw - 8, 112 + n * 28));
    const y = place?.y ?? Math.max(8, Math.min(area.height - dh - 8, 24 + n * 28));
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${Math.min(place?.w ?? dw, area.width - 16)}px`, height: `${Math.min(place?.h ?? dh, area.height - 16)}px` });
    desk.append(el);
    w = { el, app, inst: null, min: false };
    wins.set(id, w);
    el.querySelector('.ws-close').onclick = () => closeWin(id);
    el.querySelector('.ws-min').onclick = () => minimize(w, true);
    el.addEventListener('pointerdown', () => { if (!el.classList.contains('top')) raise(w); }, true);
    drag(el, w);
    new ResizeObserver(() => savePrefs()).observe(el);
    raise(w);
    try { w.inst = app.mount(el.querySelector('.ws-body'), ctx, opts) || {}; }
    catch (e) { el.querySelector('.ws-body').textContent = `This app failed to start: ${e.message}`; }
    if (place?.min) minimize(w, true);
    savePrefs();
    return w;
  }

  function drag(el, w) {
    const head = el.querySelector('.ws-title');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || small()) return;
      const area = desk.getBoundingClientRect();
      const ox = e.clientX - el.offsetLeft, oy = e.clientY - el.offsetTop;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        el.style.left = `${Math.max(-el.offsetWidth + 80, Math.min(area.width - 80, ev.clientX - ox))}px`;
        el.style.top = `${Math.max(0, Math.min(area.height - 32, ev.clientY - oy))}px`;
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); savePrefs(); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
  }

  // ---- open / close ----------------------------------------------------------------
  async function open(opts = {}) {
    if (!root) build();
    if (!root.hidden) { if (opts.app) openApp(opts.app, opts); return; }
    root.hidden = false;
    root.classList.toggle('small', small());
    desk.querySelector('.ws-icons').innerHTML = '<p class="ws-boot">Starting up…</p>';
    send({ t: 'ws', method: 'power', on: true });
    try { desktop = await call('desktop'); }
    catch (e) {
      desk.querySelector('.ws-icons').innerHTML = `<p class="ws-boot">${esc(e.message)}</p>`;
      return;
    }
    for (const a of desktop.apps || []) if (!APPS.has(a.id)) registerApp(pluginApp(a));
    drawIcons();
    // Bring back the windows as they were left, unless this is a phone.
    if (!wins.size) {
      const saved = (desktop.prefs?.wins || []).filter((s) => APPS.has(s.app)).sort((a, b) => a.z - b.z);
      if (saved.length && !small()) for (const s of saved) openApp(s.app, {}, s);
      else if (!saved.length && !small()) openApp('todo');
    }
    for (const w of wins.values()) w.inst?.refresh?.(desktop);
    if (opts.app) openApp(opts.app, opts);
    tick();
    root.querySelector('.ws-start').focus();
  }

  function close() {
    if (!root || root.hidden) return;
    savePrefs.flush();
    root.hidden = true;
    send({ t: 'ws', method: 'power', on: false });
    for (const id of [...wins.keys()]) closeWin(id);
    office.closed?.();
  }

  // Something changed elsewhere (the timer rang, an agent wrote a note).
  function poke() { if (root && !root.hidden) ctx.reload(); }

  return {
    open, close, onReply, poke, call,
    get isOpen() { return !!root && !root.hidden; },
    get desktop() { return desktop; },
  };
}

// ---- the built-in apps -----------------------------------------------------------

registerApp({
  id: 'notes', name: 'Notes', icon: '📝', size: [620, 420],
  mount(body, ctx) {
    body.innerHTML = `<div class="ws-notes">
      <aside><button class="btn primary ws-new">New note</button><ul class="ws-list"></ul></aside>
      <div class="ws-edit"><input class="ws-ntitle" maxlength="80" placeholder="Title"><textarea class="ws-ntext" placeholder="Write anything. It saves as you type and comes up at any desk."></textarea>
      <div class="ws-row"><span class="ws-saved muted small"></span><button class="btn ghost ws-del">Delete</button></div></div>
    </div>`;
    const list = body.querySelector('.ws-list'), title = body.querySelector('.ws-ntitle'), text = body.querySelector('.ws-ntext'), saved = body.querySelector('.ws-saved');
    let cur = null, dirty = false, shown = 0;
    const save = debounce(async () => {
      if (!dirty) return;
      dirty = false;
      const was = shown;
      saved.textContent = 'Saving…';
      try {
        const n = await ctx.call('noteSave', { id: cur?.id, title: title.value, text: text.value });
        const d = ctx.desktop();
        d.notes = [n, ...d.notes.filter((x) => x.id !== n.id)];
        if (was === shown) { cur = n; saved.textContent = `Saved ${fmtTime(n.updated)}`; }
        draw();
      } catch (e) { saved.textContent = e.message; }
    }, 700);
    const show = (n) => {
      save.flush();
      shown++;
      cur = n;
      title.value = n?.title || ''; text.value = localize(n?.text || '');
      saved.textContent = n ? `Saved ${fmtTime(n.updated)}` : '';
      draw();
    };
    function draw() {
      const notes = ctx.desktop()?.notes || [];
      list.innerHTML = notes.map((n) => `<li><button class="${n.id === cur?.id ? 'on' : ''}" data-id="${esc(n.id)}"><b>${esc(n.title)}</b><small>${esc(localize(n.text).slice(0, 60))}</small></button></li>`).join('') || '<li class="muted small">No notes yet.</li>';
      list.querySelectorAll('button').forEach((b) => (b.onclick = () => show(notes.find((n) => n.id === b.dataset.id))));
    }
    title.oninput = text.oninput = () => { dirty = true; save(); };
    body.querySelector('.ws-new').onclick = () => { show(null); title.focus(); };
    body.querySelector('.ws-del').onclick = async () => {
      if (!cur) return show(null);
      if (!(await ask(body.querySelector('.ws-del'), `Delete “${cur.title}”?`, 'Delete'))) return;
      dirty = false; save.cancel();
      await ctx.call('noteDelete', cur.id).catch((e) => ctx.toast(e.message));
      cur = null;
      await ctx.reload();
      show(ctx.desktop().notes[0] || null);
    };
    show(ctx.desktop()?.notes?.[0] || null);
    return {
      refresh(d) { if (cur) cur = d.notes.find((n) => n.id === cur.id) || cur; if (!dirty && document.activeElement !== text && document.activeElement !== title && cur) { title.value = cur.title; text.value = localize(cur.text); } draw(); },
      close() { save.flush(); },
    };
  },
});

registerApp({
  id: 'todo', name: 'Todo', icon: '✅', size: [380, 440],
  mount(body, ctx) {
    body.innerHTML = `<form class="ws-row ws-add"><input maxlength="200" placeholder="Add a todo…"><button class="btn primary">Add</button></form>
      <ul class="ws-todos"></ul><div class="ws-row"><span class="muted small ws-count"></span><button class="btn ghost ws-clear">Clear done</button></div>`;
    const form = body.querySelector('form'), inp = form.querySelector('input'), ul = body.querySelector('.ws-todos');
    const act = async (p) => { try { await p; } catch (e) { ctx.toast(e.message); } await ctx.reload(); };
    form.onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; inp.value = ''; act(ctx.call('todoAdd', v)); };
    body.querySelector('.ws-clear').onclick = () => act(ctx.call('todoRemove', 'done'));
    function draw(d = ctx.desktop()) {
      const todos = d?.todos || [];
      ul.innerHTML = todos.map((t) => `<li class="${t.done ? 'done' : ''}"><label><input type="checkbox" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}><span>${esc(t.text)}</span></label><button class="ws-x" data-id="${esc(t.id)}" title="Remove">×</button></li>`).join('') || '<li class="muted small">Nothing on your list.</li>';
      ul.querySelectorAll('input').forEach((c) => (c.onchange = () => act(ctx.call('todoSet', { id: c.dataset.id, done: c.checked }))));
      ul.querySelectorAll('.ws-x').forEach((b) => (b.onclick = () => act(ctx.call('todoRemove', b.dataset.id))));
      const left = todos.filter((t) => !t.done).length;
      body.querySelector('.ws-count').textContent = todos.length ? `${left} to go, ${todos.length - left} done` : '';
    }
    draw();
    setTimeout(() => inp.focus(), 0);
    return { refresh: draw };
  },
});

registerApp({
  id: 'terminal', name: 'Terminal', icon: '⌨️', size: [600, 380],
  mount(body, ctx) {
    const me = ctx.office.me();
    const prompt = `${(me?.handle || me?.name || 'you').split('.')[0].replace(/\s+/g, '').toLowerCase()}@${ctx.office.deskId() || 'desk'}:~$`;
    body.innerHTML = `<div class="ws-term"><pre class="ws-out"></pre><form class="ws-line"><span>${esc(prompt)}</span><input autocomplete="off" spellcheck="false" maxlength="500" aria-label="Command"></form></div>`;
    const out = body.querySelector('.ws-out'), form = body.querySelector('form'), inp = form.querySelector('input');
    const history = []; let hi = 0;
    const print = (s, cls = '') => { const span = document.createElement('span'); if (cls) span.className = cls; span.textContent = `${localize(s)}\n`; out.append(span); out.scrollTop = out.scrollHeight; };
    print('Office shell. Type help for commands.', 'muted');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const line = inp.value; inp.value = '';
      if (line.trim()) { history.push(line); hi = history.length; }
      print(`${prompt} ${line}`, 'ws-cmd');
      const cmd = line.trim().split(/\s+/)[0];
      if (cmd === 'clear') { out.textContent = ''; return; }
      if (cmd === 'exit') return ctx.office.closeStation();
      if (!line.trim()) return;
      inp.disabled = true;
      try {
        const r = await ctx.call('run', line);
        if (r.open === 'clear') out.textContent = '';
        else if (r.out) print(r.out);
        if (r.open && r.open !== 'clear') ctx.open(r.open, r.url ? { url: r.url } : {});
        if (/^(todo|jot|timer|bookmark)$/.test(cmd)) ctx.reload();
      } catch (err) { print(err.message, 'ws-err'); }
      inp.disabled = false; inp.focus();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && hi > 0) { inp.value = history[--hi]; e.preventDefault(); }
      else if (e.key === 'ArrowDown') { hi = Math.min(history.length, hi + 1); inp.value = history[hi] || ''; e.preventDefault(); }
    });
    body.addEventListener('pointerup', () => { if (!getSelection().toString()) inp.focus(); });
    setTimeout(() => inp.focus(), 0);
    return { open: () => inp.focus() };
  },
});

registerApp({
  id: 'browser', name: 'Browser', icon: '🌐', size: [760, 500],
  mount(body, ctx, opts) {
    body.innerHTML = `<div class="ws-browser">
      <form class="ws-row ws-url"><button type="button" class="ws-home" title="Start page">⌂</button><input maxlength="500" placeholder="Type a link, or pick a bookmark" aria-label="Address"><button class="btn primary">Go</button>
        <button type="button" class="ws-star" title="Bookmark this page">☆</button><button type="button" class="ws-ext" title="Open in a new tab">↗</button></form>
      <div class="ws-page"></div>
      <p class="ws-hint muted small" hidden>Lots of sites refuse to show up inside another page. If this stays blank, open it in a new tab with ↗.</p>
    </div>`;
    const form = body.querySelector('form'), inp = form.querySelector('input'), page = body.querySelector('.ws-page'), hint = body.querySelector('.ws-hint');
    let url = null;
    const clean = (u) => {
      u = String(u || '').trim();
      if (!u) return null;
      if (u.startsWith('/')) return u;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
      try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
    };
    function start() {
      url = null; inp.value = ''; hint.hidden = true;
      const links = ctx.desktop()?.links || [];
      page.innerHTML = `<div class="ws-start-page">
        <h3>Bookmarks</h3>
        <ul class="ws-links">${links.map((l) => `<li><button class="linkish" data-url="${esc(l.url)}">${esc(l.title)}</button><small class="muted">${esc(l.url)}</small><button class="ws-x" data-id="${esc(l.id)}" title="Remove">×</button></li>`).join('') || '<li class="muted small">None yet: open a page and press ☆.</li>'}</ul>
        <h3>In the office</h3>
        <ul class="ws-links"><li><button class="linkish" data-url="/docs/">Office guide and API docs</button></li><li><button class="linkish" data-url="/api/office">Who's in (JSON)</button></li></ul>
      </div>`;
      page.querySelectorAll('[data-url]').forEach((b) => (b.onclick = () => go(b.dataset.url)));
      page.querySelectorAll('.ws-x').forEach((b) => (b.onclick = async () => { await ctx.call('linkRemove', b.dataset.id).catch((e) => ctx.toast(e.message)); await ctx.reload(); start(); }));
    }
    function go(u) {
      const href = clean(u);
      if (!href) return ctx.toast('Only http(s) links, or office pages like /docs');
      url = href; inp.value = href;
      page.innerHTML = '';
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.src = href;
      page.append(f);
      hint.hidden = href.startsWith('/') || new URL(href, location.href).origin === location.origin;
    }
    form.onsubmit = (e) => { e.preventDefault(); go(inp.value); };
    body.querySelector('.ws-home').onclick = start;
    body.querySelector('.ws-ext').onclick = () => { if (url) window.open(url, '_blank', 'noopener'); };
    body.querySelector('.ws-star').onclick = async () => {
      if (!url) return ctx.toast('Open a page first');
      const title = prompt('Bookmark as', url.replace(/^https?:\/\//, '').slice(0, 80));
      if (title === null) return;
      try { await ctx.call('linkAdd', { url, title }); ctx.toast('Bookmarked'); await ctx.reload(); } catch (e) { ctx.toast(e.message); }
    };
    if (opts?.url) go(opts.url); else start();
    return { open: (o) => o?.url && go(o.url), refresh: () => { if (!url) start(); } };
  },
});

registerApp({
  id: 'calendar', name: 'Calendar', icon: '📅', size: [520, 460],
  mount(body, ctx) {
    function draw() {
      const now = ctx.office.serverNow(), me = ctx.office.me();
      const list = ctx.office.bookings().filter((b) => b.end > now).sort((a, b) => a.start - b.start);
      const days = new Map();
      for (const b of list) {
        const d = new Date(b.start), key = d.toDateString();
        if (!days.has(key)) days.set(key, []);
        days.get(key).push(b);
      }
      const today = new Date(now).toDateString(), tomorrow = new Date(now + 86400000).toDateString();
      body.innerHTML = `<div class="ws-cal">
        <div class="ws-row"><b>Meeting rooms</b><span class="grow"></span><button class="btn primary ws-book">Book a room</button></div>
        ${list.length ? [...days].map(([k, bs]) => `<h4>${k === today ? 'Today' : k === tomorrow ? 'Tomorrow' : esc(new Date(bs[0].start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }))}</h4>
          <ul>${bs.map((b) => `<li class="${me && isHolder(b, me) ? 'mine' : ''} ${b.start <= now ? 'now' : ''}"><span class="ws-when">${esc(fmtRange(b))}</span><span><b>${esc(b.title)}</b><small>${esc(roomById(b.room)?.name || b.room)} · ${esc(b.name)}${b.start <= now ? ' · now' : ''}</small></span></li>`).join('')}</ul>`).join('')
        : `<p class="muted">No bookings coming up in ${ROOMS.map((r) => esc(r.name)).join(', ')}.</p>`}
      </div>`;
      body.querySelector('.ws-book').onclick = () => ctx.office.openSchedule();
    }
    draw();
    let n = 0;
    return { refresh: draw, tick: () => { if (++n % 30 === 0 && !body.matches(':hover')) draw(); } };
  },
});

registerApp({
  id: 'timer', name: 'Focus timer', icon: '⏱️', size: [340, 300],
  mount(body, ctx) {
    body.innerHTML = `<div class="ws-timer">
      <div class="ws-big">--:--</div><p class="ws-label muted"></p>
      <div class="ws-row ws-presets"><button class="btn ghost" data-m="15">15 min</button><button class="btn ghost" data-m="25">25 min</button><button class="btn ghost" data-m="50">50 min</button></div>
      <div class="ws-row"><input class="ws-tlabel" maxlength="60" placeholder="What for? (optional)"><input class="ws-tmin" type="number" min="1" max="240" value="25" aria-label="Minutes"></div>
      <div class="ws-row"><button class="btn primary ws-go">Start</button><button class="btn ghost ws-stop">Stop</button></div>
      <p class="muted small">It rings even if you've walked off, or left the office: you'll get a note.</p></div>`;
    const big = body.querySelector('.ws-big'), label = body.querySelector('.ws-label');
    const start = async (m) => {
      try { await ctx.call('timerStart', { minutes: +m, label: body.querySelector('.ws-tlabel').value }); } catch (e) { ctx.toast(e.message); }
      await ctx.reload();
    };
    body.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => start(b.dataset.m)));
    body.querySelector('.ws-go').onclick = () => start(body.querySelector('.ws-tmin').value);
    body.querySelector('.ws-stop').onclick = async () => { await ctx.call('timerStop').catch(() => {}); await ctx.reload(); };
    function tick() {
      const t = ctx.desktop()?.timer;
      big.textContent = t ? mmss(t.endsAt - ctx.office.serverNow()) : '--:--';
      label.textContent = t ? `${t.label} · rings at ${fmtTime(t.endsAt)}` : 'No timer running';
      body.querySelector('.ws-stop').disabled = !t;
    }
    tick();
    return { tick, refresh: tick };
  },
});

registerApp({
  id: 'share', name: 'Desk monitor', icon: '🖥️', size: [420, 340],
  mount(body, ctx) {
    body.innerHTML = `<div class="ws-sharer"><video autoplay playsinline muted></video>
      <p class="small ws-share-text"></p><div class="ws-row"><button class="btn primary ws-share-go"></button></div></div>`;
    const v = body.querySelector('video');
    function tick() {
      const on = ctx.office.share.on();
      body.querySelector('.ws-share-go').textContent = on ? 'Stop sharing' : 'Share my screen';
      body.querySelector('.ws-share-text').textContent = on
        ? 'Your screen is up on your desk monitor. People within a few steps with audio on can watch it.'
        : 'Put your screen on your desk monitor, so whoever walks up to your desk can watch (they need audio on).';
      const s = ctx.office.share.stream();
      if (v.srcObject !== s) v.srcObject = s;
      v.hidden = !s;
    }
    body.querySelector('.ws-share-go').onclick = async () => { await ctx.office.share.toggle(); tick(); };
    tick();
    return { tick };
  },
});

registerApp({
  id: 'settings', name: 'Wallpaper', icon: '🎨', size: [360, 220],
  mount(body, ctx) {
    body.innerHTML = `<div class="ws-walls">${Object.entries(WALLPAPERS).map(([k, bg]) => `<button data-w="${k}" style="background:${bg}" title="${k}"></button>`).join('')}</div>`;
    body.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => {
      const d = ctx.desktop();
      d.prefs = { ...(d.prefs || {}), wallpaper: b.dataset.w };
      body.closest('.ws-screen').style.background = WALLPAPERS[b.dataset.w];
      ctx.call('prefs', d.prefs).catch(() => {});
    }));
    return {};
  },
});

// An app that runs on a WASM plugin: its panels, drawn like the objects'.
function pluginApp(a) {
  return {
    id: a.id, name: a.name, icon: a.icon, size: [420, 380],
    mount(body, ctx) {
      body.innerHTML = '<p class="muted small">Connecting…</p>';
      const use = async (action = 'use', input = null) => {
        body.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
        try {
          const r = await ctx.call('app', { app: a.id, action, input });
          if (!r) return;
          if (r.toast) ctx.toast(r.toast);
          if (r.ui) renderUi(body, r.ui, a.name, use);
          else body.querySelectorAll('button:not([data-off]), input').forEach((el) => { el.disabled = false; });
        } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
      };
      use();
      return {};
    },
  };
}
for (const a of WS_APPS) registerApp(pluginApp(a));
