import { W, H, ZONES, FURNITURE, DESKS, SPAWN, HEAR_RADIUS, isBlocked, zoneAt, canHear, findPath, nearestInteractable, deskAt, applyWing, grid } from './map.js';
import { ask } from './ask.js';
import { summary as accessOf, describe as describeAccess } from './policy.js';
import { createRenderer, EMOJI } from './render.js';
import { sheetsFor, facing } from './sprites.js';
import { STATUS, markedName, statusColor, colorFor } from './style.js';
import { connect } from './net.js';
import { createVoice, DESK_VIEW } from './rtc.js';
import { createFreeqCall } from './freeq-av.js';
import { createBoard, openEditor } from './whiteboard.js';
import { openObject } from './objects.js';
import { createWorkstation, registerApp } from './workstation.js';
import { createMusic } from './music.js';
import { syncGallery, openGallery } from './gallery.js';
import { openInventory, nearestFloorItem } from './inventory.js';
import { label as itemLabel, placeTiles, holdsKey, GIVE_RANGE } from './items.js';
import { ROOMS, MIN, RULES, roomById, roomStatus, activeBooking, isHolder, lockedOut, restrictedAt, doorTiles, forRoom, keyOf, fmtTime, fmtRange } from './rooms.js';
import { fmtHour, fmtClock, localize } from './time.js';
import { can, rank, roleBadge, ROLES } from './roles.js';
import { openAdmin, roleTag } from './admin.js';

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
let desks = {}, notes = [], pomo = {}, counters = {}, bookings = [];
let freeqRooms = {}; // area id -> { channel, members, topic } attached from freeq
let wing = []; // channel rooms off the hallway: { id, channel, slot, tier, topic, members, sources, policy, access }
let objects = {}; // plugin object id -> { display, bubble } (see objects.js)
let gallery = []; // objects people uploaded (see gallery.js)
const galleryWait = new Map(); // request id -> resolve, for { t: 'galleryres' }
let galleryRid = 0;
let items = [], floor = [], keeps = false; // what you carry, what's lying around, whether yours outlast the visit
let serverOffset = 0;
const serverNow = () => Date.now() + serverOffset;
const board = createBoard();
// Every whiteboard's strokes by object id: the boardroom's, and uploaded ones
// (each keeps its own feed).
const boards = new Map([['whiteboard', board]]);
const boardFor = (id) => { if (!boards.has(id)) boards.set(id, createBoard()); return boards.get(id); };
// What an uploaded object of a built-in kind shows (its display.data), where
// the office's own read the World's shared state.
const dataOf = (f) => objects[f.id]?.display?.data || null;
let path = null, walkTarget = null, follow = null;
let autoStatus = null; // status set automatically (and which one), so we can undo it
let lastCoffee = 0;
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
// The map's region changes size when panels dock, collapse or the keyboard opens.
new ResizeObserver(() => { R.resize(); clampZoom(); }).observe(canvas);

// Zoom is continuous and unbounded on the way out; the renderer recomputes the
// view, culling and labels for whatever you pick. Only zooming in is capped.
const ZOOM_MAX = 3.2, ZOOM_MIN_PX = 1; // at least a pixel per tile
function clampZoom() {
  // Phones start at 1:1 so a room fits on screen; bigger screens a little closer.
  if (k === null) k = R.dpr * (phone() ? 1 : 1.5);
  k = Math.max((ZOOM_MIN_PX / 32) * R.dpr, Math.min(ZOOM_MAX * R.dpr, k));
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
  // Over the desk computer while it's up, so nothing slips by underneath it.
  ($('#workstation:not([hidden]) .ws-toasts') || $('.toasts')).append(t);
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
  g.imageSmoothingEnabled = false;
  g.drawImage(sheets.base, fr, 0, fr, fr, 0, 0, size, size);
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

// ---- boot screen: the spinner in index.html stays up until there's something real to show
const bootEl = $('#boot');
let bootTimer = null;
function bootText(text) { bootEl.querySelector('.boot-text').textContent = text; }
function bootShow(text) {
  bootText(text);
  bootEl.hidden = false; bootEl.classList.remove('gone', 'failed');
}
function bootDone() {
  clearTimeout(window.__bootTimer); clearTimeout(bootTimer);
  document.documentElement.classList.remove('booting');
  if (bootEl.hidden || bootEl.classList.contains('gone') || bootEl.classList.contains('failed')) return;
  bootEl.classList.add('gone');
  setTimeout(() => { if (bootEl.classList.contains('gone')) bootEl.hidden = true; }, 400);
}
// Waiting on the server: give it a while, then offer a retry.
function bootWait(text, ms = 15000) {
  bootShow(text);
  clearTimeout(window.__bootTimer); clearTimeout(bootTimer);
  bootTimer = setTimeout(() => window.bootFail?.("Couldn't reach the office. Check your connection and try again."), ms);
}

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
  else {
    await document.fonts?.ready.catch(() => {});
    bootDone();
  }
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

let entered = false, spritesReady = false;
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
  bootWait('Walking in…');
  $('#login').hidden = true;
  $('#hud').hidden = false;
  start({ name, note: noteIn.value.trim() });
}

// ---- networking -------------------------------------------------------------
const voice = createVoice({ send: (m) => net.send(m), myId: () => me?.id || '', onMedia: (ended) => mediaChanged(ended), prefs: store.get('mic', {}) });

// Who this browser is as a guest: a reconnect or another tab walks back in
// as the same guest instead of a second one. (Signed in, the DID does that.)
let guestKey = store.get('guest');
if (!/^[\w-]{16,64}$/.test(guestKey || '')) store.set('guest', guestKey = crypto.randomUUID());

