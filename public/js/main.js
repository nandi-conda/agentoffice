import { W, H, ZONES, FURNITURE, DESKS, SEATS, SPAWN, HEAR_RADIUS, isBlocked, zoneAt, canHear, findPath, nearestInteractable } from './map.js';
import { createRenderer, EMOJI } from './render.js';
import { sheetsFor, facing } from './sprites.js';
import { tracedFrame, drawTraced } from './trace.js';
import { STATUS, statusColor, colorFor } from './style.js';
import { connect } from './net.js';
import { createVoice } from './rtc.js';
import { createBoard, openEditor } from './whiteboard.js';
import { openSnake } from './snake.js';
import { openObject } from './objects.js';
import { createMusic } from './music.js';
import { ROOMS, MIN, RULES, roomById, roomStatus, activeBooking, isHolder, lockedOut, forRoom, keyOf, fmtTime, fmtRange } from './rooms.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(`ao:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ao:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---- state ----------------------------------------------------------------
const peers = new Map();
let me = null;
let net = null;
let desks = {}, notes = [], pomo = {}, counters = {}, scores = [], bookings = [];
let freeqRooms = {}; // area id -> { channel, members, topic } attached from freeq
let objects = {}; // plugin object id -> { display, bubble } (see objects.js)
let serverOffset = 0;
const serverNow = () => Date.now() + serverOffset;
const board = createBoard();
let path = null, walkTarget = null, follow = null;
let autoStatus = null; // status set automatically (and which one), so we can undo it
let lastCoffee = 0;
let vector = store.get('vector', true);
let k = null;
// ?hour=14 pins the office lighting to a time of day (handy for demos).
const hourParam = new URLSearchParams(location.search).get('hour');
const clockNow = () => { const d = new Date(); if (hourParam !== null) d.setHours(+hourParam, 0, 0, 0); return d; };

// Phones and tablets: touch controls, a lighter frame rate when idle, smaller panels.
const coarse = matchMedia('(pointer: coarse)').matches;
const phone = () => Math.min(innerWidth, innerHeight) <= 500;

const canvas = $('#world');
const R = createRenderer(canvas);
R.resize();
addEventListener('resize', () => { R.resize(); clampZoom(); });

function clampZoom() {
  const levels = R.zoomLevels();
  if (k !== null && levels.includes(k)) return;
  // Phones start at 1:1 so a room fits on screen; bigger screens start mid-way.
  k = phone() ? levels.reduce((a, b) => (Math.abs(Math.log(b / R.dpr)) < Math.abs(Math.log(a / R.dpr)) ? b : a))
    : levels[Math.min(levels.length - 1, Math.max(0, Math.floor(levels.length / 2)))];
}
clampZoom();

// ---- modal --------------------------------------------------------------------
const modal = {
  el: $('#modal'), body: $('#modal .modal-body'), onclose: null,
  open(html, cls = '') {
    this.close();
    $('#modal .modal').className = `modal card ${cls}`;
    this.body.innerHTML = html;
    this.el.hidden = false;
  },
  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.body.innerHTML = '';
    const f = this.onclose; this.onclose = null; f?.();
  },
  get isOpen() { return !this.el.hidden; },
};
$('#modal .close').addEventListener('click', () => modal.close());
$('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') modal.close(); });

function toast(html, actions = [], ms = 6000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${html}</span>`;
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { fn(); t.remove(); };
    t.append(b);
  }
  $('.toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

function chime(kind = 'soft') {
  try {
    const a = chime.ctx || (chime.ctx = new AudioContext());
    const notes = kind === 'focus' ? [523, 659, 784] : kind === 'break' ? [784, 659, 523] : [880, 1175];
    notes.forEach((f, i) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, a.currentTime + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.12, a.currentTime + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + i * 0.12 + 0.5);
      o.connect(g).connect(a.destination);
      o.start(a.currentTime + i * 0.12); o.stop(a.currentTime + i * 0.12 + 0.55);
    });
  } catch { /* audio unavailable */ }
}

// ---- login ----------------------------------------------------------------
const handleIn = $('#handle'), nameIn = $('#name'), noteIn = $('#note');
handleIn.value = store.get('handle', '');
nameIn.value = store.get('name', '');
noteIn.value = store.get('note', '');
let loginActor = null;
let previewTimer = null;

async function previewFor(handle) {
  const pv = $('#preview'), text = $('.preview-text');
  const g = pv.getContext('2d');
  g.clearRect(0, 0, 96, 96);
  loginActor = null;
  let sheets;
  if (handle) {
    text.textContent = `Looking up @${handle}…`;
    try {
      const r = await fetch(`/api/actor?id=${encodeURIComponent(handle)}`);
      const a = await r.json();
      if (!r.ok) throw new Error(a.error || 'lookup failed');
      if (handleIn.value.trim().replace(/^@/, '') !== handle) return;
      loginActor = a;
      if (!nameIn.value) nameIn.placeholder = a.displayName || a.handle;
      sheets = await sheetsFor({ actor: { sprite: a.sprite }, did: a.did, name: a.handle });
      const emotes = Object.keys(a.sprite?.emotes || {}).length;
      text.innerHTML = a.sprite
        ? `<b>${esc(a.displayName || a.handle)}</b><br>rpg.actor character found${emotes ? ` with ${emotes} emotes` : ''}${a.stats?.length ? ` · ${a.stats.length} stat sheet${a.stats.length > 1 ? 's' : ''}` : ''}.`
        : `<b>${esc(a.displayName || a.handle)}</b><br>No rpg.actor sprite yet, so you'll get a stock rpg.actor character. <a href="https://rpg.actor/generator" target="_blank" rel="noopener">Make one</a>`;
    } catch (e) {
      text.textContent = `Couldn't load @${handle}: ${e.message}. You can still walk in as a guest.`;
    }
  } else {
    text.innerHTML = 'Enter a handle to load your <a href="https://rpg.actor" target="_blank" rel="noopener">rpg.actor</a> character, sprite, emotes and stats.';
  }
  if (!sheets) sheets = await sheetsFor({ name: nameIn.value || 'guest' });
  drawPortrait(g, sheets, 96);
}

function drawPortrait(g, sheets, size) {
  g.clearRect(0, 0, size, size);
  const fr = sheets.frame || 48;
  const t = vector ? tracedFrame(sheets.base, 1, 0, fr) : null;
  if (t) drawTraced(g, t, 0, 0, size / fr);
  else { g.imageSmoothingEnabled = false; g.drawImage(sheets.base, fr, 0, fr, fr, 0, 0, size, size); }
}

handleIn.addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => previewFor(handleIn.value.trim().replace(/^@/, '')), 450);
});
nameIn.addEventListener('input', () => { if (!handleIn.value.trim()) previewFor(''); });
previewFor(handleIn.value.trim().replace(/^@/, ''));

$('#enter').addEventListener('click', enter);
for (const el of [handleIn, nameIn, noteIn]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });

// Who the server says we are. Only a finished AT Protocol sign-in sets this;
// the handle box on its own just previews a character.
let account = null;
const cleanHandle = () => handleIn.value.trim().replace(/^@/, '');
let accountChecked = false;
function updateEnter() {
  const h = cleanHandle();
  $('#enter').disabled = !accountChecked;
  $('#enter').textContent = !accountChecked ? 'Checking sign-in…' : account ? 'Walk in' : h ? `Sign in as @${h}` : 'Walk in as a guest';
}
handleIn.addEventListener('input', updateEnter);

async function loadAccount() {
  const params = new URLSearchParams(location.search);
  const err = params.get('auth_error');
  if (err) { const p = $('.auth-error'); p.textContent = err; p.hidden = false; }
  if (params.has('auth_error') || params.has('signedin')) history.replaceState(null, '', location.pathname + location.hash);
  try {
    const r = await fetch('/api/me');
    const a = await r.json();
    account = a.did ? a : null;
  } catch { account = null; }
  accountChecked = true;
  $('.signed-in').hidden = !account;
  $('.handle-field').hidden = !!account;
  if (account) {
    $('.who').textContent = account.handle ? `@${account.handle}` : account.did;
    if (account.handle) { handleIn.value = account.handle; previewFor(account.handle); }
  }
  updateEnter();
  // Signed in already (just now, or on an earlier visit): the session cookie
  // lasts 30 days, so a refresh walks straight back in.
  if (account) enter();
}
async function signOut() {
  await fetch('/oauth/logout', { method: 'POST' }).catch(() => {});
  account = null;
  store.set('handle', '');
  location.reload();
}
$('.signout').addEventListener('click', signOut);
// Fresh OAuth round trip for the same handle (or DID), e.g. when freeq needs a new session.
function signInAgain() {
  location.href = `/oauth/login?handle=${encodeURIComponent(me?.handle || account?.handle || me?.did || '')}`;
}
updateEnter();
const accountReady = loadAccount();

let entered = false;
async function enter() {
  // Never decide "not signed in" before /api/me has answered, or a quick
  // Enter on a prefilled handle would start a fresh OAuth sign-in.
  await accountReady;
  if (entered) return;
  const handle = cleanHandle();
  store.set('handle', handle); store.set('name', nameIn.value.trim()); store.set('note', noteIn.value.trim());
  if (handle && !account) {
    location.href = `/oauth/login?handle=${encodeURIComponent(handle)}`;
    return;
  }
  entered = true;
  const name = nameIn.value.trim() || account?.displayName || loginActor?.displayName || account?.handle || `guest-${Math.random().toString(36).slice(2, 6)}`;
  $('#login').hidden = true;
  $('#hud').hidden = false;
  start({ name, note: noteIn.value.trim() });
}

// ---- networking -------------------------------------------------------------
const voice = createVoice({ send: (m) => net.send(m), myId: () => me?.id || '', onMedia: (ended) => mediaChanged(ended) });

function start(hello) {
  net = connect(onMessage, () => net.send({ t: 'hello', ...hello, status: me?.status }), ({ replaced }) => sys(replaced ? 'You opened the office in another tab or device, so this one left. Reload to come back here.' : 'Connection lost, reconnecting…'));
  requestAnimationFrame(loop);
}

