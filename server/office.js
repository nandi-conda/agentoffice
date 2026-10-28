// The office hub: presence, proximity chat, desks, pomodoro, whiteboard,
// notice board, arcade scores, meeting room bookings and WebRTC signalling relay.

import { SPAWN, DESKS, SEATS, zoneAt, canHear, isBlocked, ZONES } from '../public/js/map.js';
import { MIN, RULES, roomById, checkSlot, toTime, parseInvitees, isHolder, lockedOut, activeBooking, keyOf, fmtTime, fmtRange } from '../public/js/rooms.js';

const POMO_ZONES = ZONES.filter((z) => z.kind === 'quiet').map((z) => z.id);
const STATUSES = new Set(['available', 'focus', 'meeting', 'away', 'coffee']);
const MAX_STROKES = 3000;
const MAX_NOTES = 40;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, d = lo) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

export class Office {
  constructor(saved = {}, { onChange = () => {}, loadActor = null, now = () => Date.now() } = {}) {
    this.peers = new Map();
    this.onChange = onChange;
    this.loadActor = loadActor;
    this.now = now;
    this.desks = saved.desks || {};
    this.strokes = saved.strokes || [];
    this.notes = saved.notes || [];
    this.scores = saved.scores || [];
    this.counters = { coffees: 0, pomodoros: 0, waves: 0, ...(saved.counters || {}) };
    this.pomo = {};
    for (const z of POMO_ZONES) this.pomo[z] = { phase: 'idle', endsAt: 0, round: 0, focusMin: 25, breakMin: 5 };
    this.shouts = [];
    this.bookings = saved.bookings || [];
    this.lastTick = 0;
  }

  persisted() {
    return { desks: this.desks, strokes: this.strokes, notes: this.notes, scores: this.scores, counters: this.counters, bookings: this.bookings };
  }

  summary() {
    return {
      online: [...this.peers.values()].filter((p) => p.ready).map((p) => this.publicPeer(p)),
      desks: this.desks,
      counters: this.counters,
      bookings: this.bookings,
    };
  }

  publicPeer(p) {
    return {
      id: p.id, name: p.name, handle: p.handle, did: p.did, kind: p.kind,
      actor: p.actor, x: p.x, y: p.y, dir: p.dir, moving: p.moving,
      status: p.status, note: p.note, seat: p.seat, emote: p.emote, audio: p.audio,
      video: p.video, screen: p.screen, cup: p.cup, joinedAt: p.joinedAt,
    };
  }

  // Transport-neutral entry points: open() a peer for a socket, feed it
  // message() and close(). connect() wires them to a Node `ws` socket; the
  // Cloudflare Durable Object calls them from its hibernation handlers.
  // `did` is only ever a DID the visitor proved via OAuth (see auth.js).
  open(ws, { did = null, restored = null } = {}) {
    const p = {
      id: crypto.randomUUID().slice(0, 8), ready: false, name: 'guest', handle: null, did: null, authDid: did,
      kind: 'human', actor: null, x: SPAWN.x, y: SPAWN.y, dir: 0, moving: false,
      status: 'available', note: '', seat: null, emote: null, audio: false, video: false, screen: false, cup: false,
      chatTimes: [], joinedAt: this.now(),
      ...restored, ws,
    };
    this.peers.set(p.id, p);
    return p;
  }

