// Bridge to freeq (https://freeq.at), an IRC network whose accounts are AT
// Protocol identities. Populated freeq channels are attached to open areas of
// the office: the channel's people stand in that area, what they say shows up
// as chat there, and what signed-in office people say there goes to the
// channel as themselves.
//
// Two kinds of IRC connection, both over wss://irc.freeq.at/irc (one IRC line
// per WebSocket text frame) and both signed in with SASL ATPROTO-CHALLENGE:
//  - the listener: the office's own did:key (an ed25519 key kept in storage),
//    method "crypto". It sits in every attached channel and reads.
//  - one per signed-in person who talks: method "pds-oauth", i.e. the access
//    token from their office sign-in plus a DPoP proof for their PDS's
//    getSession, which freeq forwards to the PDS to check who they are.
//
// Runtime-neutral like the rest of server/: Web Crypto, fetch, and a
// WebSocket-like object from `openSocket(url)` (Node's global WebSocket, or a
// fetch upgrade inside the Durable Object).

import { ZONES, isBlocked } from '../public/js/map.js';

export const FREEQ_URL = 'wss://irc.freeq.at/irc';
// Open areas a channel can be attached to, in the order they fill up.
export const SLOTS = ['lounge', 'open', 'kitchen', 'lobby'];
// Channels that have a natural home when they're populated.
const HOMES = { '#general': 'lounge', '#dev': 'open', '#lobby': 'lobby' };
const MAX_PEOPLE = 12; // freeq people drawn per area
const REFRESH_MS = 5 * 60 * 1000;
const IDLE_CLOSE_MS = 2 * 60 * 1000; // listener hangs up this long after the office empties
const USER_IDLE_MS = 30 * 60 * 1000;

// ---- encoding helpers -------------------------------------------------------

const enc = new TextEncoder();
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58btc(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = '1' + out; }
  return out;
}

// did:key for an ed25519 public key: multicodec 0xed01, base58btc ("z…").
export const didKeyFor = (raw) => 'did:key:z' + base58btc(new Uint8Array([0xed, 0x01, ...raw]));

// The listener's identity. `store` keeps a private JWK (get() / set(jwk)).
export async function loadIdentity(store) {
  let jwk = await store.get();
  if (!jwk) {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    await store.set(jwk);
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
  return { did: didKeyFor(unb64url(jwk.x)), sign: async (bytes) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes)) };
}

// ---- IRC lines --------------------------------------------------------------

const unescapeTag = (v) => v.replace(/\\(.)/g, (_, c) => ({ ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' })[c] ?? c);

export function parseLine(line) {
  let rest = line.replace(/\r?\n$/, '');
  const tags = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const i = kv.indexOf('=');
      tags[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '' : unescapeTag(kv.slice(i + 1));
    }
    rest = rest.slice(sp + 1).trimStart();
  }
  let prefix = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).trimStart();
  }
  const params = [];
  while (rest.length) {
    if (rest.startsWith(':')) { params.push(rest.slice(1)); break; }
    const sp = rest.indexOf(' ');
    if (sp < 0) { params.push(rest); break; }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1).trimStart();
  }
  const command = (params.shift() || '').toUpperCase();
  const nick = prefix ? prefix.split('!')[0] : null;
  return { tags, prefix, nick, command, params };
}