function start(hello) {
  hello = { ...hello, guest: guestKey };
  net = connect(onMessage, () => net.send({ t: 'hello', ...hello, status: me?.status }), ({ kicked }) => sys(kicked ? 'You\'re out of the office.' : 'Connection lost, reconnecting…'));
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
      // The channel wing first: it decides what the map looks like.
      wing = m.wing || [];
      applyWing(wing);
      const pos = me ? { x: me.x, y: me.y } : null;
      me = { ...m.you, rx: m.you.x, ry: m.you.y, sheets: null };
      if (pos) { me.x = me.rx = pos.x; me.y = me.ry = pos.y; net.send({ t: 'move', x: me.x, y: me.y, dir: me.dir, moving: false, teleport: true }); }
      peers.set(me.id, me);
      sheetsFor(me).then((s) => { me.sheets = s; buildEmotes(); }).finally(() => { spritesReady = true; });
      // Sprites can be slow (they come from your PDS); don't hold the door for more than a few seconds.
      setTimeout(() => { spritesReady = true; }, 4000);
      for (const p of m.peers) addPeer(p);
      desks = m.desks; notes = m.notes; pomo = m.pomo; counters = m.counters; bookings = m.bookings || [];
      freeqRooms = m.freeq || {};
      objects = {};
      for (const [id, display] of Object.entries(m.objects || {})) objects[id] = { display };
      gallery = m.gallery || []; syncGallery(gallery);
      items = m.items || []; floor = m.floor || []; keeps = !!m.keeps; invChanged();
      refreshChannels();
      board.set(m.strokes);
      for (const [id, strokes] of Object.entries(m.feeds || {})) boardFor(id).set(strokes || []);
      for (const s of m.shouts || []) logChat(s);
      setStatusUI();
      roleChanged();
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
      if (!p) break;
      // You, walked from another tab or device you have the office open in:
      // follow along, and don't send it back.
      if (p === me) {
        me.x = me.rx = m.x; me.y = me.ry = m.y; me.dir = m.dir;
        path = null; walkTarget = null; pendingUse = null; follow = null;
        steered = { moving: m.moving }; lastSentPos = { x: m.x, y: m.y }; sentMoving = m.moving;
        break;
      }
      p.x = m.x; p.y = m.y; p.dir = m.dir; p.moving = m.moving;
      track(p);
      break;
    }
    case 'peer': {
      const p = peers.get(m.id);
      if (!p) break;
      for (const key of ['status', 'note', 'emote', 'audio', 'video', 'screen', 'pc', 'cup', 'role', 'muted']) if (key in m) p[key] = m[key];
      if (p === me && ('role' in m || 'muted' in m)) roleChanged();
      if ('role' in m || 'muted' in m) modal.admin?.refresh();
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
    // freeq gave a line said in a bridged room its msgid: it can be answered there now.
    case 'chat-id': {
      const d = [...log.children].find((el) => el.dataset.key === m.key);
      if (d) { d.dataset.msgid = m.msgid; if (d.reply) d.reply.msgid = m.msgid; }
      break;
    }
    case 'desks': desks = m.desks; refreshPeople(); break;
    case 'inv': items = m.items || []; invChanged(); break;
    case 'floor': floor = m.items || []; modal.inv?.refresh(); break;
    // A plugin object changed how it looks, or said something to the people near it.
    case 'obj': {
      const o = (objects[m.id] ||= {});
      if ('display' in m) o.display = m.display;
      // An uploaded whiteboard's strokes.
      if (m.feed) {
        const b = boardFor(m.id);
        if (m.feed.clear) b.clear(); else if (m.feed.set) b.set(m.feed.set); else if (m.feed.push) b.add(m.feed.push);
        if (modal.wb?.id === m.id) modal.wb.repaint();
      }
      if ('display' in m && modal.notesOpen === m.id) openNotes(FURNITURE.find((x) => x.id === m.id));
      if (m.say) {
        o.bubble = { text: m.say, at: performance.now() };
        const f = FURNITURE.find((x) => x.id === m.id);
        if (canHear(me, m)) logChat({ id: `obj:${m.id}`, name: f?.name || m.id, text: m.say, ts: serverNow(), scope: 'nearby' });
      }
      break;
    }
    case 'gallery': gallery = m.items || []; syncGallery(gallery); break;
    case 'galleryres': galleryWait.get(m.rid)?.(m.result || {}); galleryWait.delete(m.rid); break;
    case 'objui': {
      if (m.toast) toast(esc(localize(m.toast)));
      // No ui at all: a nudge from an object you're not using (the rally saw you arrive).
      if (modal.obj?.id !== m.id || !('ui' in m)) break;
      if (m.ui) modal.obj.show(m.ui); else if (m.toast && !modal.body.querySelector('button')) modal.close(); else modal.obj.idle();
      break;
    }
    case 'freeq': freeqRooms = m.rooms || {}; if (me) zoneChanged(lastZone, true); refreshChannels(); break;
    case 'wing': {
      const had = new Set(wing.map((r) => r.id));
      wing = m.rooms || [];
      applyWing(wing);
      // A path planned over the old map may cross a wall now.
      if (path) walkTo(walkTarget?.x ?? me.x, walkTarget?.y ?? me.y);
      refreshChannels();
      // The badge follows a change to the room you're standing in.
      if (lastZone?.channel) zoneChanged(zoneAt(me.x, me.y), true);
      if (modal.sign) modal.sign();
      const fresh = wing.filter((r) => !had.has(r.id));
      if (had.size && fresh.length === 1) sys(`🚪 A room for ${fresh[0].channel} opened off the hallway.`);
      break;
    }
    // What was said in a channel room before you walked in.
    case 'chanlog': {
      if (!m.lines?.length) break;
      sys(`Earlier in ${m.channel || 'this room'}:`);
      for (const l of m.lines) logChat({ id: `log:${l.name}`, name: l.name, text: l.text, ts: l.ts, scope: m.channel || '', freeq: l.freeq, msgid: l.msgid, replyTo: l.replyTo, backfill: true, earlier: true });
      break;
    }
    case 'chan': {
      if (m.op === 'open') {
        const r = m.room;
        if (!r) break;
        toast(`🚪 ${esc(r.channel)} is ${r.access?.open ? 'open' : esc(r.access?.text || '')} off the hallway.`, [['Walk there', () => walkToZone(ZONES.find((z) => z.id === r.id))]], 8000);
      } else if (m.op === 'accept') {
        toast('📜 Rules accepted. The door is open to you.', [['Walk in', () => walkToZone(ZONES.find((z) => z.id === m.room))]], 6000);
        if (modal.sign) modal.sign();
      } else if (m.op === 'check' && modal.signCheck) modal.signCheck(m.result);
      else if (m.op === 'knock') toast(`🚪 You knocked. ${m.result?.inside === 1 ? 'The person' : 'Everyone'} inside can let you in.`);
      else if (m.op === 'access' && modal.sign) modal.sign();
      break;
    }
    case 'notes': notes = m.notes; if (modal.notesOpen === 'noticeboard') openNotes(); break;
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
    case 'wb': if (m.op === 'clear') board.clear(); else if (m.op === 'set') board.set(m.strokes || []); else board.add(m.stroke); if (modal.wb?.id === 'whiteboard') modal.wb.repaint(); break;
    case 'wave': {
      const p = peers.get(m.from);
      chime();
      // A knock on a booked room I'm holding can be answered by letting them in.
      const z = zoneAt(me.x, me.y);
      const b = z?.bookable && activeBooking(bookings, z.id, serverNow());
      const letIn = m.kind === 'knock' && p && b && isHolder(b, me) && !isHolder(b, p);
      // A knock on a channel room's door: anyone inside can let them in.
      const chanIn = m.kind === 'knock' && p && m.chanRoom;
      toast(`${m.kind === 'knock' ? '🚪' : '👋'} <b>${esc(m.name)}</b> ${m.kind === 'knock' ? `is knocking${chanIn ? ` on ${esc(wing.find((r) => r.id === m.chanRoom)?.channel || 'the door')}` : ''}` : 'waved at you'}`, p ? [
        ...(letIn ? [['Let in', () => net.send({ t: 'book', op: 'admit', id: b.id, to: p.id })]] : []),
        ...(chanIn ? [['Let in', () => net.send({ t: 'chan', op: 'admit', room: m.chanRoom, to: p.id })]] : []),
        ['Walk over', () => walkTo(p.x, p.y)], ['Wave back', () => net.send({ t: 'wave', to: p.id })],
      ] : [], letIn || chanIn ? 15000 : 6000);
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
      if (m.ref === 'new') roomAsk.done('');
      if (b.cancelled) toast(`📅 Cancelled “${esc(b.title)}”`);
      else if (m.ref === 'new') toast(`📅 Booked ${esc(room.name)} ${dayWord(b.start)} ${fmtRange(b)}: “${esc(b.title)}”`);
      modal.rooms?.();
      break;
    }
    case 'roomnote': {
      const room = roomById(m.room);
      const go = ['soon', 'start', 'invite', 'admit'].includes(m.kind) && zoneAt(me.x, me.y)?.id !== m.room;
      chime(m.kind === 'start' ? 'focus' : 'soft');
      toast(esc(localize(m.text)), go ? [['Walk there', () => walkInto(room)]] : [], 9000);
      break;
    }
    case 'bounce': {
      me.x = me.rx = m.x; me.y = me.ry = m.y;
      path = null; walkTarget = null; pendingUse = null; follow = null;
      if (performance.now() - (onMessage.bounced || 0) > 4000) {
        onMessage.bounced = performance.now();
        // A channel room's door: the sign says how to get in.
        if (m.moved) { if (m.text) toast(`🛡️ ${esc(localize(m.text))}`); }
        else if (m.door) toast(esc(localize(m.text)), [['Read the sign', () => openSign(m.room)]], 8000);
        else toast(esc(localize(m.text)), [['Knock', () => knock(m.room)]], 8000);
      }
      break;
    }
    // Something in the office (a room, a plugin, a moderator) walks you somewhere.
    case 'walk': {
      follow = null;
      walkTo(m.x, m.y);
      if (!path) net.send({ t: 'move', x: m.x, y: m.y, dir: me.dir, moving: false, teleport: true });
      if (!path) { me.x = me.rx = m.x; me.y = me.ry = m.y; }
      if (m.text) toast(esc(localize(m.text)));
      break;
    }
    // Your MCP session (follow_me) has you follow someone, or stop.
    case 'follow': {
      const t = m.id && peers.get(m.id);
      path = null; walkTarget = null; pendingUse = null;
      follow = t && t !== me ? m.id : null;
      if (follow) toast(`Following ${esc(t.name)}`, [['Stop', () => { follow = null; }]], 5000);
      break;
    }
    case 'toast': toast(esc(localize(m.text))); if (m.ws) { chime('break'); station.poke(); } break;
    case 'wsr': station.onReply(m); break;
    // How the freeq bridge is doing for you: a line in the chat log, and a toast when something failed.
    case 'freeq-note': {
      sys(`${m.ok ? '💬' : '⚠️'} ${m.text}`);
      // A lost or expired sign-in: one click goes back through your PDS and returns here.
      if (!m.ok) toast(`⚠️ ${esc(m.text)}`, /sign in again/i.test(m.text) && me?.did ? [['Sign in again', signInAgain]] : [], 10000);
      break;
    }
    case 'rtc': voice.onSignal(m.from, m.data); break;
    case 'fq-call': fqCall.onMessage(m); break;
    case 'error':
      // A booking from a room's door panel says what went wrong right there.
      if (m.ref === 'new' && roomAsk.pending && modal.rooms) { roomAsk.done(`⚠️ ${esc(localize(m.message))}`); break; }
      toast(`⚠️ ${esc(localize(m.message))}`);
      break;
    case 'kicked': {
      toast(`🚪 ${esc(localize(m.text))}`, [], 20000); sys(m.text);
      // Out: the office empties around you.
      peers.clear(); peers.set(me.id, me); refreshPeople();
      break;
    }
    case 'modres': modWait.get(m.ref)?.(m.result || {}); modWait.delete(m.ref); break;
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
  const when = m.backfill ? `<span class="missed" title="${m.earlier ? 'Said before you walked in' : 'Said on freeq while the office was away'}">${esc(fmtTime(m.ts))}</span> ` : '';
  if (m.action) d.classList.add('act');
  // A reply (threaded on freeq) quotes what it answers above it.
  const re = m.replyTo;
  const quote = re ? `<span class="rq" title="${re.text ? 'Show the message it answers' : 'Answers a message from before'}">↩ ${re.name ? `<b>${esc(re.name)}</b> ` : ''}${esc(re.text || 'an earlier message')}</span>` : '';
  d.innerHTML = `${quote}${scope}${when}<b style="color:${colorFor(m.id)}">${esc(markedName(m.name, m.freeq ? 'freeq' : peers.get(m.id)?.kind))}</b> ${linkify(esc(m.text))}`;
  if (re?.msgid) d.dataset.re = re.msgid;
  if (m.msgid) d.dataset.msgid = m.msgid;
  if (m.key) d.dataset.key = m.key;
  // Anyone else's line can be clicked (or tapped) to answer it. Lines in a
  // freeq channel (theirs, or the office's sent there) answer as freeq replies.
  if (m.id !== me?.id) {
    d.classList.add('replyable');
    d.title = 'Click to reply';
    d.reply = { id: m.id, name: m.name, handle: peers.get(m.id)?.handle || m.name, text: m.text, channel: m.freeq || m.msgid || m.key ? m.scope : null, msgid: m.msgid || null };
  }
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

// The side panel (zone, minimap, people, channels, chat) docks right of the map
// on wide screens; on phones the minimap/people/channels open as a sheet over it.
const hud = $('#hud'), sideBtn = $('.side-btn');
const phoneLayout = matchMedia('(max-width: 600px), (max-width: 760px) and (orientation: portrait)');
const sideKey = () => (phoneLayout.matches ? 'sideOpenPhone' : 'sideOpen');
function setSide(open, save = true) {
  hud.classList.toggle('side-closed', !open);
  sideBtn.setAttribute('aria-pressed', String(open));
  if (save) store.set(sideKey(), open);
}
const loadSide = () => setSide(store.get(sideKey(), !phoneLayout.matches), false);
loadSide();
phoneLayout.addEventListener('change', loadSide);
sideBtn.addEventListener('click', () => setSide(hud.classList.contains('side-closed')));
// Small screens: the toolbar scrolls sideways (fading at the edge while there's
// more), and # opens the panel on the channel list so rooms are a tap away.
const tbScroll = $('.tb-scroll');
const tbMore = () => tbScroll.classList.toggle('more', tbScroll.scrollLeft + tbScroll.clientWidth < tbScroll.scrollWidth - 2);
tbScroll.addEventListener('scroll', tbMore, { passive: true });
new ResizeObserver(tbMore).observe(tbScroll);
$('.chan-btn').addEventListener('click', () => {
  const showing = !hud.classList.contains('side-closed') && !$('.channels').classList.contains('collapsed');
  if (showing) return setSide(false);
  setChannelsCollapsed(false);
  setPeopleCollapsed(true);
  setSide(true);
});
// Opens whatever the chat needs to be typed into, then focuses it.
function focusChat() {
  if (!phoneLayout.matches && hud.classList.contains('side-closed')) setSide(true);
  chatIn.focus();
}
let chatCollapsed = store.get('chatCollapsed', coarse && phone()), unread = 0;
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
if (chatH) hud.style.setProperty('--chat-h', `${chatH}px`);
if (store.get('chatGrow', 0)) hud.style.setProperty('--chat-grow', store.get('chatGrow', 1));
$('.chat-grip').addEventListener('pointerdown', (e) => {
  if (chatCollapsed) return;
  e.preventDefault();
  const grip = e.currentTarget, startY = e.clientY, startH = log.getBoundingClientRect().height;
  grip.setPointerCapture(e.pointerId);
  // Docked beside the map, the grip splits the side column between the open list and the chat.
  const list = !phoneLayout.matches && [...document.querySelectorAll('.hud-tr > .card')].find((c) => !c.hidden && !c.classList.contains('collapsed'));
  if (list) {
    const chat0 = chatEl.getBoundingClientRect().height, both = chat0 + list.getBoundingClientRect().height;
    const split = (ev) => {
      const ch = Math.max(130, Math.min(both - 104, chat0 + startY - ev.clientY));
      const grow = +(ch / (both - ch)).toFixed(3);
      hud.style.setProperty('--chat-grow', grow);
      store.set('chatGrow', grow);
      stickToBottom();
    };
    grip.addEventListener('pointermove', split);
    grip.addEventListener('pointerup', () => grip.removeEventListener('pointermove', split), { once: true });
    return;
  }
  const move = (ev) => {
    // On phones the chat sits under the map; docked, it shares the side column with the lists.
    const h = Math.max(80, Math.min(phoneLayout.matches ? innerHeight * 0.45 : innerHeight - 260, startH + startY - ev.clientY));
    hud.style.setProperty('--chat-h', `${Math.round(h)}px`);
    stickToBottom();
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    store.set('chatHeight', Math.round(log.getBoundingClientRect().height));
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
});
const linkify = (s) => s.split(/(https?:\/\/[^\s<]+)/g)
  .map((part, i) => (i % 2 ? `<a href="${part}" target="_blank" rel="noopener">${part}</a>` : placeify(part))).join('');

// ---- places: desks, rooms and channels you can click to walk to ------------
const placeLink = (kind, id, html) => `<button type="button" class="place" data-place="${kind}:${esc(id)}" title="Walk there">${html}</button>`;
// Turns desk ids, area names and attached #channels in (escaped) text into place links.
function placeify(html) {
  const names = ZONES.filter((z) => z.name.length >= 4 && z.id !== 'booths').map((z) => [z.name.toLowerCase(), z.id]);
  const chans = Object.entries(freeqRooms).map(([id, c]) => [String(c.channel || '').toLowerCase(), id]).filter(([c]) => c.startsWith('#'));
  const byName = new Map([...names, ...chans]);
  const alts = [...byName.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(desk-\\d+)\\b${alts.length ? `|(?<![\\w#])(${alts.join('|')})(?![\\w-])` : ''}`, 'gi');
  return html.replace(re, (m, desk, name) => {
    if (desk) return DESKS.some((d) => d.id === desk.toLowerCase()) ? placeLink('desk', desk.toLowerCase(), m) : m;
    const id = byName.get(name.toLowerCase());
    return id ? placeLink('zone', id, m) : m;
  });
}
function walkToPlace(kind, id) {
  if (kind === 'desk') {
    const d = DESKS.find((x) => x.id === id);
    if (d) walkNear(d.seat.x, d.seat.y, id);
  } else if (kind === 'zone') walkToZone(ZONES.find((z) => z.id === id));
}
// Walks to the open tile nearest (x, y) that has a way there.
function walkNear(x, y, what) {
  if (!me) return;
  const spots = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const tx = Math.floor(x) + dx, ty = Math.floor(y) + dy;
    if (!isBlocked(tx, ty)) spots.push({ x: tx + 0.5, y: ty + 0.5, d: Math.hypot(tx + 0.5 - x, ty + 0.5 - y) });
  }
  spots.sort((a, b) => a.d - b.d);
  for (const s2 of spots) if (findPath(me.x, me.y, s2.x, s2.y)) return walkTo(s2.x, s2.y);
  toast(`Couldn't find a way to ${esc(what)}.`, [], 3000);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.place');
  if (!b) return;
  e.preventDefault();
  const [kind, ...rest] = b.dataset.place.split(':');
  if (modal.isOpen) modal.close();
  walkToPlace(kind, rest.join(':'));
});

const chatIn = $('.chat-input');
// Replying: a quote of the line above the input, and the @mention in it.
const replyEl = $('.reply-to');
let replyTo = null;
const hereChannel = () => freeqRooms[lastZone?.id]?.channel || null;
function showReply() {
  replyEl.hidden = !replyTo;
  if (!replyTo) return;
  const r = replyTo, away = r.channel && r.channel !== hereChannel();
  const zone = away && ZONES.find((z) => freeqRooms[z.id]?.channel === r.channel);
  replyEl.querySelector('.q').innerHTML = `↩ <b>${esc(r.name)}</b> ${esc(r.text)}`;
  replyEl.querySelector('.where').innerHTML = away
    ? `said in ${esc(r.channel)}. ${zone ? `${placeLink('zone', zone.id, `Walk to ${esc(zone.name)}`)} to answer there.` : 'Your reply stays here.'}`
    : '';
}
function startReply(r) {
  replyTo = r;
  const at = `@${r.handle.replace(/\s+/g, '')} `;
  // Keep whatever was already typed after a different mention.
  const rest = chatIn.value.replace(/^@\S+\s*/, '');
  chatIn.value = at + rest;
  showReply();
  focusChat();
  chatIn.setSelectionRange(chatIn.value.length, chatIn.value.length);
}
function endReply() { replyTo = null; showReply(); }
replyEl.querySelector('.x').addEventListener('click', () => {
  chatIn.value = chatIn.value.replace(/^@\S+\s*/, '');
  endReply();
  chatIn.focus();
});
log.addEventListener('click', (e) => {
  // The quote on a reply jumps to the line it answers, when that's still in the log.
  const q = e.target.closest('.rq');
  if (q) {
    const id = q.closest('.m')?.dataset.re;
    const to = id && [...log.children].find((el) => el.dataset.msgid === id);
    if (to) { to.scrollIntoView({ block: 'center', behavior: 'smooth' }); to.classList.remove('flash'); void to.offsetWidth; to.classList.add('flash'); }
    return;
  }
  const d = e.target.closest('.m.replyable');
  // Links and place buttons do their own thing; dragging to copy text isn't a reply.
  if (!d?.reply || e.target.closest('a, button') || String(getSelection()).trim()) return;
  startReply(d.reply);
});
$('.chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatIn.value.trim();
  if (!text) { chatIn.blur(); endReply(); return; }
  // On freeq the reply is threaded too (+reply), when it's going to that channel.
  const reply = replyTo?.msgid && replyTo.channel === hereChannel() ? replyTo.msgid : undefined;
  net.send({ t: 'chat', text, ...(reply ? { reply } : {}) });
  chatIn.value = '';
  chatIn.blur();
  endReply();
});
chatIn.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (replyTo) { e.stopPropagation(); chatIn.value = chatIn.value.replace(/^@\S+\s*/, ''); return endReply(); }
  chatIn.blur();
});
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
// The mic button turns voice on and off (grey/green); the mute button next to
// it only shows while voice is on, and goes red while you're muted.
const muteBtn = $('.mute');
muteBtn.addEventListener('click', toggleMute);
function setMicState(on) {
  if (!on && voice.muted) voice.setMuted(false);
  micBtn.className = on ? 'tb mic on' : 'tb mic';
  micBtn.title = on ? 'Mic on: people near you can hear you. Click to turn it off (M)' : 'Mic off. Click to talk to people near you (M)';
  micBtn.setAttribute('aria-pressed', String(!!on));
  muteBtn.hidden = !on;
  syncMute();
}
function syncMute() {
  muteBtn.classList.toggle('muted', voice.muted);
  muteBtn.setAttribute('aria-pressed', String(voice.muted));
  muteBtn.title = voice.muted ? 'Muted: nobody can hear you. Click to unmute (Shift+M)' : 'Mute (Shift+M)';
  muteBtn.setAttribute('aria-label', voice.muted ? 'Unmute' : 'Mute');
}
function toggleMute() {
  if (!voice.on || voice.listening) return;
  voice.setMuted(!voice.muted);
  syncMute();
}
setMicState(false);
async function toggleMic() {
  if (me?.muted > serverNow() && (!voice.on || voice.listening)) return toast(`🔇 A moderator muted you until ${esc(fmtTime(me.muted))}`);
  if (!voice.on || voice.listening) {
    const ok = await voice.enable();
    if (!ok) return toast('🎙️ Microphone permission was blocked. Allow it in your browser to talk.');
    net.send({ t: 'audio', on: true });
    me.audio = true;
    setMicState(true);
    toast('🎙️ Voice on. People near you (or in the same room) can hear you.');
  } else {
    voice.disable();
    net.send({ t: 'audio', on: false });
    me.audio = false;
    setMicState(false);
  }
  micPopSync();
}