async function addPeer(p) {
  const peer = { ...p, rx: p.x, ry: p.y, sheets: null, bubble: null };
  peers.set(p.id, peer);
  peer.sheets = await sheetsFor(peer);
  refreshPeople();
  return peer;
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome': {
      serverOffset = (m.now || Date.now()) - Date.now();
      peers.clear();
      const pos = me ? { x: me.x, y: me.y } : null;
      me = { ...m.you, rx: m.you.x, ry: m.you.y, sheets: null };
      if (pos) { me.x = me.rx = pos.x; me.y = me.ry = pos.y; net.send({ t: 'move', x: me.x, y: me.y, dir: me.dir, moving: false, teleport: true }); }
      peers.set(me.id, me);
      sheetsFor(me).then((s) => { me.sheets = s; buildEmotes(); });
      for (const p of m.peers) addPeer(p);
      desks = m.desks; notes = m.notes; pomo = m.pomo; counters = m.counters; scores = m.scores; bookings = m.bookings || [];
      freeqRooms = m.freeq || {};
      objects = {};
      for (const [id, display] of Object.entries(m.objects || {})) objects[id] = { display };
      refreshChannels();
      board.set(m.strokes);
      for (const s of m.shouts || []) logChat(s);
      setStatusUI();
      refreshPeople();
      if (!welcomeShown) { welcomeShown = true; sys(coarse ? `Welcome in, ${me.name}. Tap the floor to walk, or drag anywhere to steer. Pinch to zoom, tap ? for help.` : `Welcome in, ${me.name}. Walk with WASD or click the floor. Press ? for help.`); }
      break;
    }
    case 'join': addPeer(m.peer).then(() => m.peer.kind !== 'freeq' && presence(m.peer.name, 'in')); break;
    case 'leave': {
      const p = peers.get(m.id);
      if (p) { if (p.kind !== 'freeq') presence(p.name, 'out'); peers.delete(m.id); if (follow === m.id) follow = null; refreshPeople(); }
      break;
    }
    case 'move': {
      const p = peers.get(m.id);
      if (!p || p === me) break;
      p.x = m.x; p.y = m.y; p.dir = m.dir; p.moving = m.moving; p.seat = m.seat;
      track(p);
      break;
    }
    case 'peer': {
      const p = peers.get(m.id);
      if (!p) break;
      for (const key of ['status', 'note', 'emote', 'audio', 'video', 'screen', 'cup', 'seat']) if (key in m) p[key] = m[key];
      if (p === me && 'seat' in m) me.seat = m.seat;
      refreshPeople();
      break;
    }
    case 'chat': {
      const p = peers.get(m.id);
      if (p) { p.bubble = { text: m.text, at: performance.now(), scope: m.scope }; p.lastChat = performance.now(); }
      logChat(m);
      if (m.mention && m.id !== me.id) {
        chime();
        toast(`<b>${esc(m.name)}</b> mentioned you: ${esc(m.text)}`, m.far && p ? [['Walk over', () => walkTo(p.x, p.y)]] : []);
      }
      break;
    }
    case 'desks': desks = m.desks; refreshPeople(); break;
    // A plugin object changed how it looks, or said something to the people near it.
    case 'obj': {
      const o = (objects[m.id] ||= {});
      if ('display' in m) o.display = m.display;
      if (m.say) {
        o.bubble = { text: m.say, at: performance.now() };
        const f = FURNITURE.find((x) => x.id === m.id);
        if (canHear(me, m)) logChat({ id: `obj:${m.id}`, name: f?.name || m.id, text: m.say, ts: serverNow(), scope: 'nearby' });
      }
      break;
    }
    case 'objui': {
      if (m.toast) toast(esc(m.toast));
      if (modal.obj?.id !== m.id) break;
      if (m.ui) modal.obj.show(m.ui); else if (m.toast && !modal.body.querySelector('button')) modal.close(); else modal.obj.idle();
      break;
    }
    case 'freeq': freeqRooms = m.rooms || {}; if (me) zoneChanged(lastZone, true); refreshChannels(); break;
    case 'notes': notes = m.notes; if (modal.notesOpen) openNotes(); break;
    case 'pomo': {
      if (m.now) serverOffset = m.now - Date.now();
      const before = pomo.focus?.phase;
      pomo = m.pomo; counters = m.counters || counters;
      const z = me && zoneAt(me.x, me.y);
      const after = pomo.focus?.phase;
      if (before !== after && z?.id === 'focus') {
        chime(after === 'focus' ? 'focus' : 'break');
        toast(after === 'focus' ? '🍅 Focus session started. Heads down!' : after === 'break' ? '🌿 Break time. Stretch, hydrate, chat.' : 'Focus session ended.');
      }
      break;
    }
    case 'counters': counters = m.counters; break;
    case 'wb': if (m.op === 'clear') board.clear(); else board.add(m.stroke); modal.wb?.repaint(); break;
    case 'scores': scores = m.scores; modal.snake?.scores(scores); break;
    case 'wave': {
      const p = peers.get(m.from);
      chime();
      // A knock on a locked room I'm holding can be answered by letting them in.
      const z = zoneAt(me.x, me.y);
      const b = z?.bookable && activeBooking(bookings, z.id, serverNow());
      const letIn = m.kind === 'knock' && p && b && b.lock && isHolder(b, me) && !isHolder(b, p);
      toast(`${m.kind === 'knock' ? '🚪' : '👋'} <b>${esc(m.name)}</b> ${m.kind === 'knock' ? 'is knocking' : 'waved at you'}`, p ? [
        ...(letIn ? [['Let in', () => net.send({ t: 'book', op: 'admit', id: b.id, to: p.id })]] : []),
        ['Walk over', () => walkTo(p.x, p.y)], ['Wave back', () => net.send({ t: 'wave', to: p.id })],
      ] : [], letIn ? 15000 : 6000);
      break;
    }
    case 'bookings': {
      bookings = m.bookings;
      // Don't redraw the booking form out from under someone typing in it.
      const typingInModal = modal.isOpen && modal.body.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), select');
      if (!typingInModal) modal.rooms?.();
      break;
    }
    case 'booked': {
      const b = m.booking, room = roomById(b.room);
      if (b.cancelled) toast(`📅 Cancelled “${esc(b.title)}”`);
      else if (m.ref === 'new') toast(`📅 Booked ${esc(room.name)} ${dayWord(b.start)} ${fmtRange(b)}: “${esc(b.title)}”`);
      modal.rooms?.();
      break;
    }
    case 'roomnote': {
      const room = roomById(m.room);
      const go = ['soon', 'start', 'invite', 'admit'].includes(m.kind) && zoneAt(me.x, me.y)?.id !== m.room;
      chime(m.kind === 'start' ? 'focus' : 'soft');
      toast(esc(m.text), go ? [['Walk there', () => walkInto(room)]] : [], 9000);
      break;
    }
    case 'bounce': {
      me.x = me.rx = m.x; me.y = me.ry = m.y; me.seat = null;
      path = null; walkTarget = null; pendingUse = null; follow = null;
      if (performance.now() - (onMessage.bounced || 0) > 4000) {
        onMessage.bounced = performance.now();
        toast(esc(m.text), [['Knock', () => knock(m.room)]], 8000);
      }
      break;
    }
    case 'toast': toast(esc(m.text)); break;
    // How the freeq bridge is doing for you: a line in the chat log, and a toast when something failed.
    case 'freeq-note': {
      sys(`${m.ok ? '💬' : '⚠️'} ${m.text}`);
      // A lost or expired sign-in: one click goes back through your PDS and returns here.
      if (!m.ok) toast(`⚠️ ${esc(m.text)}`, /sign in again/i.test(m.text) && me?.did ? [['Sign in again', signInAgain]] : [], 10000);
      break;
    }
    case 'rtc': voice.onSignal(m.from, m.data); break;
    case 'error': toast(`⚠️ ${esc(m.message)}`); break;
    case 'replaced': toast(esc(m.text)); break;
  }
}
let welcomeShown = false;

// ---- chat -------------------------------------------------------------------
const log = $('.chat-log');
function logChat(m) {
  const d = document.createElement('div');
  d.className = `m ${m.scope === 'office' ? 'office' : ''} ${m.mention ? 'mention' : ''}`;
  const scope = m.scope === 'nearby' ? '' : `<span class="sc">${esc(m.scope === 'office' ? '📣 office' : m.scope)}</span>`;
  // Said on freeq while the office wasn't listening, caught up after a restart.
  const when = m.backfill ? `<span class="missed" title="Said on freeq while the office was away">${esc(new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span> ` : '';
  d.innerHTML = `${scope}${when}<b style="color:${colorFor(m.id)}">${esc(m.name)}</b> ${linkify(esc(m.text))}`;
  pushLog(d);
}
function sys(text) {
  const d = document.createElement('div');
  d.className = 'm sys'; d.textContent = text;
  pushLog(d, true);
}
// Comings and goings fold into one line until someone says something, so a busy
// doorway doesn't push the conversation out of view.
let presenceLine = null;
function presence(name, how) {
  if (!presenceLine || presenceLine.el !== log.lastElementChild) {
    const el = document.createElement('div');
    el.className = 'm sys presence';
    presenceLine = { el, names: new Map() };
    pushLog(el, true);
  }
  const { el, names } = presenceLine;
  const was = names.get(name);
  names.set(name, !was ? how : was === how ? how : 'passed');
  const group = (state) => [...names].filter(([, v]) => v === state).map(([n]) => n);
  const list = (ns) => (ns.length > 3 ? `${ns.slice(0, 3).join(', ')} +${ns.length - 3}` : ns.join(', '));
  const ins = group('in'), outs = group('out'), passed = group('passed');
  el.textContent = [
    ins.length && `${list(ins)} walked in`,
    outs.length && `${list(outs)} left`,
    passed.length && `${passed.length === 1 ? passed[0] : `${passed.length} people`} came and went`,
  ].filter(Boolean).join(' · ');
  el.title = [ins.length && `In: ${ins.join(', ')}`, outs.length && `Left: ${outs.join(', ')}`, passed.length && `Came and went: ${passed.join(', ')}`].filter(Boolean).join('\n');
  stickToBottom();
}
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
const stickToBottom = () => { log.scrollTop = log.scrollHeight; };
function pushLog(d, quiet = false) {
  const stick = nearBottom();
  log.append(d);
  while (log.children.length > 120) log.firstChild.remove();
  if (stick || !quiet) stickToBottom();
  if (!quiet && chatCollapsed) setUnread(unread + 1);
}

