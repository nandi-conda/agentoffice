// Bridge to freeq (https://freeq.at), an IRC network whose accounts are AT
// Protocol identities. Populated freeq channels each get a generated room off
// the office's hallway wing (offered to the office as a channel source, see
// server/entities/channels.js; the office knows nothing of freeq): the
// channel's people stand in that room, what they say shows up as chat there,
// and what signed-in office people say there goes to the channel as themselves.
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
import { channelKey } from '../public/js/wing.js';
import { Seen, Saver, missedSince, tagSeconds, usable, SNAPSHOT_VERSION } from './freeq-sync.js';

export const FREEQ_URL = 'wss://irc.freeq.at/irc';
export const MAX_ROOMS = 12; // channels offered for rooms, busiest first
const POLICY_TTL = 10 * 60 * 1000;
const MAX_PEOPLE = 12; // freeq people drawn per area
const REFRESH_MS = 5 * 60 * 1000;
const IDLE_CLOSE_MS = 2 * 60 * 1000; // listener hangs up this long after the office empties
const USER_IDLE_MS = 30 * 60 * 1000;
const SIGN_IN_MS = 20 * 1000; // give up on a listener sign-in freeq doesn't finish
// After a restart or a dropped listener, people stay drawn this long while
// freeq is asked who's really still there; then whoever wasn't confirmed goes.
const STALE_MS = 3 * 60 * 1000;

// A promise that rejects with `why` if `p` takes longer than `ms`.
const within = (p, ms, why) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(why)), ms); })]).finally(() => clearTimeout(t));
};

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
  return { did: didKeyFor(unb64url(jwk.x)), secret: jwk.d, sign: async (bytes) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes)) };
}

// A did:key made from a 32-byte seed (PKCS#8 for a raw Ed25519 seed), so an
// identity can be derived again instead of stored.
const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
export async function identityFromSeed(seed) {
  const key = await crypto.subtle.importKey('pkcs8', new Uint8Array([...PKCS8_ED25519, ...seed]), { name: 'Ed25519' }, true, ['sign']);
  const { x } = await crypto.subtle.exportKey('jwk', key);
  return { did: didKeyFor(unb64url(x)), sign: async (bytes) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes)) };
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