// ---- mic level meter, device picker and input volume ------------------------
const micLvl = $('.lvl', micBtn), micHint = $('.mic-hint'), micSel = $('.mic-select');
const gainIn = $('.gain-input'), gainOut = $('.gain-out'), popMeter = $('.mic-pop .meter span'), micNote = $('.mic-note');
const saveMic = () => store.set('mic', { deviceId: voice.deviceId, gain: voice.gain });
gainIn.value = voice.gain; gainOut.textContent = `${Math.round(voice.gain * 100)}%`;
gainIn.addEventListener('input', () => {
  voice.setGain(+gainIn.value);
  gainOut.textContent = `${Math.round(gainIn.value * 100)}%`;
  saveMic();
});
micSel.addEventListener('change', async () => {
  if (!(await voice.setDevice(micSel.value))) toast('🎙️ Could not open that microphone.');
  saveMic();
});
// Device names only show up once the mic has been allowed, so refresh the list
// whenever the popover opens or the mic turns on.
async function micPopSync() {
  micNote.hidden = voice.hasMic;
  const list = await voice.devices();
  const cur = voice.deviceId;
  micSel.innerHTML = '<option value="">Default</option>' + list.filter((d) => d.deviceId && d.deviceId !== 'default')
    .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Microphone ${i + 1}`)}</option>`).join('');
  micSel.value = [...micSel.options].some((o) => o.value === cur) ? cur : '';
}
$('.mic-more').addEventListener('click', micPopSync);
navigator.mediaDevices?.addEventListener?.('devicechange', micPopSync);

// Painted at ~20 fps from the frame loop, and only while the mic is on.
let meterAt = 0, meterShown = -1, hintOn = false;
function paintMeter(t, mutedTalking) {
  if (t - meterAt < 50) return;
  meterAt = t;
  const v = voice.hasMic ? Math.round(voice.level * 40) / 40 : 0;
  if (v !== meterShown) {
    meterShown = v;
    micLvl.style.transform = `scaleY(${v})`;
    if (!popMeter.closest('[hidden]')) popMeter.style.transform = `scaleX(${v})`;
  }
  if (mutedTalking !== hintOn) {
    hintOn = mutedTalking;
    micHint.hidden = !hintOn;
    muteBtn.classList.toggle('nudge', hintOn);
  }
}

$('.zoom-in').addEventListener('click', () => zoom(1));
$('.zoom-out').addEventListener('click', () => zoom(-1));
function zoom(d) { zoomAt(1.25 ** d); }
// Scales the zoom by `factor`, keeping the world point under (sx, sy) (canvas
// pixels; default the centre) where it is. The camera stays offset from you by
// the difference until you walk, then drifts back.
let camOff = { x: 0, y: 0 };
function zoomAt(factor, sx, sy) {
  const { w: vw, h: vh } = R.size;
  if (sx === undefined) { sx = vw / 2; sy = vh / 2; }
  const at = R.toWorld(sx, sy);
  k *= factor; clampZoom();
  const T = 32 * (k / R.dpr);
  cam.x = at.x - (sx - vw / 2) / T; cam.y = at.y - (sy - vh / 2) / T;
  if (me) camOff = { x: cam.x - me.x, y: cam.y - (me.y - 0.5) };
}
// Frames the whole office (however big it has grown) in the map region.
function zoomToFit() {
  k = R.fitZoom(); clampZoom();
  cam.x = W / 2; cam.y = H / 2;
  if (me) camOff = { x: cam.x - me.x, y: cam.y - (me.y - 0.5) };
}
const canvasPoint = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Mouse wheels send lines or big pixel steps, trackpads small pixel deltas; both map smoothly.
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  zoomAt(Math.exp(-Math.max(-300, Math.min(300, dy)) * (e.ctrlKey ? 0.01 : 0.0015)), ...canvasPoint(e));
}, { passive: false });

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

// ---- inventory -------------------------------------------------------------------
const invBtn = $('.inv-btn'), invCount = $('.inv-btn .inv-count');
function invChanged() {
  const n = items.reduce((a, s) => a + s.qty, 0);
  invCount.textContent = n > 99 ? '99+' : n;
  invCount.hidden = !n;
  modal.inv?.refresh();
}
const invCtx = {
  send: (m) => net.send(m), me: () => me, items: () => items, floor: () => floor,
  peers: () => [...peers.values()], keeps: () => keeps, walkTo, place: startPlacing,
};

// Placing: choose "Place" on something you carry, then click or tap a spot
// within reach (highlighted; the same rules the server checks, items.js
// placeTiles). One at a time while the stack lasts. Esc, the 🎒 button, the
// prompt pill or a tap out of reach cancels.
let placing = null; // { id, item, hover: { x, y } | null, tiles, key }
function startPlacing(s) {
  if (!s) return;
  modal.close();
  if (station.isOpen) station.close();
  path = null; walkTarget = null; pendingUse = null;
  placing = { id: s.id, item: s, hover: null, tiles: null, key: '' };
  toast(`${esc(s.emoji)} ${coarse ? 'Tap' : 'Click'} a highlighted spot near you to put down the ${esc(s.name)}. ${coarse ? 'Tap the pill' : 'Esc'} to stop.`, [], 4000);
}
function stopPlacing() { placing = null; canvas.style.cursor = ''; }
// The tiles in reach, worked out again only when you move or the floor changes.
function placingTiles() {
  const standing = gallery.filter((i) => !i.carried && Number.isFinite(i.x));
  const key = `${Math.floor(me.x)},${Math.floor(me.y)},${floor.map((e) => e.id).join()},${standing.map((i) => `${i.x}:${i.y}`).join()},${bookings.length}`;
  if (placing.key !== key) { placing.key = key; placing.tiles = placeTiles(me, { floor: [...floor, ...standing.map((i) => ({ x: i.x + 0.5, y: i.y + 0.5 }))], bookings, now: serverNow() }); }
  return placing.tiles;
}
function placeAt(w) {
  const t = placingTiles().get(`${Math.floor(w.x)},${Math.floor(w.y)}`);
  if (!t) return stopPlacing();
  if (!t.ok) return toast(esc(cap(t.why)), [], 2500);
  net.send({ t: 'inv', op: 'place', id: placing.id, x: t.x + 0.5, y: t.y + 0.5, qty: 1 });
  const s = items.find((i) => i.id === placing.id);
  if (!s || s.qty <= 1) stopPlacing();
}
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
function openInv() {
  if (!me) return;
  if (placing) return stopPlacing();
  modal.inv = openInventory(modal, invCtx);
  modal.onclose = () => (modal.inv = null);
}
invBtn.addEventListener('click', openInv);