// The chat panel collapses to its input row and resizes from its top edge.
const chatEl = $('.chat'), chatHead = $('.chat-head'), unreadEl = $('.chat-head .unread');
let chatCollapsed = store.get('chatCollapsed', phone()), unread = 0;
function setUnread(n) { unread = n; unreadEl.textContent = n > 99 ? '99+' : n; unreadEl.hidden = !n; }
function setChatCollapsed(c) {
  chatCollapsed = c; store.set('chatCollapsed', c);
  chatEl.classList.toggle('collapsed', c);
  chatHead.setAttribute('aria-expanded', String(!c));
  if (!c) { setUnread(0); stickToBottom(); }
}
setChatCollapsed(chatCollapsed);
chatHead.addEventListener('click', () => setChatCollapsed(!chatCollapsed));
const chatH = store.get('chatHeight', 0);
if (chatH) chatEl.style.setProperty('--chat-h', `${chatH}px`);
$('.chat-grip').addEventListener('pointerdown', (e) => {
  if (chatCollapsed) return;
  e.preventDefault();
  const grip = e.currentTarget, startY = e.clientY, startH = log.getBoundingClientRect().height;
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const h = Math.max(80, Math.min(innerHeight - 220, startH + startY - ev.clientY));
    chatEl.style.setProperty('--chat-h', `${Math.round(h)}px`);
    stickToBottom();
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    store.set('chatHeight', Math.round(log.getBoundingClientRect().height));
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
});
const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

const chatIn = $('.chat-input');
$('.chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatIn.value.trim();
  if (!text) { chatIn.blur(); return; }
  net.send({ t: 'chat', text });
  chatIn.value = '';
  chatIn.blur();
});
chatIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') chatIn.blur(); });
chatIn.addEventListener('focus', () => { if (chatCollapsed) setChatCollapsed(false); });

// On-screen keyboards shrink the visual viewport but not the layout one, so
// lift everything pinned to the bottom of the HUD by the part the keyboard covers.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
    document.body.classList.toggle('kb-open', kb > 80);
    if (kb > 80) stickToBottom();
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}
chatIn.addEventListener('blur', () => { if (vv?.offsetTop) scrollTo(0, 0); });

// ---- popovers (status, emotes) -----------------------------------------------
let openPop = null;
function togglePop(btn) {
  const pop = document.getElementById(btn.dataset.pop);
  const show = pop.hidden;
  closePop();
  if (!show) return;
  pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
  openPop = { pop, btn };
  pop.querySelector('input, select, button')?.focus();
}
function closePop() {
  if (!openPop) return;
  openPop.pop.hidden = true; openPop.btn.setAttribute('aria-expanded', 'false');
  openPop = null;
}
document.querySelectorAll('[data-pop]').forEach((b) => b.addEventListener('click', () => togglePop(b)));
addEventListener('pointerdown', (e) => { if (openPop && !e.target.closest('.pop-wrap')) closePop(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPop) { const { btn } = openPop; closePop(); btn.focus(); btn.blur(); } }, true);

// ---- toolbar ----------------------------------------------------------------
const statusSel = $('.status-select');
statusSel.innerHTML = Object.entries(STATUS).map(([k, v]) => `<option value="${k}">● ${v.label}</option>`).join('');
statusSel.addEventListener('change', () => { autoStatus = null; setStatus(statusSel.value); });
const noteBox = $('.note-input');
noteBox.addEventListener('change', () => {
  net.send({ t: 'status', note: noteBox.value });
  store.set('note', noteBox.value);
  if (me) { me.note = noteBox.value; setStatusUI(); }
  const mine = Object.entries(desks).find(([, v]) => v.owner === ownerKey());
  if (mine) net.send({ t: 'desk', action: 'goal', desk: mine[0], goal: noteBox.value });
});
noteBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { noteBox.blur(); closePop(); } });

function setStatus(s) {
  if (!me || me.status === s) return;
  me.status = s;
  net.send({ t: 'status', status: s });
  setStatusUI();
}
function setStatusUI() {
  if (!me) return;
  statusSel.value = me.status;
  statusSel.style.color = statusColor(me.status);
  if (document.activeElement !== noteBox) noteBox.value = me.note || '';
  const btn = $('.status-btn');
  btn.querySelector('.dot').style.background = statusColor(me.status);
  btn.querySelector('.status-text').textContent = me.note || STATUS[me.status]?.label || me.status;
  btn.title = `${STATUS[me.status]?.label || me.status}${me.note ? ` · ${me.note}` : ''}. Click to change.`;
}

const micBtn = $('.mic');
micBtn.addEventListener('click', toggleMic);
async function toggleMic() {
  if (!voice.on) {
    const ok = await voice.enable();
    if (!ok) return toast('🎙️ Microphone permission was blocked. Allow it in your browser to talk.');
    net.send({ t: 'audio', on: true });
    me.audio = true;
    micBtn.className = 'tb mic on';
    toast('🎙️ Voice on. People near you (or in the same room) can hear you.');
  } else if (!voice.muted) {
    voice.setMuted(true);
    micBtn.className = 'tb mic muted';
  } else {
    voice.disable();
    net.send({ t: 'audio', on: false });
    me.audio = false;
    micBtn.className = 'tb mic';
  }
}

const vecBtn = $('.vec');
vecBtn.classList.toggle('on', vector);
vecBtn.addEventListener('click', toggleVector);
function toggleVector() {
  vector = !vector; store.set('vector', vector);
  vecBtn.classList.toggle('on', vector);
  toast(vector ? '◆ Characters are traced to vector' : '▦ Characters drawn as crisp pixels', [], 2000);
}

$('.zoom-in').addEventListener('click', () => zoom(1));
$('.zoom-out').addEventListener('click', () => zoom(-1));
function zoom(d) {
  const levels = R.zoomLevels();
  const i = Math.max(0, Math.min(levels.length - 1, levels.indexOf(k) + d));
  k = levels[i];
}
// Pinch: snap to the zoom step nearest the pinched scale (steps keep sprites crisp).
function pinchTo(k0, ratio) {
  const want = Math.log(k0 * ratio);
  k = R.zoomLevels().reduce((a, b) => (Math.abs(Math.log(b) - want) < Math.abs(Math.log(a) - want) ? b : a));
}
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });

const FALLBACK_EMOTES = ['wave', 'happy', 'love', 'clap', 'idea', 'party', 'thumbs', 'coffee', 'focus'];
let emoteList = FALLBACK_EMOTES;
function buildEmotes() {
  const own = Object.keys(me.sheets?.emotes || {});
  // rpg.actor emotes first (they animate the character), then a wave.
  emoteList = own.length ? ['wave', ...own].slice(0, 9) : FALLBACK_EMOTES;
  const box = $('.emotes');
  box.innerHTML = emoteList.map((e, i) => `<button title="${e} (${i + 1})" data-e="${e}">${EMOJI[e] || '✨'}<kbd>${i + 1}</kbd></button>`).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { emote(b.dataset.e); closePop(); }));
}
let emoteTimer = null;
function emote(name) {
  me.emote = name;
  net.send({ t: 'emote', name });
  clearTimeout(emoteTimer);
  emoteTimer = setTimeout(() => { me.emote = null; net.send({ t: 'emote', name: null }); }, 4000);
}

$('.help-btn').addEventListener('click', openHelp);
function openHelp() {
  modal.open(`
    <h2>How the office works</h2>
    <div class="help-grid">
      ${coarse ? `<kbd>Tap</kbd><span>Walk there. Tap a person for their profile, or furniture to use it</span>
      <kbd>Drag</kbd><span>Steer with a joystick that appears under your finger</span>
      <kbd>Pinch</kbd><span>Zoom in and out</span>
    </div>
    <details style="margin-top:12px"><summary class="small">With a keyboard</summary>
    <div class="help-grid" style="margin-top:8px">` : ''}
      <kbd>WASD</kbd><span>Walk (or click anywhere on the floor)</span>
      <kbd>E</kbd><span>Interact: sit, claim a desk, whiteboard, coffee, pomodoro, arcade, jukebox, vending machine, 8-ball, help kiosk</span>
      <kbd>Enter</kbd><span>Chat with people who can hear you</span>
      <kbd>1-9</kbd><span>Emotes. With an rpg.actor sprite these swap in your own emote sheets</span>
      <kbd>M</kbd><span>Proximity voice: on → muted → off</span>
      <kbd>N</kbd><span>Mute or unmute music from the jukebox</span>
      <kbd>B</kbd><span>Meeting rooms: schedule and booking</span>
      <kbd>C</kbd><span>Camera on/off (in A/V rooms)</span>
      <kbd>V</kbd><span>Toggle traced-vector characters / original pixels</span>
      <kbd>+ −</kbd><span>Zoom</span>
    </div>${coarse ? '</details>' : ''}
    <h3 style="margin-top:16px">Who hears you</h3>
    <p class="small">In open areas, anyone within a few steps. In the <b>Boardroom</b>, <b>Huddle Room</b> and <b>Phone Booths</b>, only people in the same room. The <b>Deep Work Den</b> is text-only and runs a shared pomodoro. Start a message with <code>/shout</code> to reach the whole office, or <code>@name</code> to tap someone anywhere.</p>
    <h3>Meeting rooms</h3>
    <p class="small">Book the Boardroom, Huddle Room or a phone booth from the 📅 button or the panel by each door. The Boardroom and Huddle Room are <b>A/V rooms</b>: inside, turn on your camera or share your screen with everyone in the room. A <b>locked</b> booking keeps everyone but invitees out (knock to be let in); bookings nobody turns up to are released after 10 minutes.</p>
    <h3>Agents</h3>
    <p class="small">AI agents can work here too. They connect over the same WebSocket protocol, claim desks and answer @mentions. See <code>scripts/agent.mjs</code>.</p>
    <p class="small" style="margin-top:12px">People without their own sprite wear stock <a href="https://rpg.actor/generator" target="_blank" rel="noopener">rpg.actor</a> characters. Generator art by <a href="https://bsky.app/profile/isilme.reverie.house" target="_blank" rel="noopener">isilme</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>.</p>`);
}