  message(p, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return Promise.resolve(); }
    if (!msg || typeof msg.t !== 'string') return Promise.resolve();
    return Promise.resolve(this.handle(p, msg)).catch((e) => this.sendTo(p, { t: 'error', message: e.message }));
  }

  // The parts of a peer worth keeping across a Durable Object hibernation.
  snapshot(p) {
    const { ws, cupTimer, ...rest } = p;
    return rest;
  }

  connect(ws, { did = null } = {}) {
    const p = this.open(ws, { did });
    ws.on('message', (raw) => this.message(p, raw));
    ws.on('close', () => this.leave(p));
    ws.on('error', () => this.leave(p));
    return p;
  }

  sendTo(p, msg) {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, except = null) {
    const s = JSON.stringify(msg);
    for (const q of this.peers.values()) if (q.ready && q !== except && q.ws.readyState === 1) q.ws.send(s);
  }

  leave(p) {
    if (!this.peers.has(p.id)) return;
    this.peers.delete(p.id);
    if (p.ready) this.broadcast({ t: 'leave', id: p.id });
    if (p.kind !== 'freeq') { this.freeq?.leave(p); this.freeq?.presence(); }
  }

  // ---- people from outside (the freeq bridge, see freeq.js) ----------------
  // They have no socket: they're drawn, can be heard and mentioned, and never
  // send anything themselves.
  addRemote(fields) {
    const p = this.open({ readyState: 3, send() {} }, { restored: { ...fields } });
    p.ready = true;
    this.broadcast({ t: 'join', peer: this.publicPeer(p) });
    return p;
  }

  removeRemote(p) { this.leave(p); }

  moveRemote(p, x, y) {
    p.x = x; p.y = y; p.moving = false; p.seat = null;
    this.broadcast({ t: 'move', id: p.id, x, y, dir: p.dir, moving: false, seat: null });
  }

  noteRemote(p, note) {
    p.note = clip(note, 80);
    this.broadcast({ t: 'peer', id: p.id, note: p.note });
  }

  renameRemote(p, name) {
    p.name = clip(name, 32);
    this.broadcast({ t: 'leave', id: p.id });
    this.broadcast({ t: 'join', peer: this.publicPeer(p) });
  }

  // freeq accounts are AT Protocol DIDs, so they can wear their rpg.actor character too.
  async identifyRemote(p, did) {
    p.did = did;
    if (!this.loadActor) return;
    try {
      const a = await this.loadActor(did);
      if (!this.peers.has(p.id)) return;
      p.handle = a.handle;
      p.actor = { sprite: a.sprite, stats: a.stats, displayName: a.displayName, description: a.description };
      this.broadcast({ t: 'leave', id: p.id });
      this.broadcast({ t: 'join', peer: this.publicPeer(p) });
    } catch { /* no character: keep the default look */ }
  }

  // A line from a freeq channel, heard by everyone in the area it's attached to.
  remoteChat({ zoneId, channel, peer, name, text }) {
    const msg = { t: 'chat', id: peer?.id || `freeq:${name}`, name: clip(name, 32), text: clip(text, 500), ts: this.now(), scope: channel, freeq: true };
    const mentioned = new Set([...msg.text.matchAll(/@([\w.-]+)/g)].map((x) => x[1].toLowerCase()));
    for (const q of this.peers.values()) {
      if (!q.ready || q.kind === 'freeq') continue;
      const hit = zoneAt(q.x, q.y)?.id === zoneId;
      const ment = mentioned.has(q.name.toLowerCase().replace(/\s+/g, '')) || (q.handle && mentioned.has(q.handle.toLowerCase()));
      if (hit || ment) this.sendTo(q, { ...msg, mention: !hit && !!ment });
    }
  }

  ownerKey(p) { return p.did || `${p.kind}:${p.name}`; }

  async handle(p, m) {
    if (m.t === 'hello') return this.hello(p, m);
    if (!p.ready) return;
    // Room timers also run from setInterval / a Durable Object alarm; this
    // catches up whenever anyone is active.
    if (this.now() - this.lastTick > 5000) this.tickRooms();
    switch (m.t) {
      case 'move': return this.move(p, m);
      case 'chat': return this.chat(p, m);
      case 'status': return this.setStatus(p, m);
      case 'emote': return this.emote(p, m);
      case 'sit': return this.sit(p, m);
      case 'desk': return this.desk(p, m);
      case 'pomo': return this.pomodoro(p, m);
      case 'wb': return this.whiteboard(p, m);
      case 'note': return this.noticeboard(p, m);
      case 'coffee': return this.coffee(p);
      case 'score': return this.score(p, m);
      case 'wave': return this.wave(p, m);
      case 'audio': p.audio = !!m.on; return this.broadcast({ t: 'peer', id: p.id, audio: p.audio });
      case 'av': return this.av(p, m);
      case 'book': return this.book(p, m);
      case 'rtc': return this.rtc(p, m);
      case 'ping': return this.sendTo(p, { t: 'pong', ts: m.ts });
    }
  }

  async hello(p, m) {
    if (p.ready) return;
    p.kind = m.kind === 'agent' ? 'agent' : 'human';
    p.name = clip(m.name, 32) || (p.kind === 'agent' ? 'agent' : 'guest');
    if (p.authDid) {
      // Identity comes from the signed-in DID only, never from the hello
      // message, so nobody can walk in wearing someone else's handle.
      p.did = p.authDid;
      if (this.loadActor) {
        try {
          const a = await this.loadActor(p.authDid);
          p.handle = a.handle;
          p.actor = { sprite: a.sprite, stats: a.stats, displayName: a.displayName, description: a.description };
          p.name = clip(m.name, 32) || a.displayName || a.handle || p.name;
        } catch (e) {
          this.sendTo(p, { t: 'error', message: `couldn't load your character: ${e.message}` });
        }
      }
    } else if (m.handle) {
      this.sendTo(p, { t: 'error', message: `sign in to use @${clip(m.handle, 253)}; walking in as a guest` });
    }
    if (m.status && STATUSES.has(m.status)) p.status = m.status;
    p.note = clip(m.note, 80);
    p.ready = true;
    this.sendTo(p, {
      t: 'welcome', id: p.id, now: this.now(), you: this.publicPeer(p),
      peers: [...this.peers.values()].filter((q) => q.ready && q !== p).map((q) => this.publicPeer(q)),
      desks: this.desks, strokes: this.strokes, notes: this.notes, pomo: this.pomoState(),
      scores: this.scores.slice(0, 10), counters: this.counters, shouts: this.shouts.slice(-20),
      bookings: this.bookings, freeq: this.freeq?.state() || {},
    });
    this.broadcast({ t: 'join', peer: this.publicPeer(p) }, p);
    this.touchDesk(p);
    this.freeq?.presence();
  }

  move(p, m) {
    const x = num(m.x, 0, 48, p.x), y = num(m.y, 0, 32, p.y);
    if (isBlocked(Math.floor(x), Math.floor(y)) && !p.seat) return;
    // Guard against teleport hacks beyond a generous per-message step.
    if (Math.hypot(x - p.x, y - p.y) > 6 && !m.teleport) return;
    // A locked booking keeps everyone but its holders out of the room.
    const to = zoneAt(x, y);
    if (to?.bookable && to !== zoneAt(p.x, p.y) && lockedOut(this.bookings, to.id, p, this.now())) {
      const b = activeBooking(this.bookings, to.id, this.now());
      return this.sendTo(p, { t: 'bounce', x: p.x, y: p.y, room: to.id, text: `🔒 ${to.name} is booked for “${b.title}” until ${fmtTime(b.end)}. Knock to be let in.` });
    }
    if (to?.bookable && to !== zoneAt(p.x, p.y)) {
      const b = activeBooking(this.bookings, to.id, this.now());
      if (b && !b.seen && isHolder(b, p)) { b.seen = true; this.onChange(); }
    }
    p.x = x; p.y = y; p.dir = num(m.dir, 0, 3, 0) | 0; p.moving = !!m.moving;
    if (p.seat && m.moving) p.seat = null;
    this.broadcast({ t: 'move', id: p.id, x, y, dir: p.dir, moving: p.moving, seat: p.seat }, p);
  }

  chat(p, m) {
    const text = clip(m.text, 500);
    if (!text) return;
    const t = this.now();
    p.chatTimes = p.chatTimes.filter((ts) => t - ts < 5000);
    if (p.chatTimes.length >= 6) return this.sendTo(p, { t: 'error', message: 'slow down a little' });
    p.chatTimes.push(t);
    const shout = text.startsWith('/shout ');
    const msg = { t: 'chat', id: p.id, name: p.name, text: shout ? text.slice(7) : text, ts: t };
    if (shout) {
      msg.scope = 'office';
      this.shouts.push(msg);
      if (this.shouts.length > 50) this.shouts.shift();
      return this.broadcast(msg);
    }
    const zone = zoneAt(p.x, p.y);
    msg.scope = zone && zone.kind !== 'open' ? zone.name : 'nearby';
    // An area attached to a freeq channel is one conversation: the whole
    // area hears it, and it goes to the channel as the speaker.
    const bridged = zone && this.freeq?.bindings.get(zone.id);
    if (bridged) {
      msg.scope = bridged.channel;
      this.freeq.relay(p, zone.id, msg.text).then((note) => {
        if (note && note !== p.freeqNote) this.sendTo(p, { t: 'toast', text: note });
        p.freeqNote = note;
      });
    }
    const hears = (q) => (bridged ? zoneAt(q.x, q.y) === zone : canHear(p, q));
    // Mentions reach the person anywhere, which is how you tap someone on
    // the shoulder across the office (and how agents get asked things).
    const mentioned = new Set([...text.matchAll(/@([\w.-]+)/g)].map((x) => x[1].toLowerCase()));
    for (const q of this.peers.values()) {
      if (!q.ready) continue;
      const hit = q === p || hears(q);
      const ment = mentioned.has(q.name.toLowerCase().replace(/\s+/g, '')) || (q.handle && mentioned.has(q.handle.toLowerCase()));
      if (hit || ment) this.sendTo(q, { ...msg, mention: !hit && ment });
    }
  }

  setStatus(p, m) {
    if (m.status && STATUSES.has(m.status)) p.status = m.status;
    if (m.note !== undefined) p.note = clip(m.note, 80);
    this.broadcast({ t: 'peer', id: p.id, status: p.status, note: p.note });
  }

  emote(p, m) {
    p.emote = m.name ? clip(m.name, 24) : null;
    this.broadcast({ t: 'peer', id: p.id, emote: p.emote });
  }

  sit(p, m) {
    if (m.seat === null) {
      p.seat = null;
      return this.broadcast({ t: 'peer', id: p.id, seat: null });
    }
    const seat = SEATS.find((s) => s.id === m.seat);
    if (!seat || Math.hypot(seat.x - p.x, seat.y - p.y) > 2.5) return;
    for (const q of this.peers.values()) if (q.seat === seat.id && q !== p) return this.sendTo(p, { t: 'error', message: 'someone is sitting there' });
    p.seat = seat.id; p.x = seat.x; p.y = seat.y;
    p.dir = { down: 0, left: 1, right: 2, up: 3 }[seat.facing] ?? 0;
    p.moving = false;
    this.broadcast({ t: 'move', id: p.id, x: p.x, y: p.y, dir: p.dir, moving: false, seat: p.seat });
  }

  desk(p, m) {
    const d = DESKS.find((x) => x.id === m.desk);
    if (!d) return;
    const key = this.ownerKey(p);
    const cur = this.desks[d.id];
    if (m.action === 'claim') {
      const stale = cur && this.now() - (cur.seen || 0) > 12 * 3600 * 1000;
      const ownerOnline = cur && [...this.peers.values()].some((q) => q.ready && this.ownerKey(q) === cur.owner);
      if (cur && cur.owner !== key && (ownerOnline || !stale)) {
        return this.sendTo(p, { t: 'error', message: `${cur.name}'s desk` });
      }
      for (const [id, v] of Object.entries(this.desks)) if (v.owner === key && id !== d.id) delete this.desks[id];
      this.desks[d.id] = { owner: key, name: p.name, handle: p.handle, goal: clip(m.goal, 80), since: cur?.owner === key ? cur.since : this.now(), seen: this.now() };
    } else if (m.action === 'goal' && cur?.owner === key) {
      cur.goal = clip(m.goal, 80);
    } else if (m.action === 'release' && cur?.owner === key) {
      delete this.desks[d.id];
    } else return;
    this.onChange();
    this.broadcast({ t: 'desks', desks: this.desks });
  }

  touchDesk(p) {
    const key = this.ownerKey(p);
    for (const v of Object.values(this.desks)) if (v.owner === key) { v.seen = this.now(); this.onChange(); }
  }

  pomoState() {
    const out = {};
    for (const [k, v] of Object.entries(this.pomo)) { const { timer, ...rest } = v; out[k] = rest; }
    return out;
  }

  pomodoro(p, m) {
    const zone = zoneAt(p.x, p.y);
    const st = zone && this.pomo[zone.id];
    if (!st) return;
    if (m.action === 'start') {
      st.focusMin = num(m.focusMin, 1, 90, 25) | 0;
      st.breakMin = num(m.breakMin, 1, 30, 5) | 0;
      st.round = 1; st.startedBy = p.name;
      this.setPhase(zone.id, 'focus');
    } else if (m.action === 'stop') {
      clearTimeout(st.timer);
      st.phase = 'idle'; st.endsAt = 0; st.round = 0;
      this.broadcastPomo();
    }
  }

  setPhase(zoneId, phase) {
    const st = this.pomo[zoneId];
    clearTimeout(st.timer);
    st.phase = phase;
    const mins = phase === 'focus' ? st.focusMin : st.breakMin;
    st.endsAt = this.now() + mins * 60000;
    st.timer = setTimeout(() => {
      if (phase === 'focus') {
        this.counters.pomodoros++;
        this.onChange();
        this.setPhase(zoneId, 'break');
      } else {
        st.round++;
        this.setPhase(zoneId, 'focus');
      }
    }, mins * 60000);
    st.timer.unref?.();
    this.broadcastPomo();
  }

  broadcastPomo() {
    this.broadcast({ t: 'pomo', pomo: this.pomoState(), counters: this.counters, now: this.now() });
  }

  whiteboard(p, m) {
    if (m.op === 'clear') {
      this.strokes = [];
    } else if (m.op === 'stroke' && Array.isArray(m.points) && m.points.length >= 2) {
      const points = m.points.slice(0, 400).map((pt) => [num(pt[0], 0, 1), num(pt[1], 0, 1)]);
      const color = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#1f2937';
      const stroke = { points, color, size: num(m.size, 1, 24, 3), by: p.name };
      this.strokes.push(stroke);
      if (this.strokes.length > MAX_STROKES) this.strokes.shift();
      this.broadcast({ t: 'wb', op: 'stroke', stroke }, p);
      return this.onChange();
    } else return;
    this.onChange();
    this.broadcast({ t: 'wb', op: 'clear' });
  }

  noticeboard(p, m) {
    if (m.op === 'add') {
      const text = clip(m.text, 200);
      if (!text) return;
      const colors = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#ddd6fe'];
      this.notes.unshift({ id: crypto.randomUUID().slice(0, 8), text, by: p.name, owner: this.ownerKey(p), ts: this.now(), color: colors[(Math.random() * colors.length) | 0] });
      this.notes = this.notes.slice(0, MAX_NOTES);
    } else if (m.op === 'remove') {
      const n = this.notes.find((x) => x.id === m.id);
      if (!n || n.owner !== this.ownerKey(p)) return;
      this.notes = this.notes.filter((x) => x !== n);
    } else return;
    this.onChange();
    this.broadcast({ t: 'notes', notes: this.notes });
  }

  coffee(p) {
    p.cup = true;
    clearTimeout(p.cupTimer);
    p.cupTimer = setTimeout(() => { p.cup = false; this.broadcast({ t: 'peer', id: p.id, cup: false }); }, 5 * 60000);
    p.cupTimer.unref?.();
    this.counters.coffees++;
    this.onChange();
    this.broadcast({ t: 'peer', id: p.id, cup: true });
    this.broadcast({ t: 'counters', counters: this.counters });
    // Tell anyone nearby that a coffee chat is brewing.
    for (const q of this.peers.values()) {
      if (q !== p && q.ready && canHear(p, q)) this.sendTo(q, { t: 'toast', text: `☕ ${p.name} grabbed a coffee nearby. Coffee chat?` });
    }
  }

  score(p, m) {
    const score = num(m.score, 0, 10000, 0) | 0;
    if (!score) return;
    this.scores.push({ name: p.name, score, ts: this.now() });
    this.scores.sort((a, b) => b.score - a.score);
    this.scores = this.scores.slice(0, 20);
    this.onChange();
    this.broadcast({ t: 'scores', scores: this.scores.slice(0, 10) });
  }

  wave(p, m) {
    const q = this.peers.get(m.to);
    if (!q || !q.ready) return;
    this.counters.waves++;
    this.sendTo(q, { t: 'wave', from: p.id, name: p.name, kind: m.kind === 'knock' ? 'knock' : 'wave' });
    this.broadcast({ t: 'peer', id: p.id, emote: 'wave' });
  }

  rtc(p, m) {
    const q = this.peers.get(m.to);
    if (!q || !q.ready) return;
    this.sendTo(q, { t: 'rtc', from: p.id, data: m.data });
  }

  // ---- A/V rooms ----------------------------------------------------------
  // Camera and screen share flags. The media itself is peer to peer; these
  // just let everyone draw who's on camera. Only meaningful in an A/V room.
  av(p, m) {
    const ok = !!zoneAt(p.x, p.y)?.av;
    p.video = ok && !!m.video;
    p.screen = ok && !!m.screen;
    this.broadcast({ t: 'peer', id: p.id, video: p.video, screen: p.screen });
  }

  // ---- meeting room bookings -------------------------------------------------
  // { t: 'book', op: 'create' | 'cancel' | 'extend' | 'end' | 'update' | 'admit', ref? }
  // Replies { t: 'booked', ref, booking } or { t: 'error', ref, message }.
  book(p, m) {
    const now = this.now();
    const ref = typeof m.ref === 'string' || typeof m.ref === 'number' ? m.ref : undefined;
    const fail = (message) => this.sendTo(p, { t: 'error', message, ref });
    const done = (b) => { this.roomsChanged(); this.sendTo(p, { t: 'booked', ref, booking: b }); };
    const key = this.ownerKey(p);

    if (m.op === 'create') {
      if (!p.did && p.kind !== 'agent') return fail('sign in to book a room');
      const room = roomById(m.room);
      if (!room) return fail('no such room');
      const start = m.start === undefined || m.start === 'now' ? now : toTime(m.start, now);
      const end = m.end !== undefined ? toTime(m.end, now) : start + num(m.minutes, 15, 240, 30) * MIN;
      const slot = checkSlot(this.bookings, { room: room.id, start, end, owner: key }, now);
      if (slot.error) return fail(slot.error);
      const b = {
        id: crypto.randomUUID().slice(0, 8), room: room.id, title: clip(m.title, 80) || `${p.name}'s meeting`,
        start: slot.start, end: slot.end, owner: key, name: p.name, handle: p.handle,
        invitees: parseInvitees(m.invitees), lock: !!m.lock, autoRelease: m.autoRelease !== false,
        seen: false, admitted: [], sent: {}, created: now,
      };
      this.bookings.push(b);
      this.bookings.sort((a, c) => a.start - c.start);
      done(b);
      for (const q of this.peers.values()) {
        if (q !== p && q.ready && isHolder(b, q)) this.note(q, b, 'invite', `📅 ${p.name} invited you to “${b.title}” in ${room.name}, ${fmtRange(b)}`);
      }
      return this.tickRooms();
    }

    const b = this.bookings.find((x) => x.id === m.id);
    if (!b) return fail('no such booking');
    const room = roomById(b.room);
    if (m.op === 'admit') {
      // Anyone already holding the room can let a knocker in.
      if (!isHolder(b, p) || !(b.start <= now && now < b.end)) return fail('only people in the meeting can let others in');
      const q = this.peers.get(m.to);
      if (!q?.ready) return fail('they left');
      if (!b.admitted.includes(keyOf(q))) b.admitted.push(keyOf(q));
      this.note(q, b, 'admit', `🔓 ${p.name} let you into ${room.name}`);
      return done(b);
    }
    if (b.owner !== key) return fail('only the person who booked it can change it');
    if (m.op === 'cancel' || (m.op === 'end' && b.start > now)) {
      this.bookings = this.bookings.filter((x) => x !== b);
      for (const q of this.peers.values()) {
        if (q !== p && q.ready && isHolder(b, q) && b.end > now) this.note(q, b, 'cancel', `📅 “${b.title}” in ${room.name} was cancelled`);
      }
      return done({ ...b, cancelled: true });
    }
    if (m.op === 'end') {
      b.end = Math.max(b.start, now);
      b.sent.ended = true;
      return done(b);
    }
    if (m.op === 'extend') {
      const slot = checkSlot(this.bookings, { room: b.room, start: b.start, end: b.end + num(m.minutes, 5, 120, 15) * MIN, owner: key, id: b.id }, now);
      if (slot.error) return fail(slot.error);
      b.end = slot.end;
      b.sent.ending = false;
      return done(b);
    }
    if (m.op === 'update') {
      if (m.title !== undefined) b.title = clip(m.title, 80) || b.title;
      if (m.invitees !== undefined) b.invitees = parseInvitees(m.invitees);
      if (m.lock !== undefined) b.lock = !!m.lock;
      if (m.start !== undefined || m.end !== undefined) {
        const start = m.start !== undefined ? toTime(m.start, now) : b.start;
        const end = m.end !== undefined ? toTime(m.end, now) : start + (b.end - b.start);
        const slot = checkSlot(this.bookings, { room: b.room, start, end, owner: key, id: b.id }, now);
        if (slot.error) return fail(slot.error);
        Object.assign(b, { start: slot.start, end: slot.end, sent: {} });
        this.bookings.sort((a, c) => a.start - c.start);
      }
      return done(b);
    }
    fail('unknown booking op');
  }

  note(q, b, kind, text) {
    this.sendTo(q, { t: 'roomnote', kind, room: b.room, id: b.id, text });
  }

  roomsChanged() {
    this.onChange();
    this.broadcast({ t: 'bookings', bookings: this.bookings });
  }

  // Reminders, start/end announcements, locking people out, and releasing
  // rooms nobody turned up to. Safe to call as often as you like.
  tickRooms() {
    const now = this.now();
    this.lastTick = now;
    let changed = false;
    const here = (id) => [...this.peers.values()].filter((q) => q.ready && zoneAt(q.x, q.y)?.id === id);
    for (const b of [...this.bookings]) {
      const room = roomById(b.room);
      const sent = (b.sent ||= {});
      const inside = here(b.room);
      if (b.end <= now) {
        if (!sent.ended) {
          sent.ended = true; changed = true;
          for (const q of inside) this.note(q, b, 'ended', `📅 “${b.title}” has ended. ${room.name} is free unless it's booked next.`);
        }
        continue;
      }
      if (!sent.soon && b.start > now && b.start - now <= RULES.remind) {
        sent.soon = true; changed = true;
        for (const q of this.peers.values()) {
          if (q.ready && isHolder(b, q) && !inside.includes(q)) this.note(q, b, 'soon', `📅 “${b.title}” in ${room.name} starts at ${fmtTime(b.start)}`);
        }
      }
      if (b.start > now) continue;
      if (!b.seen && inside.some((q) => isHolder(b, q))) { b.seen = true; changed = true; }
      if (!sent.start) {
        sent.start = true; changed = true;
        for (const q of this.peers.values()) {
          if (!q.ready) continue;
          if (isHolder(b, q)) {
            if (!inside.includes(q)) this.note(q, b, 'start', `📅 “${b.title}” in ${room.name} is starting now`);
          } else if (inside.includes(q)) {
            if (b.lock) this.showOut(q, room, `🔒 ${room.name} is booked now for “${b.title}” (${b.name}), so you've been shown out.`);
            else this.note(q, b, 'taken', `📅 ${room.name} is booked now for “${b.title}” (${b.name}) until ${fmtTime(b.end)}`);
          }
        }
      }
      if (b.autoRelease && !b.seen && now - b.start >= RULES.grace) {
        this.bookings = this.bookings.filter((x) => x !== b);
        changed = true;
        for (const q of this.peers.values()) {
          if (q.ready && keyOf(q) === b.owner) this.note(q, b, 'released', `📅 Nobody turned up to “${b.title}”, so ${room.name} was released`);
        }
        continue;
      }
      if (!sent.ending && b.end - now <= RULES.remind) {
        sent.ending = true; changed = true;
        const next = this.bookings.find((x) => x.room === b.room && x.start >= b.end && x.start - b.end < RULES.soon);
        for (const q of inside) this.note(q, b, 'ending', `⏳ ${Math.ceil((b.end - now) / MIN)} minutes left in ${room.name}${next ? `. Next up: “${next.title}” (${next.name})` : ''}`);
      }
    }
    // Keep a day of history so "earlier today" still shows on the schedule.
    const keep = this.bookings.filter((b) => now - b.end < 24 * 60 * MIN);
    if (keep.length !== this.bookings.length) { this.bookings = keep; changed = true; }
    if (changed) this.roomsChanged();
  }

  // When tickRooms next has something to do, for a Durable Object alarm.
  nextRoomEvent() {
    const now = this.now();
    let t = Infinity;
    for (const b of this.bookings) {
      const s = b.sent || {};
      for (const [due, when] of [[!s.soon, b.start - RULES.remind], [!s.start, b.start], [b.autoRelease && !b.seen, b.start + RULES.grace], [!s.ending, b.end - RULES.remind], [!s.ended, b.end], [true, b.end + 24 * 60 * MIN]]) {
        if (due && when > now && when < t) t = when;
      }
      if (b.start <= now && now < b.end && !b.seen) t = Math.min(t, now + 30000);
    }
    return Number.isFinite(t) ? t : null;
  }

  showOut(q, room, text) {
    q.x = room.door.x; q.y = room.door.y; q.seat = null; q.moving = false;
    q.video = false; q.screen = false;
    this.sendTo(q, { t: 'bounce', x: q.x, y: q.y, room: room.id, text });
    this.broadcast({ t: 'move', id: q.id, x: q.x, y: q.y, dir: q.dir, moving: false, seat: null }, q);
    this.broadcast({ t: 'peer', id: q.id, video: false, screen: false });
  }
}