// What E (or the prompt button) acts on: something on the floor within
// reach first, then furniture.
function currentTarget() {
  const e = nearestFloorItem(floor, me.x, me.y, 1.1);
  if (e) return { floorItem: e.id, x: e.x, y: e.y, w: 0, h: 0 };
  return nearestInteractable(me.x, me.y);
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
      <kbd>E</kbd><span>Interact: claim a desk, desk computer, whiteboard, coffee, pomodoro, arcade, jukebox, vending machine, 8-ball</span>
      <kbd>Enter</kbd><span>Chat with people who can hear you</span>
      <kbd>1-9</kbd><span>Emotes. With an rpg.actor sprite these swap in your own emote sheets</span>
      <kbd>M</kbd><span>Proximity voice on / off</span>
      <kbd>Shift+M</kbd><span>Mute / unmute</span>
      <kbd>N</kbd><span>Mute or unmute music from the jukebox</span>
      <kbd>B</kbd><span>Meeting rooms: schedule and booking</span>
      <kbd>U</kbd><span>Uploaded objects: plugins people placed in the office, and uploading your own</span>
      <kbd>I</kbd><span>Your things: eat, drink, give them to someone nearby, or place them on a spot near you. E picks up what's at your feet</span>
      <kbd>C</kbd><span>Camera on/off (in A/V rooms)</span>
      ${can(me?.role, 'roles.view') ? '<kbd>G</kbd><span>Moderation: who\'s in and their roles, mute, move and kick people, grant roles</span>' : ''}
      <kbd>+ −</kbd><span>Zoom (or scroll over the map, toward the cursor). <kbd>0</kbd> shows the whole office</span>
    </div>${coarse ? '</details>' : ''}
    <h3 style="margin-top:16px">Who hears you</h3>
    <p class="small">In open areas, anyone within a few steps. In the <b>Boardroom</b>, <b>Huddle Room</b> and <b>Phone Booths</b>, only people in the same room. The <b>Deep Work Den</b> is text-only and runs a shared pomodoro. Start a message with <code>/shout</code> to reach the whole office, or <code>@name</code> to tap someone anywhere.</p>
    <h3>Meeting rooms</h3>
    <p class="small">Book the Boardroom, Huddle Room or a phone booth from the 📅 button or the panel by each door. The Boardroom and Huddle Room are <b>A/V rooms</b>: inside, turn on your camera or share your screen with everyone in the room. While a booking runs only the booker and invitees can walk in (others knock to be let in); bookings nobody turns up to are released after 10 minutes.</p>
    <h3>Roles</h3>
    <p class="small">Signed-in people are members and agents; everyone else is a guest. Moderators (🔨) can mute, move and kick people, tidy the floor, notices and uploads, close channel rooms and cancel bookings; admins (🛡️) also hand out roles; owners (👑) run the office. Their badge shows on their name.</p>
    <h3>Agents</h3>
    <p class="small">AI agents can work here too. They connect over the same WebSocket protocol, claim desks and answer @mentions. See <code>scripts/agent.mjs</code>.</p>
    <p class="small" style="margin-top:12px">People without their own sprite wear stock <a href="https://rpg.actor/generator" target="_blank" rel="noopener">rpg.actor</a> characters. Generator art by <a href="https://bsky.app/profile/isilme.reverie.house" target="_blank" rel="noopener">isilme</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>.</p>`);
}

// ---- people list & minimap ---------------------------------------------------
const peopleHead = $('.people-head');
// People and channel rooms work as an accordion: opening one gives it the
// column's spare height and folds the other to its header.
function setPeopleCollapsed(c) {
  $('.people').classList.toggle('collapsed', c);
  peopleHead.setAttribute('aria-expanded', String(!c));
  store.set('peopleCollapsed', c);
}
setPeopleCollapsed(store.get('peopleCollapsed', innerWidth <= 760 || (coarse && phone())));
peopleHead.addEventListener('click', () => {
  const open = $('.people').classList.contains('collapsed');
  setPeopleCollapsed(!open);
  if (open && !phoneLayout.matches) setChannelsCollapsed(true);
});
let peopleTimer = null;
function refreshPeople() {
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(() => {
    const list = [...peers.values()].sort((a, b) => (a === me ? -1 : b === me ? 1 : a.name.localeCompare(b.name)));
    $('.people .count').textContent = list.length;
    $('.people-list').innerHTML = list.map((p) => {
      const z = zoneAt(p.x, p.y);
      const sub = [p.note, z?.name].filter(Boolean).join(' · ');
      return `<li data-id="${p.id}"><span class="dot" style="background:${statusColor(p.status)}"></span><span class="who"><b>${esc(markedName(p.name, p.kind))}${p === me ? ' (you)' : ''} ${p.kind === 'agent' ? '<span class="badge">AGENT</span>' : p.kind === 'freeq' ? '<span class="badge freeq">FREEQ</span>' : ''}${roleTag(p.role)}</b><span>${esc(sub)}</span></span>${p.audio ? '🎙️' : ''}</li>`;
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
setChannelsCollapsed(store.get('channelsCollapsed', coarse && phone()));
// Docked, only one list is open at a time.
if (!phoneLayout.matches && !$('.people').classList.contains('collapsed')) setChannelsCollapsed(true);
channelsHead.addEventListener('click', () => {
  const open = $('.channels').classList.contains('collapsed');
  setChannelsCollapsed(!open);
  if (open && !phoneLayout.matches) setPeopleCollapsed(true);
});
const ago = (t) => {
  const s = Math.max(0, (serverNow() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
// Channel rooms off the hallway (and any core area a source attached a
// channel to), busiest and most recent first.
function refreshChannels() {
  const here = me && zoneAt(me.x, me.y)?.id;
  const rooms = new Map();
  for (const r of wing) rooms.set(r.id, { id: r.id, channel: r.channel, members: r.members, topic: r.topic, access: r.access, sources: r.sources });
  for (const [zoneId, c] of Object.entries(freeqRooms)) rooms.set(zoneId, { ...rooms.get(zoneId), ...c, id: zoneId, freeq: true, sources: [...new Set([...(rooms.get(zoneId)?.sources || []), 'freeq'])] });
  const list = [...rooms.values()].map((c) => ({ ...c, zone: ZONES.find((z) => z.id === c.id) })).filter((c) => c.zone)
    .sort((a, b) => (b.last || 0) - (a.last || 0) || (b.members || 0) - (a.members || 0) || a.channel.localeCompare(b.channel));
  const canOpen = !!(me?.did || me?.kind === 'agent');
  $('.channels').hidden = !list.length && !canOpen;
  $('.chan-btn').hidden = $('.channels').hidden;
  $('.channels .count').textContent = list.length;
  $('.channel-list').innerHTML = list.map((c) => {
    const live = c.last && serverNow() - c.last < 5 * 60000;
    const a = c.access || accessOf(null);
    const where = c.zone.gen ? (c.sources?.includes('freeq') ? 'freeq' : 'office') : c.zone.name;
    const sub = [`${a.icon} ${a.text}`, where, c.last ? ago(c.last) : c.topic].filter(Boolean).join(' · ');
    return `<li class="${c.zone.id === here ? 'here' : ''}"><button type="button" data-zone="${c.zone.id}" title="${esc(c.topic ? `${c.channel}: ${c.topic}` : c.channel)}. ${a.open ? 'Walk there' : 'Walk to the door'}">`
      + `<span class="hash ${a.open ? '' : 'gated'}" aria-hidden="true">${a.open ? '#' : a.icon.split(/(?=\p{Extended_Pictographic})/u)[0]}</span><span class="who"><b>${live ? '<span class="live" title="Active in the last 5 minutes"></span>' : ''}${esc(c.channel.replace(/^#/, ''))}</b><span>${esc(sub)}</span></span>`
      + `<span class="members" title="${c.members || 0} in the channel${c.here !== undefined && c.here !== c.members ? `, ${c.here} standing in the room (the rest are drawn in another one they're in)` : ''}">${c.members || 0} 👤</span></button></li>`;
  }).join('') + (canOpen ? '<li class="open-room"><button type="button" class="new-room">＋ Open a room…</button></li>' : '');
  $('.channel-list').querySelectorAll('button[data-zone]').forEach((b) => b.addEventListener('click', () => {
    // On phones the list is a sheet over the map: get it out of the way to watch the walk.
    if (phoneLayout.matches) setSide(false);
    walkToZone(ZONES.find((z) => z.id === b.dataset.zone));
  }));
  $('.channel-list .new-room')?.addEventListener('click', openNewRoom);
}

// Open a room for a channel: it's built off the hallway for everyone.
function openNewRoom() {
  modal.open(`
    <h2>Open a room</h2>
    <p class="small muted">A room for a channel, built off the hallway under the office. Rooms nobody uses for a week are let go.</p>
    <form class="new-room-form">
      <label>Channel <input name="name" required maxlength="33" placeholder="#design" pattern="#?[\\p{L}\\p{N}][\\p{L}\\p{N}_.\\-]{0,31}"></label>
      ${accessFields('open', '')}
      <div class="row"><button class="btn primary">Open it</button></div>
    </form>`);
  const form = modal.body.querySelector('form');
  wireAccess(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    net.send({ t: 'chan', op: 'open', name: fd.get('name'), access: fd.get('access'), rules: fd.get('rules') || undefined });
    modal.close();
  });
}

const accessFields = (access, rules, legend = 'Who can walk in') => `
  <fieldset class="access-pick"><legend>${legend}</legend>
    <label><input type="radio" name="access" value="open" ${access === 'open' ? 'checked' : ''}> 🚪 Anyone</label>
    <label><input type="radio" name="access" value="rules" ${access === 'rules' ? 'checked' : ''}> 📜 People who accept the rules</label>
    <label><input type="radio" name="access" value="invite" ${access === 'invite' ? 'checked' : ''}> 🔒 Invite only (knock, someone inside lets you in)</label>
  </fieldset>
  <label class="rules-text" ${access === 'rules' ? '' : 'hidden'}>Rules <textarea name="rules" maxlength="2000" rows="4" placeholder="Be kind. Stay on topic.">${esc(rules || '')}</textarea></label>`;
function wireAccess(form) {
  const sync = () => { const v = new FormData(form).get('access'); form.querySelector('.rules-text').hidden = v !== 'rules'; form.querySelector('textarea').required = v === 'rules'; };
  form.querySelectorAll('input[name=access]').forEach((i) => i.addEventListener('change', sync));
  sync();
}

// The sign by a channel room's door: who may come in, whether you may, and how.
function openSign(roomId) {
  let check = null;
  const render = () => {
    const r = wing.find((x) => x.id === roomId);
    if (!r) return modal.close();
    const p = r.policy, a = r.access || accessOf(p);
    const mine = r.sources?.includes('office') && ((r.by === me.name && me.did) || can(me.role, 'rooms.policy'));
    const closable = can(me.role, 'rooms.close');
    const inside = zoneAt(me.x, me.y)?.id === roomId;
    const needs = check?.needs || [];
    const from = r.sources?.includes('freeq') ? `<a href="https://freeq.at" target="_blank" rel="noopener">freeq</a>` : r.by ? `opened by ${esc(r.by)}` : 'the office';
    const roles = Object.entries(p?.roles || {}).map(([role, req]) => `<li><b>${esc(role)}</b>: ${esc(describeAccess(req, p))}</li>`).join('');
    const needRow = (n) => {
      if (n.type === 'ACCEPT') return `<li>${n.or ? '<i>or</i> ' : ''}📜 Accept the rules below <button class="btn primary accept" data-hash="${esc(n.hash)}">I accept</button></li>`;
      if (n.type === 'INVITE') return `<li>${n.or ? '<i>or</i> ' : ''}🔒 Knock: someone inside can let you in <button class="btn knock">🚪 Knock</button></li>`;
      if (n.type === 'PRESENT') return `<li>${n.or ? '<i>or</i> ' : ''}🎫 ${esc(n.label)}${n.url ? ` <a class="btn ghost" href="${esc(n.url)}" target="_blank" rel="noopener">Get it on freeq</a>` : ''}<br><span class="small muted">Once freeq lets you into ${esc(r.channel)}, the door opens to you too.</span></li>`;
      return `<li>${n.or ? '<i>or</i> ' : ''}⛔ ${esc(n.label)}</li>`;
    };
    modal.open(`
      <h2 class="sign-title"><span class="sign-icon">${a.icon}</span> ${esc(r.channel)}</h2>
      <p class="small muted">${esc(a.text)} · ${from}${r.topic ? ` · ${esc(r.topic)}` : ''} · ${r.members || 0} in the channel</p>
      <div class="room-now ${check ? (check.ok ? 'free' : 'busy') : ''}"><div>${!check ? 'Checking the door…' : check.ok ? (inside ? '<b>You\'re in.</b>' : '<b>You may walk in.</b>') : `<b>The door is shut to you.</b> To get in, ${esc(check.require || 'meet the policy')}.`}</div></div>
      ${check && !check.ok && needs.length ? `<ul class="needs">${needs.map(needRow).join('')}</ul>` : ''}
      ${p?.rules ? `<h3>Rules</h3><div class="rules">${esc(p.rules)}</div>` : ''}
      ${roles ? `<h3>Roles</h3><ul class="small">${roles}</ul>` : ''}
      <div class="row">${check?.ok && !inside ? '<button class="btn primary go">Walk in</button>' : ''}${closable ? '<button class="btn ghost danger close-room" title="As a moderator: archived once empty, and stays closed">🛡️ Close room</button>' : ''}</div>
      ${mine ? `<form class="access-form">${accessFields(p?.require?.type === 'INVITE' ? 'invite' : p?.rules ? 'rules' : 'open', p?.rules, 'Who can walk in (you opened it)')}<div class="row"><button class="btn">Save</button></div></form>` : ''}`, 'sign-modal');
    const body = modal.body;
    body.querySelector('.accept')?.addEventListener('click', (e) => net.send({ t: 'chan', op: 'accept', room: roomId, hash: e.target.dataset.hash }));
    body.querySelector('.knock')?.addEventListener('click', () => net.send({ t: 'chan', op: 'knock', room: roomId }));
    body.querySelector('.go')?.addEventListener('click', () => { modal.close(); walkToZone(ZONES.find((z) => z.id === roomId)); });
    body.querySelector('.close-room')?.addEventListener('click', async (e) => { if (await ask(e.currentTarget, `Close ${r.channel} for everyone? It stays closed until a moderator opens it again.`, 'Close it')) { net.send({ t: 'chan', op: 'close', name: r.channel }); modal.close(); } });
    const form = body.querySelector('.access-form');
    if (form) {
      wireAccess(form);
      form.addEventListener('submit', (e) => { e.preventDefault(); const fd = new FormData(form); net.send({ t: 'chan', op: 'access', name: r.channel, access: fd.get('access'), rules: fd.get('rules') || undefined }); });
    }
    modal.sign = () => { check = null; net.send({ t: 'chan', op: 'check', room: roomId }); render(); };
    modal.signCheck = (c) => { check = c; render(); };
    modal.onclose = () => { modal.sign = null; modal.signCheck = null; };
  };
  render();
  net.send({ t: 'chan', op: 'check', room: roomId });
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
  // The map grows with the channel wing, so the minimap keeps its shape.
  const aspect = `${W} / ${H}`;
  if (mini.style.aspectRatio !== aspect) {
    mini.style.aspectRatio = aspect;
    mini.height = Math.round(mini.width * H / W);
    mini.classList.toggle('tall', H > W * 0.75);
  }
  const sx = mini.width / W, sy = mini.height / H;
  mg.clearRect(0, 0, mini.width, mini.height);
  mg.fillStyle = '#3a3430'; mg.fillRect(0, 0, mini.width, mini.height);
  mg.fillStyle = '#f5f2ec'; mg.fillRect(0, 0, 48 * sx, 32 * sy);
  const tint = { open: '#e7dcc9', room: '#d7e7d7', quiet: '#d6deee' };
  for (const z of ZONES) {
    mg.fillStyle = z.channel ? (wing.find((r) => r.id === z.id)?.access?.open === false ? '#e9d5ff' : '#ddd6fe') : z.id.startsWith('booth') && z.kind === 'room' ? '#e4d6e8' : z.gen ? '#e7e2da' : tint[z.kind];
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
        <h2>${esc(markedName(p.name, p.kind))} ${p.kind === 'agent' ? '<span class="badge">AGENT</span>' : p.kind === 'freeq' ? '<span class="badge freeq">FREEQ</span>' : ''}${roleTag(p.role)}</h2>
        ${p.role && p.kind !== 'freeq' ? `<p class="small muted" title="${esc(ROLES[p.role]?.doc || '')}">${roleBadge(p.role)} ${esc(ROLES[p.role]?.label || p.role)}${p.muted > serverNow() ? ` · 🔇 muted until ${esc(fmtTime(p.muted))}` : ''}</p>` : ''}
        ${p.handle ? `<p class="small"><a href="https://rpg.actor/${encodeURIComponent(p.handle)}" target="_blank" rel="noopener">@${esc(p.handle)}</a> on rpg.actor</p>` : '<p class="small muted">Guest, no rpg.actor character linked</p>'}
        <p><span style="color:${statusColor(p.status)}">●</span> ${esc(STATUS[p.status]?.label || p.status)}${p.note ? ` · ${esc(p.note)}` : ''}</p>
        ${desk ? `<p class="small">🪑 Desk: ${placeLink('desk', desk[0], esc(desk[0]))}${desk[1].goal ? ` · “${esc(desk[1].goal)}”` : ''}</p>` : ''}
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
          ${p.kind !== 'freeq' ? '<button class="btn ghost act-give" aria-expanded="false">🎁 Give item</button>' : ''}
        </div>
        <div class="give-pick" hidden></div>` : ''}
        ${p !== me && p.kind !== 'freeq' && can(me.role, 'people.kick') && (me.role === 'owner' || rank(p.role) < rank(me.role)) ? `<div class="row mod-row">
          <button class="btn ghost act-mute">${p.muted > serverNow() ? '🔊 Unmute' : '🔇 Mute 10 min'}</button>
          <button class="btn ghost act-lobby">🛡️ To lobby</button>
          <button class="btn ghost danger act-kick">🚪 Kick</button>
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
  const modAct = async (op, extra = {}) => { const r = await modRequest(op, { to: p.id, ...extra }); if (r.error) toast(`⚠️ ${esc(r.error)}`); else modal.close(); };
  modal.body.querySelector('.act-mute')?.addEventListener('click', () => (p.muted > serverNow() ? modAct('unmute') : modAct('mute', { minutes: 10 })));
  modal.body.querySelector('.act-lobby')?.addEventListener('click', () => modAct('move', { place: 'lobby' }));
  modal.body.querySelector('.act-kick')?.addEventListener('click', async (e) => { if (await ask(e.currentTarget, `Send ${p.name} out of the office?`, 'Kick')) modAct('kick', { reason: prompt(`Why? ${p.name} sees this (optional)`) || undefined }); });
  const give = modal.body.querySelector('.act-give'), pick = modal.body.querySelector('.give-pick');
  give?.addEventListener('click', () => {
    pick.hidden = !pick.hidden;
    give.setAttribute('aria-expanded', String(!pick.hidden));
    if (pick.hidden) return;
    pick.innerHTML = items.length
      ? `<span class="muted small">Give ${esc(p.name)}</span>${items.map((s) => `<button class="btn ghost give-item" data-id="${esc(s.id)}"><span aria-hidden="true">${esc(s.emoji)}</span> ${esc(s.name)}${s.qty > 1 ? ` <span class="muted">×${s.qty}</span>` : ''}</button>`).join('')}`
      : '<span class="muted small">You\'re not carrying anything. Grab a coffee in the Kitchen or a snack from the vending machine first.</span>';
    pick.querySelectorAll('.give-item').forEach((b) => b.addEventListener('click', () => {
      modal.close();
      // Close enough already: hand it over. Otherwise walk up and give on arrival.
      if (Math.hypot(p.x - me.x, p.y - me.y) <= GIVE_RANGE) giveTo(p.id, b.dataset.id);
      else walkTo(p.x, p.y, { giveTo: p.id, item: b.dataset.id });
    }));
  });
  modal.body.querySelector('.act-mention')?.addEventListener('click', () => {
    modal.close();
    chatIn.value = `@${(p.handle || p.name).replace(/\s+/g, '')} `;
    focusChat();
  });
}

// ---- interactions ---------------------------------------------------------------
const ownerKey = () => me.did || `${me.kind}:${me.name}`;
const ownerOnline = (owner) => [...peers.values()].some((p) => (p.did || `${p.kind}:${p.name}`) === owner);

// Is an object standing in a room yours to pick up? (The server checks again.)
function ownsObject(f) {
  if (can(me.role, 'uploads.remove')) return true;
  return f.owner?.did ? f.owner.did === me.did : !!f.owner?.guest && f.owner.guest === me.id;
}

function promptFor(f) {
  if (!f) return null;
  if (f.floorItem) { const e = floor.find((x) => x.id === f.floorItem); return e ? `Pick up ${itemLabel(e.item)}` : null; }
  if (f.desk) return desks[f.desk] ? 'Use the computer' : 'Claim this desk';
  switch (f.interact) {
    case 'whiteboard': return 'Open the whiteboard';
    case 'coffee': return 'Grab a coffee';
    case 'noticeboard': return 'Read the notice board';
    case 'plugin':
      if (f.type === 'pomodoro') { const ph = (f.uploaded ? dataOf(f) : pomo[f.zone])?.phase; return ph && ph !== 'idle' ? 'Check the focus timer' : 'Start a focus session'; }
      return f.prompt || `Use the ${f.name}`;
    case 'sign': {
      const r = wing.find((x) => x.id === f.zone);
      return r ? `${r.access?.icon || '🚪'} ${r.channel} · ${r.access?.text || 'open'}: read the sign` : null;
    }
    case 'room': {
      const { state, current, next } = roomStatus(bookings, f.zone, serverNow());
      const name = roomById(f.zone).name;
      return state === 'busy' ? `${name}: “${current.title}” until ${fmtTime(current.end)}` : state === 'soon' ? `${name}: free until ${fmtTime(next.start)}` : `${name} is free · book it`;
    }
  }
  return null;
}

// Hand a stack to someone (the profile's Give item). The server checks the
// range too; this just explains it when they wandered off meanwhile.
function giveTo(to, id) {
  const p = peers.get(to);
  if (!p) return toast('They left the office.', [], 3000);
  if (!items.some((s) => s.id === id)) return;
  if (Math.hypot(p.x - me.x, p.y - me.y) > GIVE_RANGE) return toast(`${esc(p.name)} walked off. Catch up and try again.`, [], 3000);
  net.send({ t: 'inv', op: 'give', id, to });
}

function interact(f) {
  if (!f) return;
  if (f.giveTo) return giveTo(f.giveTo, f.item);
  if (f.floorItem) return net.send({ t: 'inv', op: 'pickup', id: f.floorItem });
  if (f.desk) {
    // The desk computer works from the chair spot: step onto it first.
    if (deskAt(me.x, me.y)?.id !== f.desk) return walkTo(f.x + 0.5, f.y + 0.5, f);
    const c = desks[f.desk];
    if (!c) return openClaim(f.desk);
    if (c.owner === ownerKey()) net.send({ t: 'desk', action: 'claim', desk: f.desk, goal: c.goal });
    return openStation();
  }
  switch (f.interact) {
    case 'whiteboard': {
      // The boardroom's, or an uploaded one with a board of its own.
      const id = f.uploaded ? f.id : 'whiteboard';
      modal.wb = openEditor(modal, boardFor(id), (m) => net.send(f.uploaded ? { ...m, id } : m), { title: f.uploaded ? f.name : 'Boardroom whiteboard', where: f.uploaded ? 'It\'s drawn on the board where it stands.' : 'It\'s also drawn on the wall in the boardroom.' });
      modal.wb.id = id;
      modal.onclose = () => (modal.wb = null);
      break;
    }
    case 'coffee':
      // The machine (a plugin) pours and says so; the mug and status are ours.
      net.send({ t: 'coffee', ...(f.uploaded ? { id: f.id } : {}) }); lastCoffee = performance.now(); me.cup = true;
      if (me.status === 'available') { autoStatus = 'coffee'; setStatus('coffee'); }
      break;
    case 'noticeboard': openNotes(f); break;
    case 'room': openRoom(f.zone); break;
    case 'sign': openSign(f.zone); break;
    case 'plugin': {
      // The office's own objects and uploaded ones open the same way; one you
      // set up in a room you can pick up again.
      const obj = openObject(modal, f, (m) => net.send(m), { mine: f.uploaded && ownsObject(f), pickUp: () => net.send({ t: 'inv', op: 'pickup', id: f.id }) });
      modal.obj = obj;
      modal.onclose = () => { obj.close(); modal.obj = null; };
      break;
    }
  }
}

function openClaim(deskId) {
  modal.open(`
    <h2>Make this your desk?</h2>
    <p class="small muted">Your name goes on the desk and stays there between visits, so coworkers know where to find you. Your monitor lights up while you're in.</p>
    <label class="small"><b>Today I'm working on</b><input class="goal" maxlength="80" value="${esc(me.note || '')}" placeholder="e.g. writing the Q4 plan"></label>
    <div class="row"><button class="btn primary claim">Claim desk</button><button class="btn ghost skip">Just use the computer</button></div>`);
  const goal = modal.body.querySelector('.goal');
  goal.focus();
  const claim = () => {
    net.send({ t: 'desk', action: 'claim', desk: deskId, goal: goal.value });
    if (goal.value !== me.note) { me.note = goal.value; net.send({ t: 'status', note: goal.value }); setStatusUI(); }
    modal.close();
  };
  modal.body.querySelector('.claim').addEventListener('click', claim);
  goal.addEventListener('keydown', (e) => { if (e.key === 'Enter') claim(); });
  modal.body.querySelector('.skip').addEventListener('click', () => openStation());
}

// The notice board's panel: the lobby's, or an uploaded board's own notes.
function openNotes(f = null) {
  const up = f?.uploaded ? f : null, id = up ? up.id : 'noticeboard';
  const list = up ? dataOf(up)?.notes || [] : notes;
  const wasOpen = modal.notesOpen === id;
  const draft = wasOpen ? modal.body.querySelector('.note-text')?.value : '';
  modal.open(`
    <h2>${esc(up ? up.name : 'Notice board')}</h2>
    <p class="small muted">Leave a note for the office: wins, asks, lunch plans. Notes stay up between visits.</p>
    <div class="row"><input class="note-text" maxlength="200" placeholder="Pin a note…"><button class="btn primary pin">Pin</button></div>
    <div class="notes">${list.map((n) => `<div class="note" style="background:${n.color}">${esc(n.text)}<small>${esc(n.by)} · ${new Date(n.ts).toLocaleDateString()}</small>${n.owner === ownerKey() || can(me.role, 'notes.remove') ? `<button data-id="${n.id}" title="Remove">✕</button>` : ''}</div>`).join('') || '<p class="muted">Nothing pinned yet.</p>'}</div>`);
  modal.notesOpen = id;
  modal.onclose = () => (modal.notesOpen = false);
  const input = modal.body.querySelector('.note-text');
  input.value = draft || '';
  const pin = () => { if (input.value.trim()) { net.send({ t: 'note', op: 'add', text: input.value, ...(up ? { board: id } : {}) }); input.value = ''; } };
  modal.body.querySelector('.pin').addEventListener('click', pin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pin(); });
  modal.body.querySelectorAll('.note button').forEach((b) => b.addEventListener('click', () => net.send({ t: 'note', op: 'remove', id: b.dataset.id, ...(up ? { board: id } : {}) })));
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
// Every quarter hour of the day as "HH:MM", plus `keep` if it's off the grid.
const startTimes = (keep) => {
  const all = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);
  if (keep && !all.includes(keep)) all.push(keep), all.sort();
  return all;
};
const statusDot = (state) => `<span class="dot st-${state}"></span>`;
const canBook = () => !!me?.did;
// Carrying a skeleton key: booked doors open as you walk up (the server lets you in).
const keyed = () => holdsKey(items);
const signInHint = '<p class="small muted">Sign in with your AT Protocol handle (on the way in) to book rooms. Guests can see the schedule.</p>';

function walkInto(room) {
  if (!room) return;
  walkTo((room.x0 + room.x1 + 1) / 2, (room.y0 + room.y1 + 1) / 2);
}

// Knock on a booked room: taps someone from the meeting who's inside.
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
    ? `${statusDot(state)}🔒 “${esc(current.title)}” · ${esc(current.name)} · until ${fmtTime(current.end)}`
    : state === 'soon' ? `${statusDot(state)}Free until ${fmtTime(next.start)}` : `${statusDot(state)}Free · book this room`;
}