// ---- people list & minimap ---------------------------------------------------
const peopleHead = $('.people-head');
function setPeopleCollapsed(c) {
  $('.people').classList.toggle('collapsed', c);
  peopleHead.setAttribute('aria-expanded', String(!c));
  store.set('peopleCollapsed', c);
}
setPeopleCollapsed(store.get('peopleCollapsed', innerWidth <= 760 || phone()));
peopleHead.addEventListener('click', () => setPeopleCollapsed(!$('.people').classList.contains('collapsed')));
let peopleTimer = null;
function refreshPeople() {
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(() => {
    const list = [...peers.values()].sort((a, b) => (a === me ? -1 : b === me ? 1 : a.name.localeCompare(b.name)));
    $('.people .count').textContent = list.length;
    $('.people-list').innerHTML = list.map((p) => {
      const z = zoneAt(p.x, p.y);
      const sub = [p.note, z?.name].filter(Boolean).join(' · ');
      return `<li data-id="${p.id}"><span class="dot" style="background:${statusColor(p.status)}"></span><span class="who"><b>${esc(p.name)}${p === me ? ' (you)' : ''} ${p.kind === 'agent' ? '<span class="badge">AGENT</span>' : p.kind === 'freeq' ? '<span class="badge freeq">FREEQ</span>' : ''}</b><span>${esc(sub)}</span></span>${p.audio ? '🎙️' : ''}</li>`;
    }).join('');
    $('.people-list').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => openProfile(peers.get(li.dataset.id))));
  }, 120);
}
setInterval(refreshPeople, 5000);