// Text that's safe on one IRC line.
const oneLine = (s, n = 400) => String(s ?? '').replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, n);
export const ircNick = (s) => (String(s || '').split('.')[0].replace(/[^A-Za-z0-9_\-\[\]\\^{}|`]/g, '').replace(/^[-0-9]+/, '') || 'office').slice(0, 24);

// SASL responses go in 400-byte pieces; a final full piece is followed by "+".
export function saslLines(payload) {
  const out = [];
  for (let i = 0; i < payload.length; i += 400) out.push(`AUTHENTICATE ${payload.slice(i, i + 400)}`);
  if (!payload.length || payload.length % 400 === 0) out.push('AUTHENTICATE +');
  return out;
}

// ---- one IRC connection -----------------------------------------------------

// `respond(challengeBytes, challenge)` returns the JSON object to send back.
// Resolves `ready` once registered (001), with the DID freeq says we are.
export class IrcClient {
  constructor({ url = FREEQ_URL, openSocket, nick, respond, onLine = () => {}, onClose = () => {}, log = () => {} }) {
    Object.assign(this, { url, openSocket, nick, respond, onLine, onClose, log });
    this.did = null;
    this.bearer = null;
    this.channels = new Set();
    this.dpopNonce = null;
    this.closed = false;
    this.attempt = 0;
    this.ready = new Promise((res, rej) => { this.resolveReady = res; this.rejectReady = rej; });
    this.ready.catch(() => {});
  }

  async open() {
    const ws = this.ws = await this.openSocket(this.url);
    ws.addEventListener('message', (e) => {
      const data = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
      for (const line of data.split(/\r?\n/)) if (line) this.receive(line);
    });
    ws.addEventListener('close', () => this.finish('connection closed'));
    ws.addEventListener('error', () => this.finish('connection error'));
    const go = () => {
      this.send('CAP LS 302');
      this.send(`NICK ${this.nick}`);
      this.send(`USER ${this.nick} 0 * :agent office`);
    };
    if (ws.readyState === 1) go(); else ws.addEventListener('open', go);
    return this.ready;
  }

  send(line) {
    if (this.ws?.readyState === 1) this.ws.send(line);
  }

  finish(why) {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady(new Error(why));
    try { this.ws?.close(); } catch { /* already gone */ }
    this.onClose(why);
  }

  close(msg = 'bye') {
    this.send(`QUIT :${msg}`);
    this.finish('closed');
  }

  join(channel) {
    if (this.channels.has(channel)) return;
    this.channels.add(channel);
    if (this.registered) this.send(`JOIN ${channel}`);
  }

  part(channel) {
    if (this.channels.delete(channel)) this.send(`PART ${channel}`);
  }

  say(channel, text) {
    const t = oneLine(text);
    if (t) this.send(`PRIVMSG ${channel} :${t}`);
  }

  async receive(line) {
    const m = parseLine(line);
    const last = m.params[m.params.length - 1] || '';
    switch (m.command) {
      case 'PING': return this.send(`PONG :${last}`);
      case 'CAP': {
        const sub = (m.params[1] || '').toUpperCase();
        if (sub === 'LS') {
          // Multi-line LS has "*" before the list; act on the last one.
          if (m.params[2] === '*') return;
          const want = ['sasl', 'message-tags', 'account-tag', 'extended-join', 'server-time'].filter((c) => new RegExp(`(^| )${c}(=| |$)`).test(last));
          if (!want.includes('sasl')) return this.finish('freeq offered no SASL');
          return this.send(`CAP REQ :${want.join(' ')}`);
        }
        if (sub === 'ACK' && /(^| )sasl( |$)/.test(last)) return this.send('AUTHENTICATE ATPROTO-CHALLENGE');
        if (sub === 'NAK') return this.finish(`freeq refused capabilities: ${last}`);
        return;
      }
      case 'AUTHENTICATE': {
        if (m.params[0] === '+') return;
        try {
          const bytes = unb64url(m.params[0]);
          const challenge = JSON.parse(new TextDecoder().decode(bytes));
          const reply = await this.respond(bytes, challenge, this);
          for (const l of saslLines(b64url(enc.encode(JSON.stringify(reply))))) this.send(l);
        } catch (e) {
          this.send('AUTHENTICATE *');
          this.finish(`couldn't answer the sign-in challenge: ${e.message}`);
        }
        return;
      }
      case 'NOTICE':
        // pds-oauth: the PDS wants a DPoP nonce; a fresh challenge follows.
        if (last.startsWith('DPOP_NONCE ')) { this.dpopNonce = last.slice(11).trim(); return; }
        if (last.startsWith('API-BEARER ')) { this.bearer = last.slice(11).trim(); return; }
        break;
      case '900': this.did = (last.match(/(did:[a-z0-9]+:[^\s]+)/i) || [])[1] || this.did; return;
      case '903': return this.send('CAP END');
      case '904': case '905': case '906': case '902':
        return this.finish(`freeq sign-in failed: ${last}`);
      case '001':
        this.registered = true;
        this.nick = m.params[0] || this.nick;
        this.resolveReady({ did: this.did, nick: this.nick });
        for (const c of this.channels) this.send(`JOIN ${c}`);
        break;
      case '433': {
        // Nick taken: try a numbered one, a few times.
        if (++this.attempt > 4) return this.finish('no free nick');
        this.nick = `${this.nick.replace(/\d+$/, '').slice(0, 20)}${Math.floor(Math.random() * 900 + 100)}`;
        return this.send(`NICK ${this.nick}`);
      }
      case 'ERROR': return this.finish(last || 'server error');
      case 'NICK':
        if (m.nick === this.nick) this.nick = m.params[0];
        break;
    }
    this.onLine(m, this);
  }
}