const draft = { room: 'board', date: '', time: '', minutes: 30, title: '', invitees: '', autoRelease: true };

function openSchedule(opts = {}) {
  Object.assign(draft, opts);
  if (!draft.date) draft.date = isoDay(serverNow());
  const render = () => {
    const now = serverNow();
    if (!draft.time) draft.time = draft.date === isoDay(now) ? hm(Math.ceil((now + 5 * MIN) / (30 * MIN)) * 30 * MIN) : '10:00';
    // 7 AM–9 PM, stretched to fit early or late bookings (and now).
    const dayStart = fromLocal(draft.date, '00:00'), dayEnd = dayStart + DAY;
    const times = bookings.filter((b) => b.end > dayStart && b.start < dayEnd).flatMap((b) => [b.start, b.end]);
    if (now > dayStart && now < dayEnd) times.push(now);
    const hourOf = (t) => (t - dayStart) / (60 * MIN);
    let h0 = Math.max(0, Math.min(7, ...times.map((t) => Math.floor(hourOf(t)))));
    let h1 = Math.min(24, Math.max(21, ...times.map((t) => Math.ceil(hourOf(t) + 0.5))));
    if ((h1 - h0) % 2) h1 < 24 ? h1++ : h0--;
    const from = dayStart + h0 * 60 * MIN, to = dayStart + h1 * 60 * MIN;
    const pct = (t) => ((Math.min(to, Math.max(from, t)) - from) / (to - from)) * 100;
    const hours = Array.from({ length: (h1 - h0) / 2 }, (_, i) => h0 + i * 2).map((h) => `<span style="left:${pct(dayStart + h * 60 * MIN)}%">${fmtHour(dayStart + h * 60 * MIN)}</span>`).join('');
    const rows = ROOMS.map((r) => {
      const st = roomStatus(bookings, r.id, now);
      const blocks = bookings.filter((b) => b.room === r.id && b.end > from && b.start < to).map((b) => `
        <div class="tl-block${b.owner === keyOf(me) ? ' mine' : ''}${b.end <= now ? ' past' : ''}" data-id="${b.id}"
          style="left:${pct(b.start)}%;width:${pct(b.end) - pct(b.start)}%"
          title="${esc(`${b.title} · ${fmtRange(b)} · ${b.name}${b.invitees?.length ? ` · with ${b.invitees.join(', ')}` : ''}`)}">${esc(b.title)}</div>`).join('');
      const nowLine = now > from && now < to ? `<div class="tl-now" style="left:${pct(now)}%"></div>` : '';
      return `<div class="tl-name">${placeLink('zone', r.id, esc(r.name))}<small>${statusDot(st.state)}${r.av ? '<span class="badge av">A/V</span>' : 'voice'} · ${r.seats} seat${r.seats > 1 ? 's' : ''}</small></div>
        <div class="tl-track" data-room="${r.id}" style="--hours:${h1 - h0}">${blocks}${nowLine}</div>`;
    }).join('');
    const mine = bookings.filter((b) => b.end > now && (b.owner === keyOf(me) || isHolder(b, me))).sort((a, b) => a.start - b.start);
    const durations = [15, 30, 45, 60, 90, 120, 180, 240];
    modal.open(`
      <div class="sched">
        <div class="sched-head"><h2>Meeting rooms</h2>
          <div class="day-nav"><button class="prev" aria-label="Previous day">‹</button><b>${esc(dayWord(fromLocal(draft.date, '12:00')))}</b><button class="next" aria-label="Next day">›</button></div></div>
        <div class="timeline"><div></div><div class="tl-hours">${hours}</div>${rows}</div>
        <p class="tiny muted">Click an empty spot to pick a time. While a booking runs, only its booker and invitees can walk in; anyone else knocks.</p>
        ${canBook() ? `<form class="book-form">
          <label>Room<select name="room">${ROOMS.map((r) => `<option value="${r.id}"${r.id === draft.room ? ' selected' : ''}>${esc(r.name)}${r.av ? ' (A/V)' : ''}</option>`).join('')}</select></label>
          <label>Day<input type="date" name="date" value="${draft.date}" min="${isoDay(now)}" max="${isoDay(now + RULES.ahead)}"></label>
          <label>Start<select name="time">${startTimes(draft.time).map((v) => `<option value="${v}"${v === draft.time ? ' selected' : ''}>${fmtClock(v)}</option>`).join('')}</select></label>
          <label>Length<select name="minutes">${durations.map((d) => `<option value="${d}"${d === +draft.minutes ? ' selected' : ''}>${d < 60 ? `${d} min` : `${d / 60} h`}</option>`).join('')}</select></label>
          <label class="wide">What's it for<input name="title" maxlength="80" value="${esc(draft.title)}" placeholder="e.g. Design review"></label>
          <label class="wide">Invite (handles, comma separated; agents by name)<input name="invitees" value="${esc(draft.invitees)}" placeholder="ada.bsky.social, StandupBot"></label>
          <div class="checks">
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
        title: draft.title, invitees: draft.invitees, autoRelease: draft.autoRelease,
      });
      draft.title = ''; draft.invitees = '';
    });
  };
  render();
}