// ---- freeq channels: what's attached where; click one to walk there ---------
const channelsHead = $('.channels-head');
function setChannelsCollapsed(c) {
  $('.channels').classList.toggle('collapsed', c);
  channelsHead.setAttribute('aria-expanded', String(!c));
  store.set('channelsCollapsed', c);
}
setChannelsCollapsed(store.get('channelsCollapsed', phone()));
channelsHead.addEventListener('click', () => setChannelsCollapsed(!$('.channels').classList.contains('collapsed')));
const ago = (t) => {
  const s = Math.max(0, (serverNow() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
function refreshChannels() {
  const here = me && zoneAt(me.x, me.y)?.id;
  const list = Object.entries(freeqRooms).map(([zoneId, c]) => ({ ...c, zone: ZONES.find((z) => z.id === zoneId) })).filter((c) => c.zone)
    .sort((a, b) => (b.last || 0) - (a.last || 0) || b.members - a.members || a.channel.localeCompare(b.channel));
  $('.channels').hidden = !list.length;
  $('.channels .count').textContent = list.length;
  $('.channel-list').innerHTML = list.map((c) => {
    const live = c.last && serverNow() - c.last < 5 * 60000;
    const sub = [c.zone.name, c.last ? ago(c.last) : c.topic].filter(Boolean).join(' · ');
    return `<li class="${c.zone.id === here ? 'here' : ''}"><button type="button" data-zone="${c.zone.id}" title="${esc(c.topic ? `${c.channel}: ${c.topic}` : c.channel)}. Walk to the ${esc(c.zone.name)}">`
      + `<span class="hash" aria-hidden="true">#</span><span class="who"><b>${live ? '<span class="live" title="Active in the last 5 minutes"></span>' : ''}${esc(c.channel.replace(/^#/, ''))}</b><span>${esc(sub)}</span></span>`
      + `<span class="members" title="${c.members} in the channel${c.here !== undefined && c.here !== c.members ? `, ${c.here} standing in the ${esc(c.zone.name)} (the rest are drawn in another area they're in)` : ''}">${c.members} 👤</span></button></li>`;
  }).join('');
  $('.channel-list').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => walkToZone(ZONES.find((z) => z.id === b.dataset.zone))));
}
setInterval(refreshChannels, 30000);

// Walk into an area: its middle, or the open tile nearest it when that's furniture.
function walkToZone(z) {
  if (!z || !me) return;
  if (zoneAt(me.x, me.y)?.id === z.id) return toast(`You're already in the ${esc(z.name)}.`, [], 2500);
  const cx = (z.x0 + z.x1 + 1) / 2, cy = (z.y0 + z.y1 + 1) / 2;
  const spots = [];
  for (let y = z.y0; y <= z.y1; y++) for (let x = z.x0; x <= z.x1; x++) if (!isBlocked(x, y)) spots.push({ x: x + 0.5, y: y + 0.5, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
  spots.sort((a, b) => a.d - b.d);
  for (const s of spots.slice(0, 12)) if (findPath(me.x, me.y, s.x, s.y)) return walkTo(s.x, s.y);
  toast(`Couldn't find a way into the ${esc(z.name)}.`, [], 3000);
}

const mini = $('#minimap');
const mg = mini.getContext('2d');
function drawMinimap() {
  const sx = mini.width / W, sy = mini.height / H;
  mg.clearRect(0, 0, mini.width, mini.height);
  mg.fillStyle = '#f5f2ec'; mg.fillRect(0, 0, mini.width, mini.height);
  const tint = { open: '#e7dcc9', room: '#d7e7d7', quiet: '#d6deee' };
  for (const z of ZONES) {
    mg.fillStyle = z.id.startsWith('booth') && z.kind === 'room' ? '#e4d6e8' : tint[z.kind];
    mg.fillRect(z.x0 * sx, z.y0 * sy, (z.x1 - z.x0 + 1) * sx, (z.y1 - z.y0 + 1) * sy);
  }
  mg.fillStyle = '#57534e';
  for (const f of FURNITURE) if (f.solid && f.type !== 'plant') mg.fillRect(f.x * sx, f.y * sy, f.w * sx, f.h * sy);
  for (const p of peers.values()) {
    mg.fillStyle = p === me ? '#2563eb' : p.kind === 'agent' ? '#0891b2' : statusColor(p.status);
    mg.beginPath(); mg.arc(p.rx * sx, p.ry * sy, p === me ? 4 : 3, 0, 7); mg.fill();
    if (p === me) { mg.strokeStyle = '#fff'; mg.lineWidth = 1.5; mg.stroke(); }
  }
}
mini.addEventListener('click', (e) => {
  const r = mini.getBoundingClientRect();
  walkTo(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
});

// ---- profile ------------------------------------------------------------------
// Bios made of block / box-drawing / braille characters are text art: they
// only line up in a monospace font with their line breaks kept.
const isTextArt = (s) => /[\u2500-\u259F\u2800-\u28FF]/.test(s);

function openProfile(p) {
  if (!p) return;
  const desk = Object.entries(desks).find(([, v]) => v.owner === (p.did || `${p.kind}:${p.name}`));
  const stats = (p.actor?.stats || []).flatMap((s) => s.summary.slice(0, 6).map(([k2, v]) => `<div class="stat"><span class="muted">${esc(k2)}</span><b>${esc(v)}</b></div>`));
  const systems = (p.actor?.stats || []).map((s) => esc(s.name ? `${s.name} (${s.system})` : s.system)).join(', ');
  modal.open(`
    <div class="profile">
      <canvas width="112" height="112"></canvas>
      <div>
        <h2>${esc(p.name)} ${p.kind === 'agent' ? '<span class="badge">AGENT</span>' : ''}</h2>
        ${p.handle ? `<p class="small"><a href="https://rpg.actor/${encodeURIComponent(p.handle)}" target="_blank" rel="noopener">@${esc(p.handle)}</a> on rpg.actor</p>` : '<p class="small muted">Guest, no rpg.actor character linked</p>'}
        <p><span style="color:${statusColor(p.status)}">●</span> ${esc(STATUS[p.status]?.label || p.status)}${p.note ? ` · ${esc(p.note)}` : ''}</p>
        ${desk ? `<p class="small">🪑 Desk: ${esc(desk[0])}${desk[1].goal ? ` · “${esc(desk[1].goal)}”` : ''}</p>` : ''}
        ${p.actor?.description ? `<p class="bio small muted${isTextArt(p.actor.description) ? ' art' : ''}">${esc(p.actor.description)}</p>` : ''}
        ${systems ? `<p class="small"><b>Character sheets:</b> ${systems}</p><div class="stats">${stats.join('')}</div>` : ''}
        ${p === me ? `<div class="row">
          ${me.did ? `<button class="btn act-relogin" title="Go through your PDS again, e.g. if freeq says to">Sign in again</button>
          <button class="btn ghost act-signout">Sign out</button>` : `<button class="btn primary act-signout">Sign in…</button>`}
        </div>` : ''}
        ${p !== me ? `<div class="row">
          <button class="btn primary act-wave">👋 Wave</button>
          <button class="btn act-walk">Walk over</button>
          <button class="btn ghost act-follow">${follow === p.id ? 'Stop following' : 'Follow'}</button>
          <button class="btn ghost act-mention">@ Mention</button>
        </div>` : ''}
      </div>
    </div>`);
  const cv = modal.body.querySelector('canvas');
  if (p.sheets) drawPortrait(cv.getContext('2d'), p.sheets, 112);
  modal.body.querySelector('.act-wave')?.addEventListener('click', () => {
    const z = zoneAt(p.x, p.y);
    net.send({ t: 'wave', to: p.id, kind: z?.kind === 'room' && zoneAt(me.x, me.y) !== z ? 'knock' : 'wave' });
    modal.close();
  });
  modal.body.querySelector('.act-relogin')?.addEventListener('click', signInAgain);
  modal.body.querySelector('.act-signout')?.addEventListener('click', signOut);
  modal.body.querySelector('.act-walk')?.addEventListener('click', () => { walkTo(p.x, p.y); modal.close(); });
  modal.body.querySelector('.act-follow')?.addEventListener('click', () => { follow = follow === p.id ? null : p.id; modal.close(); });
  modal.body.querySelector('.act-mention')?.addEventListener('click', () => {
    modal.close();
    chatIn.value = `@${(p.handle || p.name).replace(/\s+/g, '')} `;
    chatIn.focus();
  });
}

// ---- interactions ---------------------------------------------------------------
const ownerKey = () => me.did || `${me.kind}:${me.name}`;
const ownerOnline = (owner) => [...peers.values()].some((p) => (p.did || `${p.kind}:${p.name}`) === owner);

function promptFor(f) {
  if (!f) return null;
  if (f.seat) {
    if (me.seat === f.id) return 'Stand up';
    const seat = SEATS.find((s) => s.id === f.id);
    if (seat?.desk) {
      const c = desks[seat.desk];
      if (!c) return 'Sit & claim this desk';
      if (c.owner === ownerKey()) return 'Sit at your desk';
      return `Sit at ${c.name}'s desk`;
    }
    return 'Sit';
  }
  switch (f.interact) {
    case 'whiteboard': return 'Open the whiteboard';
    case 'coffee': return 'Grab a coffee';
    case 'pomodoro': return pomo[f.zone]?.phase && pomo[f.zone].phase !== 'idle' ? 'Stop the focus session' : 'Start a focus session (25 / 5)';
    case 'noticeboard': return 'Read the notice board';
    case 'arcade': return 'Play Byte Snake';
    case 'plugin': return f.prompt || `Use the ${f.name}`;
    case 'room': {
      const { state, current, next } = roomStatus(bookings, f.zone, serverNow());
      const name = roomById(f.zone).name;
      return state === 'busy' ? `${name}: “${current.title}” until ${fmtTime(current.end)}` : state === 'soon' ? `${name}: free until ${fmtTime(next.start)}` : `${name} is free · book it`;
    }
  }
  return null;
}

function interact(f) {
  if (!f) return;
  if (f.seat) {
    if (me.seat === f.id) { me.seat = null; net.send({ t: 'sit', seat: null }); return; }
    const seat = SEATS.find((s) => s.id === f.id);
    const taken = [...peers.values()].some((p) => p !== me && p.seat === f.id);
    if (taken) return toast('Someone is already sitting there.');
    path = null; walkTarget = null;
    me.seat = seat.id; me.x = me.rx = seat.x; me.y = me.ry = seat.y;
    me.dir = { down: 0, left: 1, right: 2, up: 3 }[seat.facing] ?? 0; me.moving = false;
    net.send({ t: 'sit', seat: seat.id });
    if (seat.desk) {
      const c = desks[seat.desk];
      if (!c) openClaim(seat.desk);
      else if (c.owner === ownerKey()) net.send({ t: 'desk', action: 'claim', desk: seat.desk, goal: c.goal });
    }
    return;
  }
  switch (f.interact) {
    case 'whiteboard': modal.wb = openEditor(modal, board, (m) => net.send(m)); modal.onclose = () => (modal.wb = null); break;
    case 'coffee':
      net.send({ t: 'coffee' }); lastCoffee = performance.now(); me.cup = true;
      if (me.status === 'available') { autoStatus = 'coffee'; setStatus('coffee'); }
      toast('☕ Fresh coffee. Your mug shows for a few minutes, so people nearby know you\'re up for a chat.');
      break;
    case 'pomodoro': {
      const st = pomo[f.zone];
      if (st && st.phase !== 'idle') { if (confirm('Stop the shared focus session for everyone in the den?')) net.send({ t: 'pomo', action: 'stop' }); }
      else net.send({ t: 'pomo', action: 'start', focusMin: 25, breakMin: 5 });
      break;
    }
    case 'noticeboard': openNotes(); break;
    case 'room': openRoom(f.zone); break;
    case 'plugin': modal.obj = openObject(modal, f, (m) => net.send(m)); modal.onclose = () => (modal.obj = null); break;
    case 'arcade': modal.snake = openSnake(modal, { scores, onScore: (score) => net.send({ t: 'score', score }) }); { const prev = modal.onclose; modal.onclose = () => { prev?.(); modal.snake = null; }; } break;
  }
}

function openClaim(deskId) {
  modal.open(`
    <h2>Make this your desk?</h2>
    <p class="small muted">Your name goes on the desk and stays there between visits, so coworkers know where to find you. Your monitor lights up while you're in.</p>
    <label class="small"><b>Today I'm working on</b><input class="goal" maxlength="80" value="${esc(me.note || '')}" placeholder="e.g. writing the Q4 plan"></label>
    <div class="row"><button class="btn primary claim">Claim desk</button><button class="btn ghost skip">Just sitting</button></div>`);
  const goal = modal.body.querySelector('.goal');
  goal.focus();
  const claim = () => {
    net.send({ t: 'desk', action: 'claim', desk: deskId, goal: goal.value });
    if (goal.value !== me.note) { me.note = goal.value; net.send({ t: 'status', note: goal.value }); setStatusUI(); }
    modal.close();
  };
  modal.body.querySelector('.claim').addEventListener('click', claim);
  goal.addEventListener('keydown', (e) => { if (e.key === 'Enter') claim(); });
  modal.body.querySelector('.skip').addEventListener('click', () => modal.close());
}

function openNotes() {
  const wasOpen = modal.notesOpen;
  const draft = wasOpen ? modal.body.querySelector('.note-text')?.value : '';
  modal.open(`
    <h2>Notice board</h2>
    <p class="small muted">Leave a note for the office: wins, asks, lunch plans. Notes stay up between visits.</p>
    <div class="row"><input class="note-text" maxlength="200" placeholder="Pin a note…"><button class="btn primary pin">Pin</button></div>
    <div class="notes">${notes.map((n) => `<div class="note" style="background:${n.color}">${esc(n.text)}<small>${esc(n.by)} · ${new Date(n.ts).toLocaleDateString()}</small>${n.owner === ownerKey() ? `<button data-id="${n.id}" title="Remove">✕</button>` : ''}</div>`).join('') || '<p class="muted">Nothing pinned yet.</p>'}</div>`);
  modal.notesOpen = true;
  modal.onclose = () => (modal.notesOpen = false);
  const input = modal.body.querySelector('.note-text');
  input.value = draft || '';
  const pin = () => { if (input.value.trim()) { net.send({ t: 'note', op: 'add', text: input.value }); input.value = ''; } };
  modal.body.querySelector('.pin').addEventListener('click', pin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pin(); });
  modal.body.querySelectorAll('.note button').forEach((b) => b.addEventListener('click', () => net.send({ t: 'note', op: 'remove', id: b.dataset.id })));
  if (!wasOpen) input.focus();
}

// ---- meeting rooms ----------------------------------------------------------------
const DAY = 24 * 60 * MIN;
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocal = (day, time) => { const [Y, M, D] = day.split('-').map(Number); const [h, m] = time.split(':').map(Number); return new Date(Y, M - 1, D, h, m).getTime(); };
function dayWord(t) {
  const today = isoDay(serverNow()), d = isoDay(t);
  if (d === today) return 'today';
  if (d === isoDay(serverNow() + DAY)) return 'tomorrow';
  return new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
const statusDot = (state) => `<span class="dot st-${state}"></span>`;
const canBook = () => !!me?.did;
const signInHint = '<p class="small muted">Sign in with your AT Protocol handle (on the way in) to book rooms. Guests can see the schedule.</p>';

function walkInto(room) {
  if (!room) return;
  walkTo((room.x0 + room.x1 + 1) / 2, (room.y0 + room.y1 + 1) / 2);
}

// Knock on a locked room: taps someone from the meeting who's inside.
function knock(roomId) {
  const b = activeBooking(bookings, roomId, serverNow());
  const inside = [...peers.values()].filter((p) => p !== me && zoneAt(p.x, p.y)?.id === roomId && isHolder(b, p));
  const who = inside.find((p) => keyOf(p) === b?.owner) || inside[0];
  if (!who) return toast('🚪 Nobody from the meeting is inside yet.');
  net.send({ t: 'wave', to: who.id, kind: 'knock' });
  toast(`🚪 You knocked. ${esc(who.name)} can let you in.`);
}

const roomHud = $('.room-hud');
let roomHudT = 0;
roomHud.addEventListener('click', () => { const z = zoneAt(me.x, me.y); if (z?.bookable) openRoom(z.id); });
function updateRoomHud(z) {
  if (!z?.bookable) { roomHud.hidden = true; return; }
  const { state, current, next } = roomStatus(bookings, z.id, serverNow());
  roomHud.hidden = false;
  roomHud.innerHTML = state === 'busy'
    ? `${statusDot(state)}${current.lock ? '🔒 ' : ''}“${esc(current.title)}” · ${esc(current.name)} · until ${fmtTime(current.end)}`
    : state === 'soon' ? `${statusDot(state)}Free until ${fmtTime(next.start)}` : `${statusDot(state)}Free · book this room`;
}

const draft = { room: 'board', date: '', time: '', minutes: 30, title: '', invitees: '', lock: false, autoRelease: true };

function openSchedule(opts = {}) {
  Object.assign(draft, opts);
  if (!draft.date) draft.date = isoDay(serverNow());
  const render = () => {
    const now = serverNow();
    if (!draft.time) draft.time = draft.date === isoDay(now) ? hm(Math.ceil((now + 5 * MIN) / (30 * MIN)) * 30 * MIN) : '10:00';
    // 07:00–21:00, stretched to fit early or late bookings (and now).
    const dayStart = fromLocal(draft.date, '00:00'), dayEnd = dayStart + DAY;
    const times = bookings.filter((b) => b.end > dayStart && b.start < dayEnd).flatMap((b) => [b.start, b.end]);
    if (now > dayStart && now < dayEnd) times.push(now);
    const hourOf = (t) => (t - dayStart) / (60 * MIN);
    let h0 = Math.max(0, Math.min(7, ...times.map((t) => Math.floor(hourOf(t)))));
    let h1 = Math.min(24, Math.max(21, ...times.map((t) => Math.ceil(hourOf(t) + 0.5))));
    if ((h1 - h0) % 2) h1 < 24 ? h1++ : h0--;
    const from = dayStart + h0 * 60 * MIN, to = dayStart + h1 * 60 * MIN;
    const pct = (t) => ((Math.min(to, Math.max(from, t)) - from) / (to - from)) * 100;
    const hours = Array.from({ length: (h1 - h0) / 2 }, (_, i) => h0 + i * 2).map((h) => `<span style="left:${pct(dayStart + h * 60 * MIN)}%">${pad(h)}:00</span>`).join('');
    const rows = ROOMS.map((r) => {
      const st = roomStatus(bookings, r.id, now);
      const blocks = bookings.filter((b) => b.room === r.id && b.end > from && b.start < to).map((b) => `
        <div class="tl-block${b.owner === keyOf(me) ? ' mine' : ''}${b.lock ? ' locked' : ''}${b.end <= now ? ' past' : ''}" data-id="${b.id}"
          style="left:${pct(b.start)}%;width:${pct(b.end) - pct(b.start)}%"
          title="${esc(`${b.title} · ${fmtRange(b)} · ${b.name}${b.invitees?.length ? ` · with ${b.invitees.join(', ')}` : ''}`)}">${esc(b.title)}</div>`).join('');
      const nowLine = now > from && now < to ? `<div class="tl-now" style="left:${pct(now)}%"></div>` : '';
      return `<div class="tl-name">${esc(r.name)}<small>${statusDot(st.state)}${r.av ? '<span class="badge av">A/V</span>' : 'voice'} · ${r.seats} seat${r.seats > 1 ? 's' : ''}</small></div>
        <div class="tl-track" data-room="${r.id}" style="--hours:${h1 - h0}">${blocks}${nowLine}</div>`;
    }).join('');
    const mine = bookings.filter((b) => b.end > now && (b.owner === keyOf(me) || isHolder(b, me))).sort((a, b) => a.start - b.start);
    const durations = [15, 30, 45, 60, 90, 120, 180, 240];
    modal.open(`
      <div class="sched">
        <div class="sched-head"><h2>Meeting rooms</h2>
          <div class="day-nav"><button class="prev" aria-label="Previous day">‹</button><b>${esc(dayWord(fromLocal(draft.date, '12:00')))}</b><button class="next" aria-label="Next day">›</button></div></div>
        <div class="timeline"><div></div><div class="tl-hours">${hours}</div>${rows}</div>
        <p class="tiny muted">Click an empty spot to pick a time. 🔒 means only invitees can walk in.</p>
        ${canBook() ? `<form class="book-form">
          <label>Room<select name="room">${ROOMS.map((r) => `<option value="${r.id}"${r.id === draft.room ? ' selected' : ''}>${esc(r.name)}${r.av ? ' (A/V)' : ''}</option>`).join('')}</select></label>
          <label>Day<input type="date" name="date" value="${draft.date}" min="${isoDay(now)}" max="${isoDay(now + RULES.ahead)}"></label>
          <label>Start<input type="time" name="time" step="300" value="${draft.time}"></label>
          <label>Length<select name="minutes">${durations.map((d) => `<option value="${d}"${d === +draft.minutes ? ' selected' : ''}>${d < 60 ? `${d} min` : `${d / 60} h`}</option>`).join('')}</select></label>
          <label class="wide">What's it for<input name="title" maxlength="80" value="${esc(draft.title)}" placeholder="e.g. Design review"></label>
          <label class="wide">Invite (handles, comma separated; agents by name)<input name="invitees" value="${esc(draft.invitees)}" placeholder="ada.bsky.social, StandupBot"></label>
          <div class="checks">
            <label><input type="checkbox" name="lock"${draft.lock ? ' checked' : ''}> 🔒 Lock the room: only invitees can walk in</label>
            <label><input type="checkbox" name="autoRelease"${draft.autoRelease ? ' checked' : ''}> Release it if nobody shows up in 10 min</label>
          </div>
          <button class="btn primary wide">Book</button>
        </form>` : signInHint}
        <h3 style="margin-top:16px">Your bookings</h3>
        <ul class="my-bookings">${mine.map((b) => bookingRow(b, now)).join('') || '<li class="muted">Nothing booked.</li>'}</ul>
      </div>`, 'wide');
    modal.rooms = render;
    modal.onclose = () => (modal.rooms = null);
    const body = modal.body;
    const shift = (d) => { draft.date = isoDay(fromLocal(draft.date, '12:00') + d * DAY); draft.time = ''; render(); };
    body.querySelector('.prev').onclick = () => shift(-1);
    body.querySelector('.next').onclick = () => shift(1);
    body.querySelectorAll('.tl-track').forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('.tl-block')) return;
      const r = tr.getBoundingClientRect();
      const t = from + ((e.clientX - r.left) / r.width) * (to - from);
      Object.assign(draft, { room: tr.dataset.room, time: hm(Math.floor(t / (15 * MIN)) * 15 * MIN) });
      render();
      modal.body.querySelector('[name=title]')?.focus();
    }));
    body.querySelectorAll('.tl-block').forEach((el) => el.addEventListener('click', () => {
      const b = bookings.find((x) => x.id === el.dataset.id);
      if (b) toast(`📅 <b>${esc(b.title)}</b> · ${esc(roomById(b.room).name)} · ${dayWord(b.start)} ${fmtRange(b)} · booked by ${esc(b.name)}`);
    }));
    wireBookingRows(body);
    const form = body.querySelector('.book-form');
    if (!form) return;
    form.addEventListener('input', (e) => {
      const el = e.target;
      draft[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      if (el.name === 'date') render();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const start = fromLocal(draft.date, draft.time || '10:00');
      net.send({
        t: 'book', op: 'create', ref: 'new', room: draft.room, start, end: start + draft.minutes * MIN,
        title: draft.title, invitees: draft.invitees, lock: draft.lock, autoRelease: draft.autoRelease,
      });
      draft.title = ''; draft.invitees = '';
    });
  };
  render();
}

function bookingRow(b, now) {
  const live = b.start <= now && now < b.end;
  const own = b.owner === keyOf(me);
  return `<li data-id="${b.id}">${statusDot(live ? 'busy' : 'soon')}
    <span class="grow"><b>${esc(b.title)}</b>${b.lock ? ' 🔒' : ''}<br><span class="small muted">${esc(roomById(b.room).name)} · ${dayWord(b.start)} ${fmtRange(b)}${own ? '' : ` · from ${esc(b.name)}`}</span></span>
    ${zoneAt(me.x, me.y)?.id !== b.room ? '<button data-act="go">Walk there</button>' : ''}
    ${own && live ? '<button data-act="extend">+15 min</button><button data-act="end">End now</button>' : ''}
    ${own && !live ? '<button data-act="cancel">Cancel</button>' : ''}</li>`;
}

function wireBookingRows(body) {
  body.querySelectorAll('li[data-id] button').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.closest('li').dataset.id, act = btn.dataset.act;
    const b = bookings.find((x) => x.id === id);
    if (!b) return;
    if (act === 'go') { modal.close(); walkInto(roomById(b.room)); return; }
    if (act === 'cancel' && !confirm(`Cancel “${b.title}”?`)) return;
    net.send({ t: 'book', op: act, id, minutes: 15 });
  }));
}

