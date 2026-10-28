import { W, H, ZONES, FURNITURE, DESKS, SEATS, SPAWN, isBlocked, zoneAt, canHear, findPath, nearestInteractable } from './map.js';
import { createRenderer, EMOJI } from './render.js';
import { sheetsFor, generateSheet } from './sprites.js';
import { tracedFrame, drawTraced } from './trace.js';
import { STATUS, statusColor, colorFor } from './style.js';
import { connect } from './net.js';
import { createVoice } from './rtc.js';
import { createBoard, openEditor } from './whiteboard.js';
import { openSnake } from './snake.js';

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
let desks = {}, notes = [], pomo = {}, counters = {}, scores = [];
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

const canvas = $('#world');
const R = createRenderer(canvas);
R.resize();
addEventListener('resize', () => { R.resize(); clampZoom(); });

function clampZoom() {
  const levels = R.zoomLevels();
  if (k === null || !levels.includes(k)) k = levels[Math.min(levels.length - 1, Math.max(0, Math.floor(levels.length / 2)))];
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
        : `<b>${esc(a.displayName || a.handle)}</b><br>No rpg.actor sprite yet, so you'll get a generated one. <a href="https://rpg.actor/generator" target="_blank" rel="noopener">Make one</a>`;
    } catch (e) {
      text.textContent = `Couldn't load @${handle}: ${e.message}. You can still walk in as a guest.`;
    }
  } else {
    text.innerHTML = 'Enter a handle to load your <a href="https://rpg.actor" target="_blank" rel="noopener">rpg.actor</a> character, sprite, emotes and stats.';
  }
  if (!sheets) sheets = { base: generateSheet(nameIn.value || 'guest'), frame: 48 };
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

function enter() {
  const handle = handleIn.value.trim().replace(/^@/, '');
  const name = nameIn.value.trim() || loginActor?.displayName || handle || `guest-${Math.random().toString(36).slice(2, 6)}`;
  store.set('handle', handle); store.set('name', nameIn.value.trim()); store.set('note', noteIn.value.trim());
  $('#login').hidden = true;
  $('#hud').hidden = false;
  start({ name, handle: handle || null, note: noteIn.value.trim() });
}

// ---- networking -------------------------------------------------------------
const voice = createVoice({ send: (m) => net.send(m), myId: () => me?.id || '' });

function start(hello) {
  net = connect(onMessage, () => net.send({ t: 'hello', ...hello, status: me?.status }), () => sys('Connection lost, reconnecting…'));
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
      desks = m.desks; notes = m.notes; pomo = m.pomo; counters = m.counters; scores = m.scores;
      board.set(m.strokes);
      for (const s of m.shouts || []) logChat(s);
      setStatusUI();
      refreshPeople();
      if (!welcomeShown) { welcomeShown = true; sys(`Welcome in, ${me.name}. Walk with WASD or click the floor. Press ? for help.`); }
      break;
    }
    case 'join': addPeer(m.peer).then(() => sys(`${m.peer.name} walked in`)); break;
    case 'leave': {
      const p = peers.get(m.id);
      if (p) { sys(`${p.name} left`); peers.delete(m.id); if (follow === m.id) follow = null; refreshPeople(); }
      break;
    }
    case 'move': {
      const p = peers.get(m.id);
      if (!p || p === me) break;
      p.x = m.x; p.y = m.y; p.dir = m.dir; p.moving = m.moving; p.seat = m.seat;
      if (Math.hypot(p.rx - p.x, p.ry - p.y) > 5) { p.rx = p.x; p.ry = p.y; }
      break;
    }
    case 'peer': {
      const p = peers.get(m.id);
      if (!p) break;
      for (const key of ['status', 'note', 'emote', 'audio', 'cup', 'seat']) if (key in m) p[key] = m[key];
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
        toast(`<b>${esc(m.name)}</b> mentioned you: ${esc(m.text)}`, [['Walk over', () => walkTo(p?.x, p?.y)]]);
      }
      break;
    }
    case 'desks': desks = m.desks; refreshPeople(); break;
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
      toast(`${m.kind === 'knock' ? '🚪' : '👋'} <b>${esc(m.name)}</b> ${m.kind === 'knock' ? 'is knocking' : 'waved at you'}`, p ? [['Walk over', () => walkTo(p.x, p.y)], ['Wave back', () => net.send({ t: 'wave', to: p.id })]] : []);
      break;
    }
    case 'toast': toast(esc(m.text)); break;
    case 'rtc': voice.onSignal(m.from, m.data); break;
    case 'error': toast(`⚠️ ${esc(m.message)}`); break;
  }
}
let welcomeShown = false;