// SASL answer for the listener: sign the decoded challenge bytes as-is.
export const cryptoResponder = (identity) => async (bytes) => ({
  method: 'crypto', did: identity.did, signature: b64url(await identity.sign(bytes)),
});

// SASL answer for a person: their DPoP-bound access token, plus a DPoP proof
// for GET {pds}/xrpc/com.atproto.server.getSession that freeq passes on.
// `creds(nonce)` comes from auth.freeqCredentials(did).
export const oauthResponder = (creds) => async (bytes, challenge, irc) => {
  const c = await creds(irc.dpopNonce);
  return { method: 'pds-oauth', did: c.did, signature: c.accessToken, pds_url: c.pds, dpop_proof: c.dpopProof, challenge_nonce: challenge.nonce };
};

// ---- the bridge -------------------------------------------------------------

const zoneById = Object.fromEntries(ZONES.map((z) => [z.id, z]));
const lower = (s) => String(s || '').toLowerCase();

// A free spot inside an area, a little away from its walls.
function spotIn(zone, taken) {
  for (let i = 0; i < 60; i++) {
    const x = zone.x0 + 1 + Math.random() * Math.max(1, zone.x1 - zone.x0 - 2);
    const y = zone.y0 + 1 + Math.random() * Math.max(1, zone.y1 - zone.y0 - 2);
    if (isBlocked(Math.floor(x), Math.floor(y))) continue;
    if (taken.some((p) => Math.hypot(p.x - x, p.y - y) < 1.2)) continue;
    return { x: +x.toFixed(2), y: +y.toFixed(2) };
  }
  return { x: (zone.x0 + zone.x1) / 2, y: (zone.y0 + zone.y1) / 2 };
}

export class FreeqBridge {
  // office: the Office. auth: has freeqCredentials(did) (see auth.js).
  // keyStore: { get(), set(jwk) } for the listener's key. rooms: optional
  // fixed "zone=#channel,…" mapping instead of picking populated channels.
  constructor({ office, auth, openSocket, keyStore, url = FREEQ_URL, rooms = '', minMembers = 2, fetch: fetchImpl = globalThis.fetch, log = console.log }) {
    Object.assign(this, { office, auth, openSocket, keyStore, url, minMembers, log });
    // Wrapped: calling a stored fetch as this.fetch() throws "Illegal invocation" on Workers.
    this.fetch = (...a) => fetchImpl(...a);
    this.api = url.replace(/^ws/, 'http').replace(/\/irc\/?$/, '');
    this.fixed = parseRooms(rooms);
    this.bindings = new Map(); // zoneId -> { channel, members, topic }
    this.listener = null;
    this.people = new Map(); // lower(nick) -> { nick, channels, active, peer }
    this.users = new Map(); // office DID -> { irc, ready, used }
    this.timers = [];
    office.freeq = this;
  }

  // ---- lifecycle: the listener only runs while somebody is in the office ----