// The panel by a room's door: what's on now, what's next, quick booking.
function openRoom(id) {
  const room = roomById(id);
  const render = () => {
    const now = serverNow();
    const { state, current, next } = roomStatus(bookings, id, now);
    const upcoming = forRoom(bookings, id).filter((b) => b.end > now).slice(0, 6);
    const gap = next ? next.start - now : 60 * MIN;
    const quick = Math.min(30 * MIN, Math.floor(gap / (5 * MIN)) * 5 * MIN);
    const lockedOutNow = current?.lock && !isHolder(current, me);
    modal.open(`
      <h2>${esc(room.name)} ${room.av ? '<span class="badge av">A/V</span>' : ''}</h2>
      <p class="small muted">${room.seats} seat${room.seats > 1 ? 's' : ''} · ${room.av ? 'voice, video and screen share for everyone inside' : 'private voice'}</p>
      <div class="room-now ${state}">${statusDot(state)}<div>${state === 'busy'
        ? `<b>In use${current.lock ? ' 🔒' : ''}:</b> “${esc(current.title)}” · ${esc(current.name)} · until ${fmtTime(current.end)}`
        : state === 'soon' ? `<b>Free</b> until ${fmtTime(next.start)} (“${esc(next.title)}”)` : '<b>Free</b>'}</div></div>
      <div class="row">
        ${!current && canBook() && quick >= RULES.minLen ? `<button class="btn primary quick">Book now · ${quick / MIN} min</button>` : ''}
        ${canBook() ? '<button class="btn ghost later">Book a time…</button>' : ''}
        ${lockedOutNow ? '<button class="btn knock">🚪 Knock</button>' : ''}
        ${zoneAt(me.x, me.y)?.id !== id && !lockedOutNow ? '<button class="btn ghost go">Walk in</button>' : ''}
      </div>
      ${canBook() ? '' : signInHint}
      <h3 style="margin-top:16px">Coming up</h3>
      <ul class="room-day">${upcoming.map((b) => bookingRow(b, now)).join('') || '<li class="muted">Nothing booked.</li>'}</ul>`);
    modal.rooms = render;
    modal.onclose = () => (modal.rooms = null);
    const body = modal.body;
    body.querySelector('.quick')?.addEventListener('click', () => net.send({ t: 'book', op: 'create', ref: 'new', room: id, start: now, end: now + quick, title: `${me.name}'s meeting` }));
    body.querySelector('.later')?.addEventListener('click', () => openSchedule({ room: id }));
    body.querySelector('.knock')?.addEventListener('click', () => { knock(id); modal.close(); });
    body.querySelector('.go')?.addEventListener('click', () => { modal.close(); walkInto(room); });
    wireBookingRows(body);
  };
  render();
}
$('.rooms-btn').addEventListener('click', () => openSchedule());

// ---- A/V rooms: camera, screen share and the video stage -----------------------------
const camBtn = $('.cam'), shareBtn = $('.share');
camBtn.addEventListener('click', toggleCam);
shareBtn.addEventListener('click', toggleShare);

async function ensureVoice() {
  if (voice.on) return true;
  if (!(await voice.enable({ silent: true }))) return false;
  net.send({ t: 'audio', on: true });
  me.audio = true;
  micBtn.className = 'tb mic on';
  return true;
}
async function toggleCam() {
  if (voice.cam) return voice.stopCam();
  await ensureVoice();
  if (!(await voice.startCam())) toast('📷 Camera permission was blocked. Allow it in your browser to turn it on.');
}
async function toggleShare() {
  if (voice.screen) return voice.stopScreen();
  await ensureVoice();
  if (!(await voice.startScreen())) toast('🖥️ Screen sharing was cancelled or blocked.');
}