// A SASL response goes on one line whenever it fits freeq's 8192-byte line
// limit. IRCv3 says 400-byte pieces, but freeq only reassembles pieces since
// 2026-10-19; older servers (irc.freeq.at was one) decode each line on its own
// and answer "bad response: response is not JSON". One line works on both.
// Only a response too long for one line is split (a final full piece is
// followed by "+").
export const MAX_SASL_LINE = 8177;
export function saslLines(payload) {
  if (!payload.length) return ['AUTHENTICATE +'];
  if (payload.length <= MAX_SASL_LINE) return [`AUTHENTICATE ${payload}`];
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

// SASL answer for an agent with a plain PDS bearer token (Roost's rmcp_…):
// freeq calls {pds}/xrpc/com.atproto.server.getSession with it.
export const sessionResponder = ({ did, token, pds }) => async (bytes, challenge) => ({
  method: 'pds-session', did, signature: token, pds_url: pds, challenge_nonce: challenge.nonce,
});

// SASL answer for a person: their DPoP-bound access token, plus a DPoP proof
// for GET {pds}/xrpc/com.atproto.server.getSession that freeq passes on.
// `creds(nonce)` comes from auth.freeqCredentials(did).
export const oauthResponder = (creds) => async (bytes, challenge, irc) => {
  const c = await creds(irc.dpopNonce);
  return { method: 'pds-oauth', did: c.did, signature: c.accessToken, pds_url: c.pds, dpop_proof: c.dpopProof, challenge_nonce: challenge.nonce };
};

// ---- the bridge -------------------------------------------------------------

// Zones come and go with the channel wing, so look them up each time.
const zoneById = (id) => ZONES.find((z) => z.id === id) || null;
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
  // keyStore: { get(), set(jwk) } for the listener's key. stateStore:
  // optional { get(), set(obj) } for the snapshot that survives restarts (see
  // freeq-sync.js). rooms: optional fixed "zone=#channel,…" mapping instead of
  // picking populated channels.
  //
  // The office never waits on freeq: nothing here is awaited by joins, chat
  // or sign-in, and when freeq is unreachable the areas just stay plain.
  constructor({ office, auth, openSocket, keyStore, stateStore = null, url = FREEQ_URL, rooms = '', always = '', minMembers = 2, fetch: fetchImpl = globalThis.fetch, log = console.log, signInMs = SIGN_IN_MS, graceMs = STALE_MS }) {
    Object.assign(this, { office, auth, openSocket, keyStore, stateStore, url, minMembers, log, signInMs, graceMs });
    // Wrapped: calling a stored fetch as this.fetch() throws "Illegal invocation" on Workers.
    this.fetch = (...a) => fetchImpl(...a);
    this.api = url.replace(/^ws/, 'http').replace(/\/irc\/?$/, '');
    this.fixed = parseRooms(rooms);
    // Channels offered whatever their size: policy-gated ones like #freeq
    // aren't in freeq's public channel list at all.
    this.always = String(always || '').split(',').map((c) => c.trim()).filter(Boolean).map((c) => (c.startsWith('#') ? c : `#${c}`));
    this.policies = new Map(); // lower(channel) -> { at, policy }
    this.bindings = new Map(); // zoneId -> { channel, members, topic }
    this.listener = null;
    this.people = new Map(); // lower(nick) -> { nick, channels, active, peer }
    this.users = new Map(); // keyOf(peer) -> { irc, ready, used }
    this.agentTokens = new Map(); // agent DID -> { did, token, pds }, memory only
    this.seen = new Seen();
    this.saver = new Saver(stateStore, () => this.snapshot(), { log });
    office.freeq = this;
    this.restored = this.restore();
  }

  // ---- lifecycle: the listener only runs while somebody is in the office ----

  // Call whenever office presence changes, and on any wake-up: it's how a
  // listener lost to a restart or a dropped connection comes back.
  presence() {
    const humans = [...this.office.peers.values()].some((p) => p.ready && p.kind !== 'freeq');
    if (humans) {
      clearTimeout(this.idleTimer); this.idleTimer = null;
      // A pending retry owns the next attempt, so a busy office doesn't hammer freeq.
      if (!this.listener && !this.starting && !this.retryTimer) this.start().catch((e) => this.log(`freeq: ${e.message}`));
    } else if (this.listener && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.stop(), IDLE_CLOSE_MS);
    }
  }

  async start() {
    this.starting = true;
    let irc = null;
    try {
      await this.restored;
      const identity = await loadIdentity(this.keyStore);
      this.secret = identity.secret;
      irc = new IrcClient({
        url: this.url, openSocket: this.openSocket, nick: 'agentoffice', respond: cryptoResponder(identity),
        onLine: (m) => this.onListenerLine(m),
        onClose: (why) => this.onListenerClosed(irc, why),
      });
      this.listener = irc;
      // Without a time limit, a sign-in that never finishes leaves the
      // bridge "starting" for good and nobody from freeq ever shows up.
      await within(irc.open(), this.signInMs, `freeq didn't finish signing the office in within ${Math.round(this.signInMs / 1000)}s`);
      this.log(`freeq: listening as ${irc.nick} (${identity.did})`);
      this.backoff = 0;
      this.since = Date.now();
      this.lastError = null;
    } catch (e) {
      if (this.listener === irc) this.listener = null;
      irc?.close('sign-in failed');
      this.lastError = e.message;
      this.retry();
      throw e;
    } finally {
      this.starting = false;
    }
    // A failed channel list shouldn't cost the connection; the next refresh tries again.
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => this.refresh().catch((e) => this.failed(e)), REFRESH_MS);
    await this.refresh().catch((e) => this.failed(e));
  }

  failed(e) {
    this.lastError = e.message;
    this.log(`freeq: ${e.message}`);
  }

  // Try again later, backing off up to a minute.
  retry() {
    clearTimeout(this.retryTimer);
    const wait = Math.min(60000, 2000 * 2 ** (this.backoff = (this.backoff || 0) + 1));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.presence(); }, wait);
  }

  // For /api/office: is the bridge up, and if not, why.
  status() {
    return {
      listening: !!this.listener?.registered, nick: this.listener?.nick || null, since: this.since || null,
      channels: [...this.bindings.values()].map((b) => b.channel), people: this.people.size,
      retrying: !!this.retryTimer, lastError: this.lastError || null,
    };
  }

  stop() {
    clearInterval(this.refreshTimer); this.refreshTimer = null;
    clearTimeout(this.idleTimer); this.idleTimer = null;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearTimeout(this.wingTimer); this.wingTimer = null;
    const l = this.listener; this.listener = null;
    l?.close('office closed for the night');
    for (const u of this.users.values()) u.irc.close();
    this.users.clear();
    clearInterval(this.sweeper); this.sweeper = null;
    this.unbindAll();
    this.saver.now();
  }

  unbindAll() {
    clearTimeout(this.staleTimer); this.staleTimer = null;
    for (const zoneId of [...this.bindings.keys()]) this.unbind(zoneId);
    this.announce();
  }

  // Lost freeq for a moment (a dropped connection): keep everyone where they
  // stand and ask again once the listener is back, rather than emptying the
  // areas and filling them up again.
  onListenerClosed(irc, why) {
    if (this.listener !== irc) return;
    this.log(`freeq: listener disconnected (${why})`);
    this.listener = null;
    this.lastError = `listener disconnected: ${why}`;
    clearInterval(this.refreshTimer); this.refreshTimer = null;
    this.markStale();
    // Come back if people are still here.
    this.retry();
  }

  // ---- surviving restarts (see freeq-sync.js) ------------------------------

  snapshot() {
    return {
      v: SNAPSHOT_VERSION, at: Date.now(),
      bindings: Object.fromEntries([...this.bindings].map(([z, b]) => [z, { channel: b.channel, topic: b.topic, members: b.members, last: b.last || null }])),
      people: [...this.people.values()].filter((f) => f.peer).map((f) => ({
        nick: f.nick, channels: [...f.channels.values()], active: f.active, zone: f.peer.freeqZone, x: f.peer.x, y: f.peer.y,
        did: f.peer.did || null, handle: f.peer.handle || null, actor: f.peer.actor || null,
      })),
      seen: this.seen.toJSON(),
    };
  }

  // Put back what the office looked like before a restart: the areas'
  // channels and the people standing in them, all unconfirmed until freeq
  // says who's still there.
  async restore() {
    if (!this.stateStore) return;
    // Channel rooms are part of the map only once the office has its wing.
    await this.office.ready;
    let snap = null;
    try { snap = await this.stateStore.get(); } catch (e) { return this.failed(e); }
    if (!snap) return;
    this.seen = new Seen(snap.seen);
    if (!usable(snap) || this.bindings.size || this.people.size) return;
    for (const [zoneId, b] of Object.entries(snap.bindings || {})) {
      if (zoneById(zoneId) && b?.channel) this.bindings.set(zoneId, { channel: b.channel, topic: b.topic || null, members: b.members || 0, last: b.last || null });
    }
    for (const r of snap.people || []) {
      const channels = (r.channels || []).filter((ch) => this.zoneFor(ch));
      if (!r.nick || !channels.length || !zoneById(r.zone) || this.people.has(lower(r.nick))) continue;
      const f = { nick: r.nick, channels: new Map(channels.map((c) => [lower(c), c])), active: channels.includes(r.active) ? r.active : channels[0], peer: null };
      f.peer = this.office.addRemote({ name: r.nick, kind: 'freeq', x: r.x, y: r.y, freeqZone: r.zone, did: r.did || null, handle: r.handle || null, actor: r.actor || null });
      this.people.set(lower(r.nick), f);
      this.describe(f);
    }
    if (this.bindings.size) this.log(`freeq: restored ${this.bindings.size} channel(s) and ${this.people.size} people from before the restart`);
    this.markStale();
    this.announce();
  }

  // Everyone drawn is unconfirmed until freeq's NAMES lists them again.
  markStale() {
    for (const f of this.people.values()) f.stale = new Set(f.channels.keys());
    for (const b of this.bindings.values()) b.named = false;
    clearTimeout(this.staleTimer);
    this.staleTimer = this.people.size || this.bindings.size ? setTimeout(() => this.expireStale(), this.graceMs) : null;
  }

  // The grace period ran out. Without a listener the areas go plain;
  // otherwise only the people freeq never confirmed leave.
  expireStale() {
    this.staleTimer = null;
    if (!this.listener?.registered) return this.unbindAll();
    for (const f of [...this.people.values()]) for (const key of [...(f.stale || [])]) { f.stale.delete(key); this.dropChannel(f.nick, f.channels.get(key) || key); }
    this.announce();
  }

  // End of NAMES for a channel: whoever we still had down as there but
  // freeq didn't list has left. Then catch up on what was said meanwhile.
  settle(channel) {
    const key = lower(channel);
    for (const f of [...this.people.values()]) {
      if (f.stale?.delete(key)) this.dropChannel(f.nick, channel);
    }
    const b = this.bindings.get(this.zoneFor(channel));
    if (b) b.named = true;
    this.announce();
    this.saver.soon();
    if (this.listener && !this.listener.caughtUp?.has(key)) {
      (this.listener.caughtUp ||= new Set()).add(key);
      this.backfill(channel).catch((e) => this.failed(e));
    }
  }

  // Messages said in a channel while the office wasn't listening, from
  // freeq's public REST history, played into the area as catch-up.
  async backfill(channel) {
    const seen = this.seen.get(channel);
    if (!seen) return;
    const r = await this.fetch(`${this.api}/api/v1/channels/${encodeURIComponent(channel)}/history?limit=100`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`freeq history for ${channel}: HTTP ${r.status}`);
    const missed = missedSince(await r.json(), seen, { recent: this.seen.recent });
    for (const m of missed) this.heard(channel, m.sender, m.tags?.account || null, m.text, { ts: Number(m.timestamp), msgid: m.msgid || null, backfill: true });
    if (missed.length) this.log(`freeq: caught up on ${missed.length} message(s) in ${channel}`);
  }

  // ---- which channels go where ---------------------------------------------

  async channels() {
    const r = await this.fetch(`${this.api}/api/v1/channels`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`freeq channel list: HTTP ${r.status}`);
    return r.json();
  }

  // The wing changed: a room opened in the office that isn't bridged yet gets
  // its freeq channel now rather than at the next refresh.
  wingChanged() {
    const bound = new Set([...this.bindings.values()].map((b) => lower(b.channel)));
    if (!this.listener || !(this.office.wing || []).some((r) => r.sources?.includes('office') && !bound.has(lower(r.channel)))) return;
    clearTimeout(this.wingTimer);
    this.wingTimer = setTimeout(() => this.refresh().catch((e) => this.failed(e)), 500);
    this.wingTimer.unref?.();
  }

  async refresh() {
    if (!this.listener) return;
    const list = await this.channels();
    this.apply(await this.plan(list));
    // Ask who's there rather than counting on the reply to JOIN; it also
    // brings back anyone missed, e.g. after a restart. Whoever we have down
    // as in the channel but the reply doesn't list has left (see settle()).
    for (const b of this.bindings.values()) {
      const key = lower(b.channel);
      for (const f of this.people.values()) if (f.channels.has(key)) (f.stale ||= new Set()).add(key);
      this.listener?.send(`NAMES ${b.channel}`);
    }
    this.saver.soon(); // keeps the snapshot fresh enough to restore from
  }

  // Pick channels and get each a room. Our own connections don't count as people.
  async plan(list) {
    const ours = (ch) => (this.listener?.channels.has(ch) ? 1 : 0) + [...this.users.values()].filter((u) => u.irc.channels.has(ch)).length;
    const info = new Map(list.filter((c) => c.name?.startsWith('#')).map((c) => [lower(c.name), { channel: c.name, members: Math.max(0, (c.members || 0) - ours(c.name)), topic: c.topic || null }]));
    const out = new Map();
    if (this.fixed.size) {
      for (const [zoneId, ch] of this.fixed) out.set(zoneId, info.get(lower(ch)) || { channel: ch, members: 0, topic: null });
      return out;
    }
    // Busy channels, plus any we're attached to that still have someone,
    // so a room doesn't vanish under people when a channel quietens.
    const keep = new Set([...this.bindings.values()].map((b) => lower(b.channel)));
    // Rooms people opened in the office get the channel of the same name on
    // freeq (joining creates it there if it's new), so they're bridged too.
    const opened = (this.office.wing || []).filter((r) => r.sources?.includes('office')).map((r) => r.channel);
    const pinned = [...new Map([...this.always, ...opened].map((ch) => [lower(ch), ch])).values()];
    const always = pinned.map((ch) => info.get(lower(ch)) || { channel: ch, members: 0, topic: null });
    const wanted = [...always, ...[...info.values()]
      .filter((c) => !pinned.some((ch) => lower(ch) === lower(c.channel)))
      .filter((c) => c.members >= this.minMembers || (keep.has(lower(c.channel)) && c.members > 0))
      .sort((a, b) => b.members - a.members || a.channel.localeCompare(b.channel))]
      .slice(0, MAX_ROOMS);
    if (!this.office.offerChannels) return out;
    const policies = await Promise.all(wanted.map((c) => this.policyFor(c.channel)));
    const zones = await this.office.offerChannels('freeq', wanted.map((c, i) => ({
      name: c.channel, members: c.members, topic: c.topic, policy: policies[i], allow: this.allowed(c.channel),
    })));
    for (const c of wanted) {
      const zoneId = zones[channelKey(c.channel)];
      if (zoneId && zoneById(zoneId)) out.set(zoneId, c);
    }
    return out;
  }

  // A channel's access policy (freeq docs/POLICY.md, GET /api/v1/policy/{channel}),
  // in the office's generic shape (public/js/policy.js). Null when it has none.
  async policyFor(channel) {
    const key = lower(channel), hit = this.policies.get(key);
    if (hit && Date.now() - hit.at < POLICY_TTL) return hit.policy;
    let policy = hit?.policy ?? null;
    try {
      const get = async (path) => {
        const r = await this.fetch(`${this.api}/api/v1/policy/${encodeURIComponent(channel)}${path}`, { headers: { accept: 'application/json' } });
        return r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(`HTTP ${r.status}`));
      };
      const doc = (await get(''))?.policy;
      policy = null;
      if (doc && typeof doc === 'object' && doc.requirements) {
        const hash = findAccept(doc.requirements);
        const rules = hash ? await get('/rules').catch(() => null) : null;
        policy = {
          source: 'freeq', version: doc.version, require: doc.requirements, roles: doc.role_requirements || {},
          rules: rules?.hash === hash ? rules.text : null, rulesHash: hash || null,
          endpoints: Object.fromEntries(Object.entries(doc.credential_endpoints || {}).map(([k, e]) => [k, { label: e.label || k, url: e.url ? new URL(e.url, this.api).href : undefined }])),
          url: `https://freeq.at`,
        };
      }
    } catch (e) {
      this.log(`freeq: couldn't read the policy of ${channel}: ${e.message}`);
    }
    this.policies.set(key, { at: Date.now(), policy });
    return policy;
  }

  // Who freeq already lets into a channel: everyone we've seen there with an
  // account, and office people whose own connection is in it.
  allowed(channel) {
    const key = lower(channel), out = new Set();
    for (const f of this.people.values()) if (f.channels.has(key) && f.peer?.did) out.add(f.peer.did);
    for (const [did, u] of this.users) if (u.irc.channels.has(channel) || u.irc.channels.has(key)) out.add(did);
    return [...out];
  }

  apply(plan) {
    for (const [zoneId, b] of [...this.bindings]) {
      if (plan.get(zoneId)?.channel !== b.channel) this.unbind(zoneId);
    }
    for (const [zoneId, c] of plan) {
      const cur = this.bindings.get(zoneId);
      // (Re)joining is a no-op when already in it; after a restart it's how
      // restored areas get their NAMES.
      this.listener?.join(c.channel);
      if (cur) { cur.members = c.members; cur.topic = c.topic; continue; }
      this.bindings.set(zoneId, { ...c });
      this.log(`freeq: ${c.channel} → ${zoneById(zoneId).name}`);
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

  // What clients see: area -> channel. `members` counts the freeq people we
  // know are in the channel (from NAMES, so it matches who's drawn; freeq's
  // channel list count until NAMES arrives), `here` the ones standing in the area.
  state() {
    const people = [...this.people.values()];
    return Object.fromEntries([...this.bindings].map(([z, b]) => {
      const known = people.filter((f) => f.channels.has(lower(b.channel))).length;
      const here = people.filter((f) => f.peer?.freeqZone === z).length;
      return [z, { channel: b.channel, members: b.named || known ? known : b.members, here, topic: b.topic, last: b.last || null }];
    }));
  }

  // People came, went or moved between areas: tell clients (once per burst).
  changed() {
    this.saver.soon();
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => { this.announceTimer = null; this.announce(); }, 250);
  }

  // Someone spoke in a channel. Clients show "active 2m ago", so a fresh
  // timestamp only needs to go out when the shown value would change.
  touch(b, at = Date.now()) {
    if (b.last && at <= b.last) return;
    const now = at, stale = !b.last || now - b.last > 30000;
    b.last = now;
    if (stale) this.announce();
  }

  announce() {
    this.office.broadcast({ t: 'freeq', rooms: this.state(), web: 'https://freeq.at' });
  }

  // ---- freeq people in the office ------------------------------------------

  isOurs(nick, account) {
    if (lower(nick) === lower(this.listener?.nick)) return true;
    for (const [did, u] of this.users) if (lower(u.irc.nick) === lower(nick) || (account && (account === did || account === u.irc.did))) return true;
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
    const added = !f.channels.has(lower(channel));
    f.channels.set(lower(channel), channel);
    f.stale?.delete(lower(channel));
    if (!f.peer) this.place(f, channel);
    else this.describe(f);
    if (added) this.changed();
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
      // Keep clear of everyone in the office, not just other freeq people.
      const at = spotIn(zoneById(zoneId), [...this.office.peers.values()].filter((q) => q.ready && q !== f.peer));
      f.active = ch;
      if (f.peer) {
        f.peer.freeqZone = zoneId;
        this.office.moveRemote(f.peer, at.x, at.y);
      } else {
        f.peer = this.office.addRemote({ name: f.nick, kind: 'freeq', ...at, freeqZone: zoneId });
      }
      this.changed();
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
    f.stale?.delete(lower(channel));
    this.changed();
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
      case '366': return this.settle(m.params[1]); // end of NAMES
      case 'JOIN': return void this.person(m.params[0], m.nick, account || (m.params[1] && m.params[1] !== '*' ? m.params[1] : null));
      case 'PART': return this.dropChannel(m.nick, m.params[0]);
      case 'KICK': return this.dropChannel(m.params[1], m.params[0]);
      case 'QUIT': {
        const f = this.people.get(lower(m.nick));
        if (f) { this.people.delete(lower(m.nick)); if (f.peer) this.office.removeRemote(f.peer); this.changed(); }
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
        if (!channel?.startsWith('#') || !text) return;
        return this.heard(channel, m.nick, account, text, { ts: tagSeconds(m.tags.time), msgid: m.tags.msgid || null });
      }
    }
  }

  // A channel message, live or (backfill) from history after a restart.
  heard(channel, nick, account, text, { ts, msgid = null, backfill = false }) {
    // Remember it even when it's ours, so catch-up never replays it.
    if (!this.seen.hear(channel, ts, msgid)) return;
    this.saver.soon();
    if (!nick || this.isOurs(nick, account)) return;
    const zoneId = this.zoneFor(channel);
    if (!zoneId) return;
    const action = text.match(/^\u0001ACTION (.*)\u0001$/);
    if (/^\u0001/.test(text) && !action) return; // other CTCP
    let f = this.people.get(lower(nick));
    if (!backfill) {
      this.person(channel, nick, account);
      // Speaking somewhere makes it where they are.
      f = this.people.get(lower(nick));
      if (f && lower(f.active) !== lower(channel)) this.place(f, channel);
    }
    this.touch(this.bindings.get(zoneId), backfill ? ts * 1000 : Date.now());
    this.office.remoteChat({
      zoneId, channel, peer: f?.peer?.freeqZone === zoneId ? f.peer : null, name: nick,
      text: action ? `* ${nick} ${action[1]}` : text, ...(backfill ? { ts: ts * 1000, backfill: true } : {}),
    });
  }

  // ---- office people talking on freeq --------------------------------------

  // Called by the office for chat said inside an attached area. Returns a
  // note for the speaker when it couldn't go to freeq, else null.
  async relay(p, zoneId, text) {
    const b = this.bindings.get(zoneId);
    if (!b) return null;
    if (p.kind === 'human' ? !p.did : p.kind !== 'agent') return `Only signed-in people and agents can talk on freeq; this stayed in the office.`;
    try {
      const u = await this.userConnection(p);
      u.used = Date.now();
      u.irc.join(b.channel);
      u.irc.say(b.channel, text);
      this.touch(b);
      return null;
    } catch (e) {
      this.log(`freeq: ${p.handle || p.did} couldn't send to ${b.channel}: ${e.message}`);
      return `Your message stayed in the office, it didn't reach ${b.channel} on freeq: ${e.message}`;
    }
  }

  // Tell a person (every tab they have open) how their freeq connection is doing.
  notify(key, text, ok = false) {
    for (const q of this.office.peers.values()) if (q.kind !== 'freeq' && this.keyOf(q) === key) this.office.sendTo(q, { t: 'freeq-note', text, ok });
  }

  // Whose freeq connection a peer uses: their DID, or agent:<name> for agents without one.
  keyOf(p) { return p.did || `agent:${p.name}`; }

  // An agent that signed in with a bearer token (MCP Authorization header or
  // roost_sign_in) talks on freeq as its own DID with it (method pds-session).
  // Kept in memory only, for as long as this process lives.
  rememberAgentToken(did, token, pds) {
    if (did && token && pds) this.agentTokens.set(did, { did, token, pds: pds.replace(/\/$/, '') });
  }

  // How a peer signs in to freeq: people with their OAuth session; agents
  // with their token, else a did:key of their own derived from the office's
  // key and their identity (so it's the same one every time).
  async responderFor(p, key) {
    if (p.kind === 'human') {
      if (!this.auth?.freeqCredentials) throw new Error('sign-in tokens are not available');
      const creds = (nonce) => this.auth.freeqCredentials(p.did, nonce);
      await creds(null); // fail early (and warm the PDS's DPoP nonce) before opening a socket
      return { respond: oauthResponder(creds), as: p.did };
    }
    const tok = p.did && this.agentTokens.get(p.did);
    if (tok) return { respond: sessionResponder(tok), as: p.did };
    if (!this.secret) throw new Error('the freeq listener is not connected yet');
    const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`agentoffice freeq agent\n${this.secret}\n${key}`)));
    const id = await identityFromSeed(seed);
    return { respond: cryptoResponder(id), as: id.did };
  }

  // Replies on a person's own connection that mean a message didn't land.
  onUserLine(did, m) {
    const last = m.params[m.params.length - 1] || '';
    const code = Number(m.command);
    if (m.command === 'FAIL' || (code >= 400 && code < 600 && code !== 433)) {
      this.log(`freeq: ${did}: ${m.command} ${m.params.join(' ')}`);
      const what = m.params.slice(1, -1).filter(Boolean).join(' ');
      this.notify(did, `freeq said no${what ? ` (${what})` : ''}: ${last}`);
    }
  }

  async userConnection(p) {
    const did = this.keyOf(p);
    let u = this.users.get(did);
    if (u && !u.irc.closed) { await u.ready; return u; }
    const { respond, as } = await this.responderFor(p, did);
    const irc = new IrcClient({
      url: this.url, openSocket: this.openSocket, nick: ircNick(p.kind === 'agent' ? p.name : p.handle || p.name), respond,
      onLine: (m) => this.onUserLine(did, m),
      onClose: (why) => {
        if (this.users.get(did)?.irc !== irc) return;
        this.users.delete(did);
        if (irc.registered && why !== 'closed') this.notify(did, `Your freeq connection dropped (${why}); the next thing you say reconnects.`);
      },
    });
    // Never wait forever on a sign-in freeq doesn't finish.
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('freeq didn\'t finish signing you in within 20 seconds')), 20000); });
    u = { irc, used: Date.now(), ready: Promise.race([irc.open(), timeout]).finally(() => clearTimeout(timer)) };
    this.users.set(did, u);
    if (!this.sweeper) this.sweeper = setInterval(() => this.sweep(), 60000);
    try {
      const who = await u.ready;
      this.notify(did, `Talking on freeq as ${who.nick}${who.did && who.did !== as ? ` (freeq says you're ${who.did}, not ${as})` : as !== p.did ? ` (${as})` : ''}.`, true);
    } catch (e) {
      this.users.delete(did);
      irc.close('sign-in failed');
      throw e;
    }
    return u;
  }

  // Someone left the office, or went quiet for a long time: hang up for them.
  leave(p) {
    const key = this.keyOf(p);
    const u = this.users.get(key);
    if (u && ![...this.office.peers.values()].some((q) => q !== p && q.kind !== 'freeq' && this.keyOf(q) === key)) {
      this.users.delete(key);
      u.irc.close('left the office');
    }
  }

  sweep() {
    for (const [did, u] of this.users) if (Date.now() - u.used > USER_IDLE_MS) { this.users.delete(did); u.irc.close('idle'); }
    if (!this.users.size) { clearInterval(this.sweeper); this.sweeper = null; }
  }
}

// The rules hash an ACCEPT requirement asks for, anywhere in the tree.
function findAccept(r, depth = 0) {
  if (!r || depth > 8) return null;
  if (String(r.type).toUpperCase() === 'ACCEPT') return r.hash || null;
  for (const x of r.requirements || []) { const h = findAccept(x, depth + 1); if (h) return h; }
  return r.requirement ? findAccept(r.requirement, depth + 1) : null;
}

// "lounge=#general, open=#dev" -> Map(zoneId -> channel)
export function parseRooms(s) {
  const out = new Map();
  for (const part of String(s || '').split(',')) {
    const [z, ch] = part.split('=').map((x) => x?.trim());
    if (z && ch && zoneById(z)) out.set(z, ch.startsWith('#') ? ch : `#${ch}`);
  }
  return out;
}