function bookingRow(b, now) {
  const live = b.start <= now && now < b.end;
  const own = b.owner === keyOf(me);
  // Moderators can cancel or end anyone's booking.
  const mod = !own && can(me.role, 'bookings.override');
  return `<li data-id="${b.id}">${statusDot(live ? 'busy' : 'soon')}
    <span class="grow"><b>${esc(b.title)}</b><br><span class="small muted">${placeLink('zone', b.room, esc(roomById(b.room).name))} · ${dayWord(b.start)} ${fmtRange(b)}${own ? '' : ` · from ${esc(b.name)}`}</span></span>
    ${zoneAt(me.x, me.y)?.id !== b.room ? '<button data-act="go">Walk there</button>' : ''}
    ${own && live ? '<button data-act="extend">+15 min</button><button data-act="end">End now</button>' : ''}
    ${own && !live ? '<button data-act="cancel">Cancel</button>' : ''}
    ${mod ? `<button data-act="${live ? 'end' : 'cancel'}" title="As a moderator">🛡️ ${live ? 'End' : 'Cancel'}</button>` : ''}</li>`;
}

function wireBookingRows(body) {
  body.querySelectorAll('li[data-id] button').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.closest('li').dataset.id, act = btn.dataset.act;
    const b = bookings.find((x) => x.id === id);
    if (!b) return;
    if (act === 'go') { modal.close(); walkInto(roomById(b.room)); return; }
    if (act === 'cancel' && !(await ask(btn, `Cancel “${b.title}”?`, 'Cancel it'))) return;
    net.send({ t: 'book', op: act, id, minutes: 15 });
  }));
}

// A "Book now" from a door panel waiting on the office: the button says so,
// and a refusal or no answer at all shows up on the panel, not just as a toast.
const roomAsk = {
  pending: false, note: '', timer: 0,
  start() {
    this.pending = true; this.note = '';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.done('⚠️ The office didn\'t answer. Check your connection and try again.'), 10000);
  },
  done(note) {
    if (!this.pending) return;
    this.pending = false; this.note = note;
    clearTimeout(this.timer);
    modal.rooms?.();
  },
  reset() { this.pending = false; this.note = ''; clearTimeout(this.timer); },
};

// The panel by a room's door: what's on now, what's next, quick booking.
function openRoom(id) {
  roomAsk.reset();
  const room = roomById(id);
  const render = () => {
    const now = serverNow();
    const { state, current, next } = roomStatus(bookings, id, now);
    const upcoming = forRoom(bookings, id).filter((b) => b.end > now).slice(0, 6);
    const gap = next ? next.start - now : 60 * MIN;
    const quick = Math.min(30 * MIN, Math.floor(gap / (5 * MIN)) * 5 * MIN);
    const lockedOutNow = current && !isHolder(current, me) && !keyed();
    if (modal.rooms === render) modal.onclose = null; // redrawing, not closing
    modal.open(`
      <h2>${esc(room.name)} ${room.av ? '<span class="badge av">A/V</span>' : ''}</h2>
      <p class="small muted">${room.seats} seat${room.seats > 1 ? 's' : ''} · ${room.av ? 'voice, video and screen share for everyone inside' : 'private voice'}</p>
      <div class="room-now ${state}">${statusDot(state)}<div>${state === 'busy'
        ? `<b>In use 🔒:</b> “${esc(current.title)}” · ${esc(current.name)} · until ${fmtTime(current.end)}`
        : state === 'soon' ? `<b>Free</b> until ${fmtTime(next.start)} (“${esc(next.title)}”)` : '<b>Free</b>'}</div></div>
      <div class="row">
        ${!current && canBook() && quick >= RULES.minLen ? `<button class="btn primary quick" ${roomAsk.pending ? 'disabled' : ''}>${roomAsk.pending ? 'Booking…' : `Book now · ${quick / MIN} min`}</button>` : ''}
        ${canBook() ? '<button class="btn ghost later">Book a time…</button>' : ''}
        ${lockedOutNow ? '<button class="btn knock">🚪 Knock</button>' : ''}
        ${zoneAt(me.x, me.y)?.id !== id && !lockedOutNow ? `<button class="btn ghost go">${current && !isHolder(current, me) ? '🗝️ Let yourself in' : 'Walk in'}</button>` : ''}
      </div>
      ${roomAsk.note ? `<p class="small room-note">${roomAsk.note}</p>` : ''}
      ${canBook() ? '' : signInHint}
      <h3 style="margin-top:16px">Coming up</h3>
      <ul class="room-day">${upcoming.map((b) => bookingRow(b, now)).join('') || '<li class="muted">Nothing booked.</li>'}</ul>`);
    modal.rooms = render;
    modal.onclose = () => { modal.rooms = null; roomAsk.reset(); };
    const body = modal.body;
    body.querySelector('.quick')?.addEventListener('click', () => {
      if (net.closed) { roomAsk.note = '⚠️ You\'re out of the office. Reload to come back and book.'; return render(); }
      roomAsk.start();
      net.send({ t: 'book', op: 'create', ref: 'new', room: id, start: now, end: now + quick, title: `${me.name}'s meeting` });
      render();
    });
    body.querySelector('.later')?.addEventListener('click', () => openSchedule({ room: id }));
    body.querySelector('.knock')?.addEventListener('click', () => { knock(id); modal.close(); });
    body.querySelector('.go')?.addEventListener('click', () => { modal.close(); walkInto(room); });
    wireBookingRows(body);
  };
  render();
}
$('.rooms-btn').addEventListener('click', () => openSchedule());
$('.gallery-btn').addEventListener('click', () => showGallery());

// ---- server roles: badges, the 🛡️ moderation panel (admin.js) ---------------------
const modBtn = $('.mod-btn');
const modWait = new Map();
let modRef = 0;
modBtn.addEventListener('click', () => showAdmin());
function modRequest(op, fields) {
  const ref = `m${++modRef}`;
  return new Promise((resolve) => {
    modWait.set(ref, resolve);
    net.send({ t: 'mod', op, ref, ...fields });
    setTimeout(() => { if (modWait.delete(ref)) resolve({ error: 'The office didn\'t answer. Try again?' }); }, 15000);
  });
}
function showAdmin() {
  if (!me || !can(me.role, 'roles.view')) return;
  openAdmin(modal, { me, request: modRequest, toast, fmtTime, zoneName: (id) => ZONES.find((z) => z.id === id)?.name || '' });
}
// My role or mute changed: the panel button, and a muted mic goes off.
function roleChanged() {
  modBtn.hidden = !can(me.role, 'roles.view');
  if (me.muted > serverNow() && voice.on && !voice.listening) {
    voice.disable();
    net.send({ t: 'audio', on: false });
    me.audio = false;
    setMicState(false);
    micPopSync();
  }
}

// Uploaded objects: list, remove, upload (gallery.js). Requests go over the
// socket and come back as { t: 'galleryres', rid, result }.
function galleryRequest(op, req) {
  const rid = ++galleryRid;
  return new Promise((resolve) => {
    galleryWait.set(rid, resolve);
    net.send({ t: 'gallery', op, rid, req });
    setTimeout(() => { if (galleryWait.delete(rid)) resolve({ error: 'The office didn\'t answer. Try again?' }); }, 20000);
  });
}
function showGallery() {
  if (!me) return;
  openGallery(modal, { me, items: gallery, request: galleryRequest, toast, walkTo, place: (id) => startPlacing(items.find((s) => s.id === id)), moderator: can(me.role, 'uploads.remove') });
}