let sentAv = { video: false, screen: false };
function mediaChanged(ended) {
  const now = { video: !!voice.cam, screen: !!voice.screen };
  camBtn.classList.toggle('on', now.video);
  shareBtn.classList.toggle('on', now.screen);
  if (me && (now.video !== sentAv.video || now.screen !== sentAv.screen)) {
    sentAv = now;
    me.video = now.video; me.screen = now.screen;
    net.send({ t: 'av', ...now });
  }
  if (ended) toast('🖥️ You stopped sharing your screen.', [], 3000);
  updateStage();
}

const stage = $('.av-stage');
const tiles = new Map(); // key -> tile element
function updateStage() {
  const z = me && zoneAt(me.x, me.y);
  const want = [];
  if (z?.av) {
    const others = [...peers.values()].filter((p) => p !== me && zoneAt(p.x, p.y) === z);
    if (voice.screen) want.push({ key: 'me:screen', stream: voice.screen, name: 'Your screen', kind: 'screen' });
    for (const p of others) { const r = voice.remote(p.id); if (r.screen) want.push({ key: `${p.id}:screen`, stream: r.screen, name: `${p.name}'s screen`, kind: 'screen', id: p.id }); }
    if (voice.cam) want.push({ key: 'me:cam', stream: voice.cam, name: 'You', kind: 'cam self', id: me.id });
    for (const p of others) { const r = voice.remote(p.id); if (r.cam) want.push({ key: `${p.id}:cam`, stream: r.cam, name: p.name, kind: 'cam', id: p.id }); }
  }
  const keys = new Set(want.map((w) => w.key));
  for (const [k2, el] of tiles) if (!keys.has(k2)) { el.remove(); tiles.delete(k2); }
  for (const w of want) {
    let el = tiles.get(w.key);
    if (!el) {
      el = document.createElement('div');
      el.className = `tile ${w.kind}`;
      el.innerHTML = '<video autoplay playsinline muted></video><span class="tag"></span><button class="grow-btn" title="Enlarge">⤢</button>';
      el.querySelector('.grow-btn').onclick = () => el.classList.toggle('big');
      tiles.set(w.key, el);
      stage.append(el);
    }
    const v = el.querySelector('video');
    if (v.srcObject !== w.stream) { v.srcObject = w.stream; v.play().catch(() => {}); }
    el.querySelector('.tag').textContent = w.name;
    el.classList.toggle('speaking', !!(w.id && peers.get(w.id)?.speaking));
  }
  stage.hidden = !want.length;
}

// A screen being shared in my room also plays on the room's wall screen.
function screenFeed(z) {
  if (!z?.av) return null;
  for (const [k2, el] of tiles) if (k2.endsWith(':screen')) return { zone: z.id, video: el.querySelector('video') };
  return null;
}

// ---- input ----------------------------------------------------------------------
const keys = new Set();
const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
addEventListener('keydown', (e) => {
  if (!me) return;
  if (modal.isOpen) { if (e.key === 'Escape') modal.close(); return; }
  if (typing()) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) { keys.add(key); e.preventDefault(); }
  else if (key === 'e' || key === ' ') { interact(nearestInteractable(me.x, me.y)); e.preventDefault(); }
  else if (key === 'Enter') { chatIn.focus(); e.preventDefault(); }
  else if (key === 'm') toggleMic();
  else if (key === 'n') toggleMusic();
  else if (key === 'b') openSchedule();
  else if (key === 'c' && zoneAt(me.x, me.y)?.av) toggleCam();
  else if (key === 'v') toggleVector();
  else if (key === '+' || key === '=') zoom(1);
  else if (key === '-') zoom(-1);
  else if (key === '?') openHelp();
  else if (/^[1-9]$/.test(key) && emoteList[+key - 1]) emote(emoteList[+key - 1]);
});
addEventListener('keyup', (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
addEventListener('blur', () => keys.clear());

function tapAt(sx, sy, touch = false) {
  const hit = R.hitPeer(sx, sy, [...peers.values()], touch ? 40 : 28);
  if (hit) return openProfile(hit);
  const w = R.toWorld(sx, sy);
  // Clicking a piece of furniture walks to it and uses it on arrival.
  const f = FURNITURE.find((f2) => (f2.interact || f2.seat) && w.x >= f2.x - 0.1 && w.x <= f2.x + f2.w + 0.1 && w.y >= f2.y - 1 && w.y <= f2.y + f2.h + 0.1);
  walkTo(w.x, w.y, f);
}

// A mouse acts on press. A finger acts on release: a tap walks, a drag turns
// into a joystick centred where it started, and two fingers pinch to zoom.
const STICK_R = 48;
const touches = new Map();
let gesture = null, stick = null;
const stickEl = $('.stick'), knobEl = $('.stick span');
canvas.addEventListener('pointerdown', (e) => {
  if (!me) return;
  document.activeElement?.blur?.();
  if (e.pointerType === 'mouse') { if (e.button === 0) tapAt(e.clientX, e.clientY); return; }
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 1) gesture = { kind: 'tap', id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now() };
  else if (touches.size === 2) {
    endStick();
    const [a, b] = [...touches.values()];
    gesture = { kind: 'pinch', d0: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), k0: k };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId) || !gesture) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.kind === 'pinch') {
    if (touches.size < 2) return;
    const [a, b] = [...touches.values()];
    return pinchTo(gesture.k0, Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0);
  }
  if (gesture.id !== e.pointerId) return;
  const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0, d = Math.hypot(dx, dy);
  if (gesture.kind === 'tap' && d > 14) {
    gesture.kind = 'stick';
    path = null; walkTarget = null; pendingUse = null; follow = null;
    if (me.seat) { me.seat = null; net.send({ t: 'sit', seat: null }); }
    stickEl.style.left = `${gesture.x0}px`; stickEl.style.top = `${gesture.y0}px`;
    stickEl.hidden = false;
  }
  if (gesture.kind !== 'stick') return;
  const r = Math.min(d, STICK_R);
  stick = d > 8 ? { x: dx / d, y: dy / d } : null;
  knobEl.style.transform = `translate(${d ? (dx / d) * r : 0}px, ${d ? (dy / d) * r : 0}px)`;
});
function endStick() { stick = null; stickEl.hidden = true; knobEl.style.transform = ''; }
function lift(e) {
  if (!touches.delete(e.pointerId) || !gesture) return;
  if (gesture.kind === 'pinch') { if (!touches.size) gesture = null; return; }
  if (gesture.id !== e.pointerId) return;
  if (gesture.kind === 'tap' && e.type === 'pointerup' && performance.now() - gesture.t0 < 600) tapAt(e.clientX, e.clientY, true);
  endStick(); gesture = null;
}
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);
canvas.addEventListener('contextmenu', (e) => { if (coarse) e.preventDefault(); });

function walkTo(x, y, thenUse = null) {
  if (x === undefined || !me) return;
  if (me.seat) { me.seat = null; net.send({ t: 'sit', seat: null }); }
  const tx = thenUse?.seat ? thenUse.x + 0.5 : x, ty = thenUse?.seat ? thenUse.y + 0.5 : y;
  const p = findPath(me.x, me.y, tx, ty);
  if (!p) return;
  path = p.slice(1);
  if (!thenUse && !isBlocked(Math.floor(x), Math.floor(y)) && path.length) path[path.length - 1] = { x, y };
  walkTarget = path.length ? path[path.length - 1] : null;
  pendingUse = thenUse;
}
let pendingUse = null;

// ---- movement ---------------------------------------------------------------------
// Tiles per second: walking with keys or the joystick, and running an auto-path
// (click or tap to walk, walk-to buttons, following someone).
const SPEED = 6.5, RUN = 11, RAD = 0.26;
function free(x, y) {
  const z = zoneAt(x, y);
  if (z?.bookable && z !== zoneAt(me.x, me.y) && lockedOut(bookings, z.id, me, serverNow())) return false;
  return !isBlocked(Math.floor(x - RAD), Math.floor(y - RAD * 0.6)) && !isBlocked(Math.floor(x + RAD), Math.floor(y - RAD * 0.6))
    && !isBlocked(Math.floor(x - RAD), Math.floor(y + RAD * 0.6)) && !isBlocked(Math.floor(x + RAD), Math.floor(y + RAD * 0.6));
}

let lastSent = 0, sentMoving = false, lastSentPos = { x: 0, y: 0 };
function stepMe(dt) {
  let vx = 0, vy = 0;
  if (keys.has('a') || keys.has('ArrowLeft')) vx -= 1;
  if (keys.has('d') || keys.has('ArrowRight')) vx += 1;
  if (keys.has('w') || keys.has('ArrowUp')) vy -= 1;
  if (keys.has('s') || keys.has('ArrowDown')) vy += 1;
  if (stick) { vx += stick.x; vy += stick.y; }
  if (vx || vy) { path = null; walkTarget = null; pendingUse = null; follow = null; }

  if (follow && !path) {
    const t = peers.get(follow);
    if (t && Math.hypot(t.x - me.x, t.y - me.y) > 1.6 && (!stepMe.lastFollow || performance.now() - stepMe.lastFollow > 700)) {
      stepMe.lastFollow = performance.now();
      const p = findPath(me.x, me.y, t.x, t.y);
      if (p) { path = p.slice(1, -1); walkTarget = null; }
    }
  }
  let reach = SPEED * dt;
  if (path && path.length) {
    // Auto-paths run, and pass waypoints without stopping: aim at the spot
    // this frame's run ends on, however many corners that takes.
    let budget = RUN * dt, ax = me.x, ay = me.y;
    while (path.length) {
      const t = path[0], d = Math.hypot(t.x - ax, t.y - ay);
      if (d > budget) { ax += ((t.x - ax) / d) * budget; ay += ((t.y - ay) / d) * budget; break; }
      budget -= d; ax = t.x; ay = t.y; path.shift();
    }
    reach = Math.hypot(ax - me.x, ay - me.y);
    if (reach > 1e-6) { vx = ax - me.x; vy = ay - me.y; }
    if (!path.length) {
      path = null; walkTarget = null;
      if (pendingUse) { const f = pendingUse; pendingUse = null; interact(f); }
    }
  }
  const moving = !!(vx || vy);
  if (moving && me.seat) { me.seat = null; net.send({ t: 'sit', seat: null }); }
  if (moving) {
    const len = Math.hypot(vx, vy);
    const x0 = me.x, y0 = me.y;
    const nx = me.x + (vx / len) * reach, ny = me.y + (vy / len) * reach;
    if (free(nx, me.y)) me.x = nx;
    if (free(me.x, ny)) me.y = ny;
    // Face where you actually go (sliding along a wall faces along it), or
    // where you're pushing when you're stuck.
    const mx = me.x - x0, my = me.y - y0;
    me.dir = mx || my ? facing(me.dir, mx, my) : facing(me.dir, vx, vy);
  }
  me.moving = moving;
  me.rx = me.x; me.ry = me.y;
  const now = performance.now();
  const changed = Math.hypot(me.x - lastSentPos.x, me.y - lastSentPos.y) > 0.02;
  if ((changed && now - lastSent > 66) || sentMoving !== moving) {
    net.send({ t: 'move', x: +me.x.toFixed(3), y: +me.y.toFixed(3), dir: me.dir, moving });
    lastSent = now; sentMoving = moving; lastSentPos = { x: me.x, y: me.y };
  }
}