// ---- chat -------------------------------------------------------------------
const log = $('.chat-log');
function logChat(m) {
  const d = document.createElement('div');
  d.className = `m ${m.scope === 'office' ? 'office' : ''} ${m.mention ? 'mention' : ''}`;
  const scope = m.scope === 'nearby' ? '' : `<span class="sc">${esc(m.scope === 'office' ? '📣 office' : m.scope)}</span>`;
  d.innerHTML = `${scope}<b style="color:${colorFor(m.id)}">${esc(m.name)}</b> ${linkify(esc(m.text))}`;
  pushLog(d);
}
function sys(text) {
  const d = document.createElement('div');
  d.className = 'm sys'; d.textContent = text;
  pushLog(d);
}
function pushLog(d) {
  log.append(d);
  while (log.children.length > 120) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}
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

// ---- toolbar ----------------------------------------------------------------
const statusSel = $('.status-select');
statusSel.innerHTML = Object.entries(STATUS).map(([k, v]) => `<option value="${k}">● ${v.label}</option>`).join('');
statusSel.addEventListener('change', () => { autoStatus = null; setStatus(statusSel.value); });
const noteBox = $('.note-input');
noteBox.addEventListener('change', () => {
  net.send({ t: 'status', note: noteBox.value });
  store.set('note', noteBox.value);
  const mine = Object.entries(desks).find(([, v]) => v.owner === ownerKey());
  if (mine) net.send({ t: 'desk', action: 'goal', desk: mine[0], goal: noteBox.value });
});
noteBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') noteBox.blur(); });

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
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });

const FALLBACK_EMOTES = ['wave', 'happy', 'love', 'clap', 'idea', 'party', 'thumbs', 'coffee', 'focus'];
let emoteList = FALLBACK_EMOTES;
function buildEmotes() {
  const own = Object.keys(me.sheets?.emotes || {});
  // rpg.actor emotes first (they animate the character), then a wave.
  emoteList = own.length ? ['wave', ...own].slice(0, 9) : FALLBACK_EMOTES;
  const box = $('.emotes');
  box.innerHTML = emoteList.map((e, i) => `<button title="${e} (${i + 1})" data-e="${e}">${EMOJI[e] || '✨'}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => emote(b.dataset.e)));
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
      <kbd>WASD</kbd><span>Walk (or click anywhere on the floor)</span>
      <kbd>E</kbd><span>Interact: sit, claim a desk, whiteboard, coffee, pomodoro, arcade</span>
      <kbd>Enter</kbd><span>Chat with people who can hear you</span>
      <kbd>1-9</kbd><span>Emotes. With an rpg.actor sprite these swap in your own emote sheets</span>
      <kbd>M</kbd><span>Proximity voice: on → muted → off</span>
      <kbd>V</kbd><span>Toggle traced-vector characters / original pixels</span>
      <kbd>+ −</kbd><span>Zoom</span>
    </div>
    <h3 style="margin-top:16px">Who hears you</h3>
    <p class="small">In open areas, anyone within a few steps. In the <b>Boardroom</b>, <b>Huddle Room</b> and <b>Phone Booths</b>, only people in the same room. The <b>Deep Work Den</b> is text-only and runs a shared pomodoro. Start a message with <code>/shout</code> to reach the whole office, or <code>@name</code> to tap someone anywhere.</p>
    <h3>Agents</h3>
    <p class="small">AI agents can work here too. They connect over the same WebSocket protocol, claim desks and answer @mentions. See <code>scripts/agent.mjs</code>.</p>`);
}