// ---- A/V rooms: camera, screen share and the video stage -----------------------------
const camBtn = $('.cam'), shareBtn = $('.share');
camBtn.addEventListener('click', toggleCam);
shareBtn.addEventListener('click', toggleShare);

async function ensureVoice() {
  if (voice.on && !voice.listening) return true;
  if (!(await voice.enable({ silent: true }))) return false;
  net.send({ t: 'audio', on: true });
  me.audio = true;
  setMicState(true);
  micPopSync();
  return true;
}
// A freeq-bridged channel room where you can be on its call (signed in, join hasn't failed).
const fqRoom = (z) => !!(z && !z.av && z.channel && freeqRooms[z.id] && me?.did && fqCall.usable(z.id));
// Camera and screen share belong to A/V rooms and freeq channel rooms' calls.
function syncAvButtons() {
  const z = me && zoneAt(me.x, me.y);
  camBtn.hidden = shareBtn.hidden = !(z?.av || fqCall.joined || fqRoom(z));
  if (!z?.av) {
    camBtn.classList.toggle('on', fqCall.camWanted);
    shareBtn.classList.toggle('on', fqCall.screen);
  }
}
async function toggleCam() {
  // On a freeq call the camera goes out on our freeq broadcast instead. Before
  // we're on it, turning the camera on also turns voice on, which joins the call.
  const z = zoneAt(me.x, me.y);
  if (!z?.av && (fqCall.joined || fqRoom(z))) {
    const on = !fqCall.camWanted;
    await fqCall.setCam(on);
    if (on && !fqCall.joined && !(await ensureVoice())) { await fqCall.setCam(false); toast('🎙️ The freeq call needs your mic. Allow it in your browser to join with your camera.'); }
    return;
  }
  if (voice.cam) return voice.stopCam();
  await ensureVoice();
  if (!(await voice.startCam())) toast('📷 Camera permission was blocked. Allow it in your browser to turn it on.');
}
async function toggleShare() {
  // On a freeq call the screen goes out as its own freeq broadcast.
  const z = zoneAt(me.x, me.y);
  if (!z?.av && fqCall.joined) {
    if (!(await fqCall.setScreen(!fqCall.screen))) toast('🖥️ Screen sharing isn\'t available in this browser.');
    return;
  }
  if (!z?.av && fqRoom(z)) {
    if (await ensureVoice()) toast('📞 Joining the freeq call. Press share again once you\'re on it.', [], 4000);
    return;
  }
  if (voice.screen) return voice.stopScreen();
  await ensureVoice();
  if (!(await voice.startScreen())) toast('🖥️ Screen sharing was cancelled or blocked.');
}

let sentAv = { video: false, screen: false };
function mediaChanged(ended) {
  camBtn.classList.toggle('on', !!voice.cam);
  shareBtn.classList.toggle('on', !!voice.screen);
  sendAv();
  if (ended) toast('🖥️ You stopped sharing your screen.', [], 3000);
  updateStage();
}
// Tell the office when our camera or screen is on, on WebRTC or a freeq call (📹 by your name).
function sendAv() {
  const now = { video: !!voice.cam || fqCall.cam, screen: !!voice.screen || fqCall.screen };
  if (me && (now.video !== sentAv.video || now.screen !== sentAv.screen)) {
    sentAv = now;
    me.video = now.video; me.screen = now.screen;
    net.send({ t: 'av', ...now });
  }
}

const stage = $('.av-stage');
// A freeq-bridged channel room's voice is the channel's freeq call (freeq-av.js).
const fqCall = createFreeqCall({
  send: (m) => net.send(m), stage, toast,
  onChange: () => { syncAvButtons(); sendAv(); updateStage(); },
});
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
  // Screens people put up on their desk monitors, for whoever is close by.
  for (const p of deskSharers()) {
    const r = voice.remote(p.id);
    if (r.screen && !want.some((w) => w.key === `${p.id}:screen`)) want.push({ key: `${p.id}:screen`, stream: r.screen, name: `${p.name}'s desk screen`, kind: 'screen', id: p.id });
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
  stage.hidden = !want.length && !fqCall.tiles;
}

// A screen being shared in my room also plays on the room's wall screen.
function screenFeed(z) {
  if (!z?.av) return null;
  for (const [k2, el] of tiles) if (k2.endsWith(':screen')) return { zone: z.id, video: el.querySelector('video') };
  return null;
}

// ---- the desk computer ---------------------------------------------------------------
// public/js/workstation.js draws it; the World and your Workstation entity keep it.
const deskOf = (p) => (p ? deskAt(p.x, p.y)?.id || null : null);
const atDesk = () => !!deskOf(me);
const myScreen = Object.assign(document.createElement('video'), { muted: true, autoplay: true, playsInline: true });
const station = createWorkstation({
  send: (m) => net.send(m),
  office: {
    me: () => me, bookings: () => bookings, serverNow, toast,
    deskId: () => deskOf(me),
    openSchedule: () => openSchedule(),
    closeStation: () => station.close(),
    share: {
      on: () => !!voice.screen,
      stream: () => voice.screen,
      async toggle() {
        if (voice.screen) return voice.stopScreen();
        await ensureVoice();
        if (!(await voice.startScreen())) toast('🖥️ Screen sharing was cancelled or blocked.');
        else if (!zoneAt(me.x, me.y)?.av) toast('🖥️ Your screen is on your desk monitor. People close by with audio on can watch.', [], 5000);
      },
    },
  },
});
// Your things, on the desk computer too: the same panel, in a window.
registerApp({
  id: 'inventory', name: 'Things', icon: '🎒', size: [460, 420],
  mount(body) {
    const inv = openInventory({ body, open() {}, close() {} }, invCtx);
    let seen = [items, floor];
    return { tick() { if (seen[0] !== items || seen[1] !== floor) { seen = [items, floor]; inv.refresh(); } else inv.tick(); } };
  },
});

function openStation() {
  if (!atDesk()) return toast('Walk up to a desk to use its computer.');
  modal.close();
  station.open();
}
// People sharing a screen to their desk monitor, within a few steps of me.
function deskSharers() {
  if (!me) return [];
  return [...peers.values()].filter((p) => p !== me && p.screen && deskOf(p) && !zoneAt(p.x, p.y)?.av && Math.hypot(p.x - me.x, p.y - me.y) <= DESK_VIEW);
}
// Walking up to a shared desk screen without audio on: say how to watch.
const deskHinted = new Set();
function deskWatch(others, t) {
  if (t - (deskWatch.t || 0) < 1000) return;
  deskWatch.t = t;
  if (voice.on) return;
  for (const p of deskSharers()) {
    if (deskHinted.has(p.id)) continue;
    deskHinted.add(p.id);
    toast(`🖥️ <b>${esc(p.name)}</b> is sharing their screen on their desk monitor.`, [['Watch (turns audio on)', ensureVoice]], 8000);
  }
}
// What each desk's monitor shows: its computer on, and a live screen if I can see one.
function deskUse(others) {
  const out = {};
  if (myScreen.srcObject !== (voice.screen || null)) { myScreen.srcObject = voice.screen || null; myScreen.play().catch(() => {}); }
  for (const p of others) {
    const d = deskOf(p);
    if (!d) continue;
    const video = p === me ? (voice.screen ? myScreen : null) : p.screen ? tiles.get(`${p.id}:screen`)?.querySelector('video') || null : null;
    out[d] = { pc: p === me ? station.isOpen : !!p.pc, video, color: colorFor(p.did || `${p.kind}:${p.name}`) };
  }
  return out;
}