// Other people are drawn a little in the past, between the last two spots
// they reported, so ~15 updates a second play back as an even walk instead
// of lurch-and-stop. Big jumps (teleports, reconnects) snap.
const BEHIND = 120;
function track(p) {
  const now = performance.now();
  const tr = p.track || (p.track = []);
  const prev = tr[tr.length - 1];
  if (!prev || Math.hypot(p.x - p.rx, p.y - p.ry) > 5) { tr.length = 0; p.rx = p.x; p.ry = p.y; }
  // Setting off after standing still: start from where they stood, just now.
  else if (now - prev.t > 250) tr.push({ t: now - 66, x: prev.x, y: prev.y });
  tr.push({ t: now, x: p.x, y: p.y });
  if (tr.length > 20) tr.splice(0, tr.length - 20);
}
function glide(p, now) {
  const tr = p.track;
  if (!tr?.length) { p.rx = p.x; p.ry = p.y; return; }
  const rt = now - BEHIND;
  while (tr.length > 1 && tr[1].t <= rt) tr.shift();
  const a = tr[0], b = tr[1];
  if (!b || rt <= a.t) { p.rx = a.x; p.ry = a.y; return; }
  const f = (rt - a.t) / (b.t - a.t);
  p.rx = a.x + (b.x - a.x) * f; p.ry = a.y + (b.y - a.y) * f;
}

// ---- auto status -------------------------------------------------------------------
let lastZone = null;
function zoneChanged(z, freeqOnly = false) {
  const kind = $('.zone-kind'), scope = $('.chat-form .scope');
  const fq = z && freeqRooms[z.id];
  $('.zone-name').textContent = z ? z.name : 'Hallway';
  kind.textContent = fq ? fq.channel : z ? { open: 'open', room: 'private', quiet: 'quiet' }[z.kind] : 'open';
  kind.className = `zone-kind ${fq ? 'freeq' : z?.kind || 'open'}`;
  scope.textContent = fq ? fq.channel : z && z.kind !== 'open' ? z.name : 'nearby';
  scope.className = `scope ${fq ? 'freeq' : z?.kind || 'open'}`;
  if (freeqOnly) return;
  if (fq) toast(`💬 ${esc(z.name)} is attached to <b>${esc(fq.channel)}</b> on freeq${fq.topic ? ` (${esc(fq.topic)})` : ''}. ${me.did ? 'What you say here goes there as you.' : 'Sign in to talk there as yourself; for now you can listen.'}`, [], 6000);
  if (z?.kind === 'room' && me.status === 'available') { autoStatus = 'meeting'; setStatus('meeting'); }
  else if (autoStatus === 'meeting' && z?.kind !== 'room') { autoStatus = null; setStatus('available'); }
  if (z?.kind === 'quiet') toast('🤫 Deep Work Den: voice is off in here. Press E at the tomato clock to start a shared focus session.', [], 5000);
  // Camera and screen share belong to A/V rooms; they stop at the door.
  camBtn.hidden = shareBtn.hidden = !z?.av;
  if (!z?.av && (voice.cam || voice.screen)) { voice.stopCam(); voice.stopScreen(); }
  if (z?.av && !avHinted) { avHinted = true; toast(`🎥 ${esc(z.name)} is an A/V room: turn on your camera or share your screen with everyone in here.`, [['Camera', toggleCam], ['Share screen', toggleShare]], 7000); }
  if (z?.bookable) {
    const b = activeBooking(bookings, z.id, serverNow());
    if (b && !isHolder(b, me)) toast(`📅 ${esc(z.name)} is booked for “${esc(b.title)}” (${esc(b.name)}) until ${fmtTime(b.end)}`, [], 5000);
  }
  roomHudT = 0;
}
let avHinted = false;

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (!me) return;
  if (document.hidden) hiddenAt = Date.now();
  else if (autoStatus === 'away') { autoStatus = null; setStatus('available'); }
});
setInterval(() => {
  if (me && document.hidden && hiddenAt && Date.now() - hiddenAt > 5 * 60000 && me.status === 'available') { autoStatus = 'away'; setStatus('away'); }
  if (me && autoStatus === 'coffee' && performance.now() - lastCoffee > 5 * 60000) { autoStatus = null; setStatus('available'); }
}, 15000);

// ---- loop -----------------------------------------------------------------------------
const cam = { x: SPAWN.x, y: SPAWN.y };
let last = performance.now(), miniT = 0;
const promptEl = $('.prompt');
// The interaction prompt doubles as a button, which is how touch screens press E.
promptEl.querySelector('kbd').textContent = coarse ? 'Tap' : 'E';
promptEl.addEventListener('click', () => { if (me && !modal.isOpen) interact(nearestInteractable(me.x, me.y)); });
// Touch devices drop to ~30 fps while nothing on screen is moving, to save battery.
let lastDraw = 0;
const busy = () => me.moving || gesture || [...peers.values()].some((p) => p.moving || Math.abs(p.x - p.rx) + Math.abs(p.y - p.ry) > 0.01);
const pomoHud = $('.pomo-hud');

// ---- music from objects (the jukebox) ----------------------------------------------
// The loudest object playing music within earshot, fading with distance;
// music.js keeps everyone on the same beat.
const music = createMusic();
const musicHud = $('.music-hud');
function toggleMusic() {
  music.setMuted(!music.muted);
  toast(music.muted ? '🔇 Music muted for you. Press N to bring it back.' : '🎵 Music on.');
}
musicHud.addEventListener('click', toggleMusic);
function updateMusic() {
  let want = null;
  for (const f of FURNITURE) {
    const m = f.plugin && objects[f.id]?.display;
    if (!m?.music || (m.until && m.until <= serverNow())) continue;
    const spot = { x: f.x + f.w / 2, y: f.y + f.h + 0.5 };
    // It fills the area it stands in, and carries a little past it like a voice would.
    const sameArea = zoneAt(me.x, me.y) === zoneAt(spot.x, spot.y);
    if (!sameArea && !canHear(me, spot)) continue;
    const volume = Math.max(0, Math.min(1, 1.2 - Math.hypot(me.x - spot.x, me.y - spot.y) / (sameArea ? 2.5 * HEAR_RADIUS : HEAR_RADIUS)));
    if (volume > (want?.volume || 0)) want = { ...m.music, volume, label: m.label };
  }
  music.update(want, serverNow());
  musicHud.hidden = !want;
  if (want) musicHud.textContent = `${music.muted ? '🔇' : '🔊'} ${want.label || 'Music'}`;
}

function loop(t) {
  if (coarse && me && t - lastDraw < 30 && !busy()) { requestAnimationFrame(loop); return; }
  lastDraw = t;
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  if (me) {
    stepMe(dt);
    for (const p of peers.values()) {
      if (p === me) continue;
      glide(p, t);
    }
    const z = zoneAt(me.x, me.y);
    if (z !== lastZone) { lastZone = z; zoneChanged(z); refreshChannels(); }

    // Den focus sessions flip your status while you're inside.
    const den = pomo.focus;
    if (z?.id === 'focus' && den?.phase === 'focus' && me.status === 'available') { autoStatus = 'focus'; setStatus('focus'); }
    if (autoStatus === 'focus' && (z?.id !== 'focus' || den?.phase !== 'focus')) { autoStatus = null; setStatus('available'); }

    const others = [...peers.values()];
    const deaf = me.status === 'focus';
    const v = voice.update(me, others, deaf);
    me.speaking = v.meSpeaking;
    for (const p of others) if (p !== me) p.speaking = v.speaking.has(p.id);

    cam.x += (me.x - cam.x) * Math.min(1, dt * 6);
    cam.y += (me.y - 0.5 - cam.y) * Math.min(1, dt * 6);

    const target = modal.isOpen ? null : nearestInteractable(me.x, me.y);
    const label = target && promptFor(target);
    promptEl.hidden = !label;
    if (label) promptEl.querySelector('span').textContent = label;

    if (z?.id === 'focus' && den && den.phase !== 'idle') {
      const left = Math.max(0, den.endsAt - serverNow());
      pomoHud.hidden = false;
      pomoHud.textContent = `${den.phase === 'focus' ? '🍅 Focus' : '🌿 Break'} ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    } else pomoHud.hidden = true;
    updateMusic();
    if (t - roomHudT > 500) { roomHudT = t; updateRoomHud(z); updateStage(); }

    R.draw({
      cam, k, time: t, clock: clockNow(), meId: me.id, peers: others,
      desks, notes, pomo, counters, serverNow, ownerOnline, wbCanvas: board.canvas,
      target, walkTarget, lastCoffee, vector, bookings, screenFeed: screenFeed(z), freeq: freeqRooms, objects,
    });
    if (t - miniT > 150) { miniT = t; drawMinimap(); }
  }
  requestAnimationFrame(loop);
}

// Debug/test hook.
window.__office = { get me() { return me; }, music, cam, send: (m) => net.send(m), voice, peers, get desks() { return desks; }, get bookings() { return bookings; }, walkTo, interact, openSchedule, openRoom, FURNITURE, DESKS };