  // Call whenever office presence changes.
  presence() {
    const humans = [...this.office.peers.values()].some((p) => p.ready && p.kind !== 'freeq');
    if (humans) {
      clearTimeout(this.idleTimer); this.idleTimer = null;
      if (!this.listener && !this.starting) this.start().catch((e) => this.log(`freeq: ${e.message}`));
    } else if (this.listener && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.stop(), IDLE_CLOSE_MS);
    }
  }

  async start() {
    this.starting = true;
    try {
      const identity = await loadIdentity(this.keyStore);
      const irc = new IrcClient({
        url: this.url, openSocket: this.openSocket, nick: 'agentoffice', respond: cryptoResponder(identity),
        onLine: (m) => this.onListenerLine(m),
        onClose: (why) => this.onListenerClosed(irc, why),
      });
      this.listener = irc;
      await irc.open();
      this.log(`freeq: listening as ${irc.nick} (${identity.did})`);
      this.backoff = 0;
      await this.refresh();
      clearInterval(this.refreshTimer);
      this.refreshTimer = setInterval(() => this.refresh().catch((e) => this.log(`freeq: ${e.message}`)), REFRESH_MS);
    } catch (e) {
      this.listener = null;
      throw e;
    } finally {
      this.starting = false;
    }
  }

  stop() {
    clearInterval(this.refreshTimer); this.refreshTimer = null;
    clearTimeout(this.idleTimer); this.idleTimer = null;
    const l = this.listener; this.listener = null;
    l?.close('office closed for the night');
    for (const u of this.users.values()) u.irc.close();
    this.users.clear();
    for (const zoneId of [...this.bindings.keys()]) this.unbind(zoneId);
  }

  onListenerClosed(irc, why) {
    if (this.listener !== irc) return;
    this.log(`freeq: listener disconnected (${why})`);
    this.listener = null;
    for (const zoneId of [...this.bindings.keys()]) this.unbind(zoneId);
    // Come back if people are still here.
    const wait = Math.min(60000, 2000 * 2 ** (this.backoff = (this.backoff || 0) + 1));
    setTimeout(() => this.presence(), wait);
  }

  // ---- which channels go where ---------------------------------------------

  async channels() {
    const r = await this.fetch(`${this.api}/api/v1/channels`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`freeq channel list: HTTP ${r.status}`);
    return r.json();
  }

  async refresh() {
    if (!this.listener) return;
    const list = await this.channels();
    this.apply(this.plan(list));
  }

  // Pick channels for areas. Our own connections don't count as people.
  plan(list) {
    const ours = (ch) => (this.listener?.channels.has(ch) ? 1 : 0) + [...this.users.values()].filter((u) => u.irc.channels.has(ch)).length;
    const info = new Map(list.filter((c) => c.name?.startsWith('#')).map((c) => [lower(c.name), { channel: c.name, members: Math.max(0, (c.members || 0) - ours(c.name)), topic: c.topic || null }]));
    const out = new Map();
    if (this.fixed.size) {
      for (const [zoneId, ch] of this.fixed) out.set(zoneId, info.get(lower(ch)) || { channel: ch, members: 0, topic: null });
      return out;
    }
    const free = new Set(SLOTS);
    const place = (zoneId, c) => { out.set(zoneId, c); free.delete(zoneId); info.delete(lower(c.channel)); };
    // Stay put while anyone is still there, so areas don't reshuffle under people.
    for (const [zoneId, b] of this.bindings) {
      const c = info.get(lower(b.channel));
      if (c && c.members > 0) place(zoneId, c);
    }
    const populated = [...info.values()].filter((c) => c.members >= this.minMembers).sort((a, b) => b.members - a.members || a.channel.localeCompare(b.channel));
    for (const c of populated) {
      const home = HOMES[lower(c.channel)];
      if (home && free.has(home)) place(home, c);
    }
    for (const c of populated) {
      if (!info.has(lower(c.channel)) || !free.size) continue;
      place([...free][0], c);
    }
    return out;
  }

  apply(plan) {
    for (const [zoneId, b] of [...this.bindings]) {
      if (plan.get(zoneId)?.channel !== b.channel) this.unbind(zoneId);
    }
    for (const [zoneId, c] of plan) {
      const cur = this.bindings.get(zoneId);
      if (cur) { cur.members = c.members; cur.topic = c.topic; continue; }
      this.bindings.set(zoneId, { ...c });
      this.listener?.join(c.channel);
      this.log(`freeq: ${c.channel} → ${zoneById[zoneId].name}`);
    }
    this.announce();
  }

  unbind(zoneId) {
    const b = this.bindings.get(zoneId);
    if (!b) return;
    this.bindings.delete(zoneId);
    this.listener?.part(b.channel);
    for (const f of [...this.people.values()]) this.dropChannel(f.nick, b.channel);
    for (const u of this.users.values()) u.irc.part(b.channel);
  }

  zoneFor(channel) {
    for (const [zoneId, b] of this.bindings) if (lower(b.channel) === lower(channel)) return zoneId;
    return null;
  }

  // What clients see: area -> channel.
  state() {
    return Object.fromEntries([...this.bindings].map(([z, b]) => [z, { channel: b.channel, members: b.members, topic: b.topic }]));
  }

  announce() {
    this.office.broadcast({ t: 'freeq', rooms: this.state(), web: 'https://freeq.at' });
  }

  // ---- freeq people in the office ------------------------------------------

  isOurs(nick, account) {
    if (lower(nick) === lower(this.listener?.nick)) return true;
    for (const [did, u] of this.users) if (lower(u.irc.nick) === lower(nick) || (account && account === did)) return true;
    return false;
  }

  // One avatar per freeq person, however many attached channels they're in.
  // They stand in the area of the channel they last spoke in (or the first
  // one we saw them in), walk over when they speak somewhere else, and their
  // status note lists the other channels.
  person(channel, nick, account) {
    const zoneId = this.zoneFor(channel);
    if (!zoneId || !nick || this.isOurs(nick, account)) return null;
    let f = this.people.get(lower(nick));
    if (!f) this.people.set(lower(nick), f = { nick, channels: new Map(), active: null, peer: null });
    f.channels.set(lower(channel), channel);
    if (!f.peer) this.place(f, channel);
    else this.describe(f);
    if (f.peer && account && account.startsWith('did:') && !f.peer.did) this.office.identifyRemote(f.peer, account);
    return f.peer;
  }

  // Put (or move) someone in a channel's area; falls back to their other
  // channels when that area is full.
  place(f, channel) {
    const order = [channel, ...[...f.channels.values()].filter((c) => c !== channel)];
    for (const ch of order) {
      const zoneId = this.zoneFor(ch);
      if (!zoneId) continue;
      if (f.peer?.freeqZone === zoneId) { f.active = ch; return this.describe(f); }
      const here = [...this.people.values()].filter((g) => g.peer && g !== f && g.peer.freeqZone === zoneId).map((g) => g.peer);
      if (here.length >= MAX_PEOPLE) continue;
      const at = spotIn(zoneById[zoneId], here);
      f.active = ch;
      if (f.peer) {
        f.peer.freeqZone = zoneId;
        this.office.moveRemote(f.peer, at.x, at.y);
      } else {
        f.peer = this.office.addRemote({ name: f.nick, kind: 'freeq', ...at, freeqZone: zoneId });
      }
      return this.describe(f);
    }
    // Nowhere to stand: don't leave them in an area that's no longer theirs.
    if (f.peer && ![...f.channels.values()].some((ch) => this.zoneFor(ch) === f.peer.freeqZone)) {
      this.office.removeRemote(f.peer);
      f.peer = null;
    }
  }

  describe(f) {
    if (!f.peer) return;
    const others = [...f.channels.values()].filter((c) => c !== f.active);
    const note = `${f.active}${others.length ? ` · also ${others.join(', ')}` : ''}`.slice(0, 80);
    if (note !== f.peer.note) this.office.noteRemote(f.peer, note);
  }

  // They left a channel (or it was detached from the office).
  dropChannel(nick, channel) {
    const f = this.people.get(lower(nick));
    if (!f || !f.channels.delete(lower(channel))) return;
    if (!f.channels.size) {
      this.people.delete(lower(nick));
      if (f.peer) this.office.removeRemote(f.peer);
      return;
    }
    if (!f.peer || lower(f.active) === lower(channel)) this.place(f, [...f.channels.values()].pop());
    else this.describe(f);
  }

  onListenerLine(m) {
    const account = m.tags.account && m.tags.account !== '*' ? m.tags.account : null;
    switch (m.command) {
      case '353': { // NAMES: "= #chan :@nick +nick nick"
        const channel = m.params[2];
        for (const n of (m.params[3] || '').split(' ')) if (n) this.person(channel, n.replace(/^[~&@%+]+/, ''), null);
        return;
      }
      case 'JOIN': return void this.person(m.params[0], m.nick, account || (m.params[1] && m.params[1] !== '*' ? m.params[1] : null));
      case 'PART': return this.dropChannel(m.nick, m.params[0]);
      case 'KICK': return this.dropChannel(m.params[1], m.params[0]);
      case 'QUIT': {
        const f = this.people.get(lower(m.nick));
        if (f) { this.people.delete(lower(m.nick)); if (f.peer) this.office.removeRemote(f.peer); }
        return;
      }
      case 'NICK': {
        const f = this.people.get(lower(m.nick));
        if (!f) return;
        this.people.delete(lower(m.nick));
        f.nick = m.params[0];
        this.people.set(lower(f.nick), f);
        if (f.peer) this.office.renameRemote(f.peer, f.nick);
        return;
      }
      case 'TOPIC': {
        const b = this.bindings.get(this.zoneFor(m.params[0]));
        if (b) { b.topic = m.params[1] || null; this.announce(); }
        return;
      }
      case 'PRIVMSG': {
        const [channel, text] = m.params;
        if (!channel?.startsWith('#') || this.isOurs(m.nick, account)) return;
        const zoneId = this.zoneFor(channel);
        if (!zoneId || !text) return;
        this.person(channel, m.nick, account);
        // Speaking somewhere makes it where they are.
        const f = this.people.get(lower(m.nick));
        if (f && lower(f.active) !== lower(channel)) this.place(f, channel);
        const action = text.match(/^\u0001ACTION (.*)\u0001$/);
        if (/^\u0001/.test(text) && !action) return; // other CTCP
        this.office.remoteChat({ zoneId, channel, peer: f?.peer?.freeqZone === zoneId ? f.peer : null, name: m.nick, text: action ? `* ${m.nick} ${action[1]}` : text });
        return;
      }
    }
  }

  // ---- office people talking on freeq --------------------------------------

  // Called by the office for chat said inside an attached area. Returns a
  // note for the speaker when it couldn't go to freeq, else null.
  async relay(p, zoneId, text) {
    const b = this.bindings.get(zoneId);
    if (!b) return null;
    if (!p.did || p.kind !== 'human') return `Only signed-in people can talk on freeq; this stayed in the office.`;
    try {
      const u = await this.userConnection(p);
      u.used = Date.now();
      u.irc.join(b.channel);
      u.irc.say(b.channel, text);
      return null;
    } catch (e) {
      return `Couldn't reach ${b.channel} on freeq as you: ${e.message}`;
    }
  }

  async userConnection(p) {
    let u = this.users.get(p.did);
    if (u && !u.irc.closed) { await u.ready; return u; }
    if (!this.auth?.freeqCredentials) throw new Error('sign-in tokens are not available');
    const creds = (nonce) => this.auth.freeqCredentials(p.did, nonce);
    await creds(null); // fail early (and warm the PDS's DPoP nonce) before opening a socket
    const irc = new IrcClient({
      url: this.url, openSocket: this.openSocket, nick: ircNick(p.handle || p.name), respond: oauthResponder(creds),
      onClose: () => { if (this.users.get(p.did)?.irc === irc) this.users.delete(p.did); },
    });
    u = { irc, used: Date.now(), ready: irc.open() };
    this.users.set(p.did, u);
    if (!this.sweeper) this.sweeper = setInterval(() => this.sweep(), 60000);
    try { await u.ready; } catch (e) { this.users.delete(p.did); throw e; }
    return u;
  }

  // Someone left the office, or went quiet for a long time: hang up for them.
  leave(p) {
    const u = p.did && this.users.get(p.did);
    if (u && ![...this.office.peers.values()].some((q) => q !== p && q.did === p.did && q.kind === 'human')) {
      this.users.delete(p.did);
      u.irc.close('left the office');
    }
  }

  sweep() {
    for (const [did, u] of this.users) if (Date.now() - u.used > USER_IDLE_MS) { this.users.delete(did); u.irc.close('idle'); }
    if (!this.users.size) { clearInterval(this.sweeper); this.sweeper = null; }
  }
}

// "lounge=#general, open=#dev" -> Map(zoneId -> channel)
export function parseRooms(s) {
  const out = new Map();
  for (const part of String(s || '').split(',')) {
    const [z, ch] = part.split('=').map((x) => x?.trim());
    if (z && ch && zoneById[z]) out.set(z, ch.startsWith('#') ? ch : `#${ch}`);
  }
  return out;
}