// ---- input ----------------------------------------------------------------------
const keys = new Set();
const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
addEventListener('keydown', (e) => {
  if (!me || station.isOpen) return;
  if (modal.isOpen) { if (e.key === 'Escape') modal.close(); return; }
  if (typing()) return;
  if (placing && e.key === 'Escape') { stopPlacing(); e.preventDefault(); return; }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) { keys.add(key); e.preventDefault(); }
  else if (key === 'e' || key === ' ') { interact(currentTarget()); e.preventDefault(); }
  else if (key === 'i') openInv();
  else if (key === 'Enter') { focusChat(); e.preventDefault(); }
  else if (key === '\\') setSide(hud.classList.contains('side-closed'));
  else if (key === 'm') e.shiftKey ? toggleMute() : toggleMic();
  else if (key === 'n') toggleMusic();
  else if (key === 'b') openSchedule();
  else if (key === 'u') showGallery();
  else if (key === 'g' && can(me.role, 'roles.view')) showAdmin();
  else if (key === 'c' && !camBtn.hidden) toggleCam();
  else if (key === '+' || key === '=') zoom(1);
  else if (key === '-') zoom(-1);
  else if (key === '0') zoomToFit();
  else if (key === '?') openHelp();
  else if (/^[1-9]$/.test(key) && emoteList[+key - 1]) emote(emoteList[+key - 1]);
});
addEventListener('keyup', (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
addEventListener('blur', () => keys.clear());

function tapAt(sx, sy, touch = false) {
  const c = canvas.getBoundingClientRect();
  sx -= c.left; sy -= c.top;
  if (placing) return placeAt(R.toWorld(sx, sy));
  const h = hitAt(sx, sy, touch);
  if (h.peer) return openProfile(h.peer);
  // Something on the floor: walk over and pick it up.
  if (h.item) return walkTo(h.item.x, h.item.y, { floorItem: h.item.id, x: h.item.x, y: h.item.y, w: 0, h: 0 });
  // Clicking a piece of furniture walks to it and uses it on arrival.
  walkTo(h.w.x, h.w.y, h.f);
}
// What's under a point on the map (canvas pixels): a person, a floor item or usable furniture.
function hitAt(sx, sy, touch = false) {
  const peer = R.hitPeer(sx, sy, [...peers.values()], touch ? 40 : 28);
  const w = R.toWorld(sx, sy);
  if (peer) return { peer, w };
  const item = nearestFloorItem(floor, w.x, w.y + 0.2, touch ? 0.7 : 0.5);
  if (item) return { item, w };
  const f = FURNITURE.find((f2) => (f2.interact || f2.desk) && w.x >= f2.x - 0.1 && w.x <= f2.x + f2.w + 0.1 && w.y >= f2.y - 1 && w.y <= f2.y + f2.h + 0.1);
  return { f, w };
}

// Mouse hover: a pointer (and a faint outline) over anything clicking would
// use, not-allowed over things in a room that's booked and locked to you.
let hover = null;
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !me) return;
  const c = canvas.getBoundingClientRect();
  const h = placing ? {} : hitAt(e.clientX - c.left, e.clientY - c.top);
  hover = h.f || null;
  let cursor = '';
  if (h.peer || h.item) cursor = 'pointer';
  else if (h.f) {
    const z = zoneAt(h.f.x + h.f.w / 2, h.f.y + h.f.h / 2);
    const locked = z?.bookable && z !== zoneAt(me.x, me.y) && !keyed() && lockedOut(bookings, z.id, me, serverNow());
    cursor = locked ? 'not-allowed' : 'pointer';
    if (locked) hover = null;
  }
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
});
canvas.addEventListener('pointerleave', () => { hover = null; canvas.style.cursor = ''; });

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
    gesture = { kind: 'pinch', d: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId) || !gesture) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.kind === 'pinch') {
    if (touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
    const r = canvas.getBoundingClientRect();
    zoomAt(d / gesture.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    gesture.d = d;
    return;
  }
  if (gesture.id !== e.pointerId) return;
  const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0, d = Math.hypot(dx, dy);
  if (gesture.kind === 'tap' && d > 14) {
    gesture.kind = 'stick';
    path = null; walkTarget = null; pendingUse = null; follow = null;
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
  if (thenUse?.floorItem && Math.hypot(x - me.x, y - me.y) <= 1.2) return interact(thenUse);
  const tx = thenUse?.desk ? thenUse.x + 0.5 : x, ty = thenUse?.desk ? thenUse.y + 0.5 : y;
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
  const now = serverNow();
  // A booked room you're not part of is a wall, doorway included, for every
  // part of you; if you're already in there you can still walk out.
  const here = restrictedAt(bookings, me.x, me.y, me, now);
  for (const [cx, cy] of [[x - RAD, y - RAD * 0.6], [x + RAD, y - RAD * 0.6], [x - RAD, y + RAD * 0.6], [x + RAD, y + RAD * 0.6]]) {
    if (isBlocked(Math.floor(cx), Math.floor(cy))) return false;
    const shut = restrictedAt(bookings, cx, cy, me, now);
    if (shut && shut !== here && !keyed()) { bumped(shut); return false; }
  }
  return true;
}

// Walking into a booked room's door stops you there and puts up its sign.
function bumped(room) {
  doorSign.bump = { room: room.id, at: performance.now() };
  if (path) { path = null; walkTarget = null; pendingUse = null; }
}

// The "Restricted" sign: pops up over a booked room's door when someone who
// isn't in the meeting comes close or bumps into it, with a Knock button.
const doorSign = { el: document.createElement('div'), key: '', bump: null };
doorSign.el.className = 'door-sign';
doorSign.el.hidden = true;
$('#hud').append(doorSign.el);
doorSign.el.addEventListener('click', (e) => { if (e.target.closest('.knock')) knock(doorSign.el.dataset.room); });
function updateDoorSign(t) {
  const now = serverNow();
  let best = null;
  if (!keyed() && !restrictedAt(bookings, me.x, me.y, me, now)) {
    for (const r of ROOMS) {
      if (!lockedOut(bookings, r.id, me, now)) continue;
      const bumpedHere = doorSign.bump?.room === r.id && t - doorSign.bump.at < 3000;
      for (const d of doorTiles(r)) {
        const dist = Math.hypot(d.x + 0.5 - me.x, d.y + 0.5 - me.y);
        if ((dist < 2.2 || bumpedHere) && (!best || dist < best.dist)) best = { r, d, dist };
      }
    }
  }
  if (!best) { doorSign.el.hidden = true; doorSign.key = ''; return; }
  const b = activeBooking(bookings, best.r.id, now);
  const key = `${best.r.id}:${b.id}:${b.end}`;
  if (key !== doorSign.key) {
    doorSign.key = key;
    doorSign.el.dataset.room = best.r.id;
    doorSign.el.innerHTML = `<b>🔒 Restricted</b><span>${esc(best.r.name)} is booked by ${esc(b.name)} until ${fmtTime(b.end)}</span><span class="muted">“${esc(b.title)}”</span><button type="button" class="knock">🚪 Knock</button>`;
  }
  const c = canvas.getBoundingClientRect();
  const s = R.toScreen(best.d.x + 0.5, best.d.y - 0.6);
  doorSign.el.hidden = false;
  doorSign.el.style.transform = `translate(${Math.round(c.left + s.x)}px, ${Math.round(c.top + s.y)}px) translate(-50%, -100%)`;
}

let lastSent = 0, sentMoving = false, lastSentPos = { x: 0, y: 0 };
let steered = null; // { moving } while another of your tabs is the one walking you
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
      // Stop a tile short of them. Already next to them leaves nothing to walk,
      // and an empty path would block every later repath.
      if (p && p.length > 2) { path = p.slice(1, -1); walkTarget = null; }
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
  if (moving) steered = null;
  else if (steered) { me.moving = steered.moving; me.rx = me.x; me.ry = me.y; return; }
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
  // A channel room says who may walk in (its door's policy), not "private".
  const wr = z?.channel && wing.find((r) => r.id === z.id);
  const access = z?.channel && (wr?.access || { icon: '🚪', text: 'open', open: true });
  // A room named after its freeq channel needn't say the name twice.
  const sameName = fq && fq.channel.toLowerCase() === z.name.toLowerCase();
  const topicEl = $('.zone-topic'), topic = fq?.topic || wr?.topic || '';
  topicEl.textContent = topic; topicEl.title = topic; topicEl.hidden = !topic;
  kind.textContent = fq ? (sameName ? 'freeq' : fq.channel) : access ? (access.open ? 'open' : access.text) : z ? { open: 'open', room: 'private', quiet: 'quiet' }[z.kind] : 'open';
  kind.className = `zone-kind ${fq ? 'freeq' : access ? (access.open ? 'open' : 'gated') : z?.kind || 'open'}`;
  scope.textContent = fq ? fq.channel : z && z.kind !== 'open' ? z.name : 'nearby';
  scope.className = `scope ${fq ? 'freeq' : z?.kind || 'open'}`;
  if (replyTo) showReply();
  if (freeqOnly) return;
  if (fq) toast(`💬 ${sameName ? `<b>${esc(z.name)}</b> is bridged to freeq` : `${esc(z.name)} is attached to <b>${esc(fq.channel)}</b> on freeq`}${fq.topic ? ` (${esc(fq.topic)})` : ''}. ${me.did ? 'What you say here goes there as you.' : 'Sign in to talk there as yourself; for now you can listen.'}`, [], 6000);
  // Meeting rooms put you in a meeting; channel rooms are just somewhere to talk.
  const meeting = z?.kind === 'room' && !z.channel;
  if (meeting && me.status === 'available') { autoStatus = 'meeting'; setStatus('meeting'); }
  else if (autoStatus === 'meeting' && !meeting) { autoStatus = null; setStatus('available'); }
  if (z?.kind === 'quiet') toast('🤫 Deep Work Den: voice is off in here. Press E at the tomato clock to start a shared focus session.', [], 5000);
  // Camera and screen share belong to A/V rooms (and freeq calls); they stop at the door.
  syncAvButtons();
  if (!z?.av && voice.cam) voice.stopCam();
  if (!z?.av && voice.screen && !atDesk()) voice.stopScreen();
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
const promptEl = $('.prompt'), promptText = promptEl.querySelector('span'), promptKbd = promptEl.querySelector('kbd');
// The interaction prompt doubles as a button, which is how touch screens press E.
promptEl.querySelector('kbd').textContent = coarse ? 'Tap' : 'E';
promptEl.addEventListener('click', () => { if (placing) stopPlacing(); else if (me && !modal.isOpen) interact(currentTarget()); });
// While placing, the mouse shows where it would land.
canvas.addEventListener('pointermove', (e) => {
  if (!placing || e.pointerType !== 'mouse') return;
  const c = canvas.getBoundingClientRect(), w = R.toWorld(e.clientX - c.left, e.clientY - c.top);
  placing.hover = { x: Math.floor(w.x), y: Math.floor(w.y) };
});
canvas.addEventListener('pointerleave', () => { if (placing) placing.hover = null; });
// Redrawing the whole vector office is the page's main cost (mostly raster,
// not script), so it only runs at full rate while something moves. Idle, the
// ambient touches (plants swaying, blinking) tick at ~8 fps, and at ~4 fps
// (30 fps while moving) when the window isn't focused.
let lastDraw = 0;
// Someone else counts as moving only while their moves keep arriving: a
// "moving" flag left over from someone who dropped mid-step would otherwise
// keep the office at full frame rate forever.
const stirring = (p) => p !== me && (Math.abs(p.x - p.rx) + Math.abs(p.y - p.ry) > 0.01 || (p.moving && performance.now() - (p.track?.at(-1)?.t || 0) < 600));
const busy = () => me.moving || gesture || stick || Math.abs(me.x + camOff.x - cam.x) + Math.abs(me.y - 0.5 + camOff.y - cam.y) > 0.01
  || [...peers.values()].some(stirring);
function frameGap() {
  if (!me) return 0;
  const focused = document.hasFocus();
  if (busy()) return focused ? 0 : 30;
  return focused ? 125 : 250;
}
// Idle waits sleep on a timer rather than spinning on requestAnimationFrame,
// which alone keeps Chrome producing frames 60 times a second.
let sleeper = 0;
function nextFrame(wait) {
  if (wait > 12) sleeper = setTimeout(() => { sleeper = 0; requestAnimationFrame(loop); }, wait - 8);
  else requestAnimationFrame(loop);
}
// Input shows up on the next frame, not the next idle tick; starting from
// idle, walking counts from the key press rather than the last idle frame.
const wake = () => {
  if (me && lastDraw && !busy()) last = performance.now();
  lastDraw = 0;
  if (sleeper) { clearTimeout(sleeper); sleeper = 0; requestAnimationFrame(loop); }
};
for (const ev of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'resize', 'focus']) addEventListener(ev, wake, { capture: true, passive: true });
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
  const gap = frameGap();
  if (t - lastDraw < gap - 20) { nextFrame(gap - (t - lastDraw)); return; }
  lastDraw = t;
  modal.inv?.tick();
  // Walk in steps of at most 50 ms so a slow frame rate doesn't slow you down
  // (or tunnel you through walls); a stall over a quarter second is dropped.
  const dt = Math.min(0.25, (t - last) / 1000); last = t;
  if (me) {
    for (let left = dt; left > 1e-4; left -= 0.05) stepMe(Math.min(0.05, left));
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
    // A screen put up on a desk monitor stops when you walk away; so does the computer.
    if (!atDesk()) {
      if (voice.screen && !z?.av) voice.stopScreen();
      if (station.isOpen) station.close();
    }
    // In an A/V room you're on the call listen-only even without voice on,
    // so screen shares and cameras reach you; it ends at the door.
    if (z?.av && !voice.on) voice.listen();
    else if (!z?.av && voice.listening) voice.disable();
    // In a room bridged to freeq, voice is that channel's freeq call for
    // signed-in people; everyone else (and any failed join) stays on WebRTC.
    const fqZone = z?.channel && freeqRooms[z.id] && fqCall.usable(z.id) ? z.id : null;
    fqCall.want(fqZone, !!(fqZone && me.did && voice.on && !voice.listening));
    fqCall.setMuted(voice.muted);
    fqCall.setDeaf(deaf);
    const v = voice.update(me, others, deaf, { deskScreen: atDesk() && !z?.av, skip: fqCall.onCall });
    deskWatch(others, t);
    me.speaking = v.meSpeaking;
    if (voice.on || meterShown > 0 || hintOn) paintMeter(t, !!v.mutedTalking);
    for (const p of others) if (p !== me) p.speaking = v.speaking.has(p.id);

    if (me.moving) { const f = Math.exp(-dt * 2.5); camOff.x *= f; camOff.y *= f; }
    cam.x += (me.x + camOff.x - cam.x) * Math.min(1, dt * 6);
    cam.y += (me.y - 0.5 + camOff.y - cam.y) * Math.min(1, dt * 6);

    const target = modal.isOpen || placing ? null : currentTarget();
    const label = placing ? `Placing ${itemLabel(placing.item)} · ${coarse ? 'tap here to stop' : 'Esc to stop'}` : target && promptFor(target);
    promptEl.hidden = !label;
    if (label && promptText.textContent !== label) promptText.textContent = label;
    const kbd = placing ? (coarse ? '✕' : 'Esc') : coarse ? 'Tap' : 'E';
    if (promptKbd.textContent !== kbd) promptKbd.textContent = kbd;
    let place = null;
    if (placing) {
      if (!items.some((i) => i.id === placing.id)) stopPlacing();
      else {
        const tiles = placingTiles(), h = placing.hover && tiles.get(`${placing.hover.x},${placing.hover.y}`);
        place = { tiles: [...tiles.values()].filter((x) => x.ok), hover: placing.hover && { ...placing.hover, ok: !!h?.ok }, emoji: placing.item.emoji };
        canvas.style.cursor = placing.hover ? (h?.ok ? 'copy' : 'not-allowed') : '';
      }
    }

    if (z?.id === 'focus' && den && den.phase !== 'idle') {
      const left = Math.max(0, den.endsAt - serverNow());
      pomoHud.hidden = false;
      pomoHud.textContent = `${den.phase === 'focus' ? '🍅 Focus' : '🌿 Break'} ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    } else pomoHud.hidden = true;
    updateMusic();
    if (t - roomHudT > 500) { roomHudT = t; updateRoomHud(z); updateStage(); }

    R.draw({
      cam, k, time: t, clock: clockNow(), meId: me.id, peers: others,
      desks, notes, pomo, counters, serverNow, ownerOnline, wbCanvas: board.canvas, boards,
      target: target?.floorItem ? null : target, floorTarget: target?.floorItem || null, floor, place, walkTarget, lastCoffee, bookings, screenFeed: screenFeed(z), freeq: freeqRooms, objects, deskUse: deskUse(others), wing,
      hover, promptSize: label ? { w: promptEl.offsetWidth, h: promptEl.offsetHeight } : null, promptTarget: label ? target : null,
    });
    // First frame with you (and your sprite) on it: lift the boot screen.
    if (spritesReady && !bootEl.hidden) bootDone();
    // The prompt rides on the object it's about; without a spot it waits at the bottom of the map.
    const at = label && R.promptAt;
    promptEl.classList.toggle('anchored', !!at);
    if (at) {
      const c = canvas.getBoundingClientRect();
      promptEl.style.transform = `translate(${Math.round(c.left + at.x)}px, ${Math.round(c.top + at.y)}px)`;
      promptEl.style.setProperty('--tail', `${Math.round(at.tail)}px`);
    } else promptEl.style.transform = '';
    updateDoorSign(t);
    if (!doorSign.el.hidden) promptEl.hidden = true;
    if (t - miniT > 150) { miniT = t; drawMinimap(); }
  }
  nextFrame(frameGap());
}

// Debug/test hook.
window.__office = { R, station, openStation, get me() { return me; }, music, cam, send: (m) => net.send(m), voice, peers, get desks() { return desks; }, get bookings() { return bookings; }, walkTo, interact, openSchedule, openRoom, FURNITURE, DESKS };