// ---- people list & minimap ---------------------------------------------------
let peopleTimer = null;
function refreshPeople() {
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(() => {
    const list = [...peers.values()].sort((a, b) => (a === me ? -1 : b === me ? 1 : a.name.localeCompare(b.name)));
    $('.people .count').textContent = list.length;
    $('.people-list').innerHTML = list.map((p) => {
      const z = zoneAt(p.x, p.y);
      const sub = [p.note, z?.name].filter(Boolean).join(' · ');
      return `<li data-id="${p.id}"><span class="dot" style="background:${statusColor(p.status)}"></span><span class="who"><b>${esc(p.name)}${p === me ? ' (you)' : ''} ${p.kind === 'agent' ? '<span class="badge">AGENT</span>' : ''}</b><span>${esc(sub)}</span></span>${p.audio ? '🎙️' : ''}</li>`;
    }).join('');
    $('.people-list').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => openProfile(peers.get(li.dataset.id))));
  }, 120);
}
setInterval(refreshPeople, 5000);

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
        ${p.actor?.description ? `<p class="small muted">${esc(p.actor.description)}</p>` : ''}
        ${systems ? `<p class="small"><b>Character sheets:</b> ${systems}</p><div class="stats">${stats.join('')}</div>` : ''}
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
  else if (key === 'v') toggleVector();
  else if (key === '+' || key === '=') zoom(1);
  else if (key === '-') zoom(-1);
  else if (key === '?') openHelp();
  else if (/^[1-9]$/.test(key) && emoteList[+key - 1]) emote(emoteList[+key - 1]);
});
addEventListener('keyup', (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
addEventListener('blur', () => keys.clear());

canvas.addEventListener('pointerdown', (e) => {
  if (!me) return;
  document.activeElement?.blur?.();
  const hit = R.hitPeer(e.clientX, e.clientY, [...peers.values()]);
  if (hit) return openProfile(hit);
  const w = R.toWorld(e.clientX, e.clientY);
  // Clicking a piece of furniture walks to it and uses it on arrival.
  const f = FURNITURE.find((f2) => (f2.interact || f2.seat) && w.x >= f2.x - 0.1 && w.x <= f2.x + f2.w + 0.1 && w.y >= f2.y - 1 && w.y <= f2.y + f2.h + 0.1);
  walkTo(w.x, w.y, f);
});

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
const SPEED = 4.4, RAD = 0.26;
function free(x, y) {
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
  if (vx || vy) { path = null; walkTarget = null; pendingUse = null; follow = null; }

  if (follow && !path) {
    const t = peers.get(follow);
    if (t && Math.hypot(t.x - me.x, t.y - me.y) > 1.6 && (!stepMe.lastFollow || performance.now() - stepMe.lastFollow > 700)) {
      stepMe.lastFollow = performance.now();
      const p = findPath(me.x, me.y, t.x, t.y);
      if (p) { path = p.slice(1, -1); walkTarget = null; }
    }
  }
  if (path && path.length) {
    const t = path[0];
    const dx = t.x - me.x, dy = t.y - me.y, d = Math.hypot(dx, dy);
    if (d < 0.08) path.shift();
    else { vx = dx / d; vy = dy / d; }
    if (!path.length) {
      path = null; walkTarget = null;
      if (pendingUse) { const f = pendingUse; pendingUse = null; interact(f); }
    }
  }
  const moving = !!(vx || vy);
  if (moving && me.seat) { me.seat = null; net.send({ t: 'sit', seat: null }); }
  if (moving) {
    const len = Math.hypot(vx, vy);
    const nx = me.x + (vx / len) * SPEED * dt, ny = me.y + (vy / len) * SPEED * dt;
    if (free(nx, me.y)) me.x = nx;
    if (free(me.x, ny)) me.y = ny;
    me.dir = Math.abs(vx) > Math.abs(vy) ? (vx < 0 ? 1 : 2) : vy < 0 ? 3 : 0;
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

// ---- auto status -------------------------------------------------------------------
let lastZone = null;
function zoneChanged(z) {
  const kind = $('.zone-kind'), scope = $('.chat-form .scope');
  $('.zone-name').textContent = z ? z.name : 'Hallway';
  kind.textContent = z ? { open: 'open', room: 'private', quiet: 'quiet' }[z.kind] : 'open';
  kind.className = `zone-kind ${z?.kind || 'open'}`;
  scope.textContent = z && z.kind !== 'open' ? z.name : 'nearby';
  scope.className = `scope ${z?.kind || 'open'}`;
  if (z?.kind === 'room' && me.status === 'available') { autoStatus = 'meeting'; setStatus('meeting'); }
  else if (autoStatus === 'meeting' && z?.kind !== 'room') { autoStatus = null; setStatus('available'); }
  if (z?.kind === 'quiet') toast('🤫 Deep Work Den: voice is off in here. Press E at the tomato clock to start a shared focus session.', [], 5000);
}

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
const pomoHud = $('.pomo-hud');

function loop(t) {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  if (me) {
    stepMe(dt);
    for (const p of peers.values()) {
      if (p === me) continue;
      const a = Math.min(1, dt * 12);
      p.rx += (p.x - p.rx) * a; p.ry += (p.y - p.ry) * a;
    }
    const z = zoneAt(me.x, me.y);
    if (z !== lastZone) { lastZone = z; zoneChanged(z); }

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

    R.draw({
      cam, k, time: t, clock: clockNow(), meId: me.id, peers: others,
      desks, notes, pomo, counters, serverNow, ownerOnline, wbCanvas: board.canvas,
      target, walkTarget, lastCoffee, vector,
    });
    if (t - miniT > 150) { miniT = t; drawMinimap(); }
  }
  requestAnimationFrame(loop);
}

// Debug/test hook.
window.__office = { get me() { return me; }, send: (m) => net.send(m), voice, peers, get desks() { return desks; }, walkTo, interact, FURNITURE, DESKS };
