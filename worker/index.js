// Cloudflare Workers entry. Static files in public/ are served by Workers
// static assets before this code runs; everything else (the /ws socket and
// the /api routes) goes to one Durable Object that holds the office.

import { DurableObject } from 'cloudflare:workers';
import { Office } from '../server/office.js';
import { handleApi } from '../server/app.js';
import { loadActor } from '../server/atproto.js';
import { createAuth } from '../server/auth.js';
import { AgentAuth } from '../server/agentauth.js';
import { McpHub } from '../server/mcp.js';
import { FreeqBridge, FREEQ_URL } from '../server/freeq.js';
import { SESSION_TTL_MS } from '../server/auth.js';

const HEARTBEAT_MS = 60 * 1000;
const MCP_SESSION_TTL_MS = 10 * 60 * 1000; // matches the hub's idle drop

export default {
  async fetch(request, env) {
    const stub = env.OFFICE.get(env.OFFICE.idFromName('main'));
    return stub.fetch(request);
  },
};

export class OfficeRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS strokes (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS actors (did TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS oauth (k TEXT PRIMARY KEY, v TEXT, at INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS mcp_sessions (k TEXT PRIMARY KEY, v TEXT, at INTEGER)');
    // Whiteboard strokes get one row each, so a save only writes what changed.
    this.strokeRows = new WeakMap();

    const saved = {};
    for (const { k, v } of this.sql.exec('SELECT k, v FROM kv')) saved[k] = JSON.parse(v);
    saved.strokes = [];
    for (const { id, data } of this.sql.exec('SELECT id, data FROM strokes ORDER BY id')) {
      const s = JSON.parse(data);
      this.strokeRows.set(s, id);
      saved.strokes.push(s);
    }
    this.office = new Office(saved, {
      onChange: () => this.scheduleSave(),
      loadActor: env.OFFLINE ? null : loadActor,
    });

    // Agents: DID proof / Roost sign-in, and the MCP endpoint. MCP sessions
    // live in memory but are noted in storage, so after a deploy or eviction
    // an agent's next request resumes its session and puts it back in the office.
    this.agents = new AgentAuth({ office: env.OFFICE_NAME || 'agent office' });
    this.mcp = new McpHub({ office: this.office, auth: this.agents, token: env.MCP_TOKEN || '', store: this.sqlStore('mcp', MCP_SESSION_TTL_MS, 'mcp_sessions') });

    // freeq: populated IRC channels attached to office areas (FREEQ=off to disable).
    if (env.FREEQ !== 'off') {
      this.freeq = new FreeqBridge({
        office: this.office,
        // Talking as yourself needs your stored OAuth session, so the auth
        // object (built on the first request) is looked up when needed.
        // After a hibernation wake-up the auth object hasn't been built yet
        // (only HTTP requests build it), so rebuild it from the last origin seen.
        auth: { freeqCredentials: (did, nonce) => this.authForFreeq().freeqCredentials(did, nonce) },
        url: env.FREEQ_URL || FREEQ_URL,
        rooms: env.FREEQ_ROOMS || '',
        minMembers: Number(env.FREEQ_MIN_MEMBERS) || 2,
        openSocket: openOutboundSocket,
        keyStore: {
          get: async () => { const row = this.sql.exec("SELECT v FROM meta WHERE k = 'freeq-key'").toArray()[0]; return row && JSON.parse(row.v); },
          set: async (jwk) => { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('freeq-key', ?)", JSON.stringify(jwk)); },
        },
      });
    }

    // Waking from hibernation or a restart (deploys, evictions): rebuild
    // peers from the sockets that stayed open, and if anyone is here, bring
    // the freeq listener back now rather than on their next message.
    for (const ws of ctx.getWebSockets()) this.peerFor(ws);
    this.freeq?.presence();
    this.arm();
  }

  // One alarm does two jobs, even while the object hibernates: the next room
  // booking event (reminders, start/end announcements), and while anyone is
  // in, a heartbeat that restarts a freeq listener lost to an eviction.
  arm() {
    const here = [...this.office.peers.values()].some((p) => p.ready && p.kind !== 'freeq');
    const t = Math.min(this.office.nextRoomEvent() || Infinity, this.freeq && here ? Date.now() + HEARTBEAT_MS : Infinity);
    if (t === Infinity) return;
    // Keep an alarm that's already due sooner, so the heartbeat isn't pushed back forever.
    if (this.alarmAt > Date.now() && this.alarmAt <= t) return;
    this.alarmAt = t;
    this.ctx.storage.setAlarm(t);
  }

  async alarm() {
    this.alarmAt = null;
    this.office.tickRooms();
    this.freeq?.presence();
    this.arm();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const auth = this.authFor(url);
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      // Refuse sockets opened by other sites riding on the visitor's cookie.
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return new Response('forbidden', { status: 403 });
      const did = (await auth.didFromCookie(request.headers.get('cookie'))) || this.agents.redeem(url.searchParams.get('grant'))?.did || null;
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      this.persistPeer(this.office.open(server, { did }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return (await handleApi(request, { office: this.office, auth, agents: this.agents, mcp: this.mcp })) || new Response('not found', { status: 404 });
  }

  // OAuth client, built on first request. PUBLIC_URL pins the public origin;
  // without it a deployed Worker uses the origin it was reached on, and
  // localhost (wrangler dev) uses the AT Protocol loopback client.
  authForFreeq() {
    if (this.auth) return this.auth;
    const row = this.sql.exec("SELECT v FROM meta WHERE k = 'origin'").toArray()[0];
    if (!row && !this.env.PUBLIC_URL) throw new Error('the office has no sign-in setup yet; reload the page');
    return this.authFor(new URL(this.env.PUBLIC_URL || row.v));
  }

  authFor(url) {
    if (this.auth) return this.auth;
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('origin', ?)", url.origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    this.auth = createAuth({
      publicUrl: this.env.PUBLIC_URL || (local ? undefined : url.origin),
      port: Number(url.port) || 8787,
      secret: this.env.SESSION_SECRET || this.sessionSecret(),
      stateStore: this.sqlStore('state', 15 * 60 * 1000),
      sessionStore: this.sqlStore('session', SESSION_TTL_MS),
    });
    return this.auth;
  }

  // Cookie-signing key when SESSION_SECRET isn't set: made once, kept in storage.
  sessionSecret() {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = 'session-secret'").toArray()[0];
    if (row) return row.v;
    const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('session-secret', ?)", secret);
    return secret;
  }

  // OAuth state must survive the object being evicted between login and callback.
  sqlStore(prefix, ttlMs, table = 'oauth') {
    const sql = this.sql;
    return {
      async set(k, v) { sql.exec(`INSERT OR REPLACE INTO ${table} (k, v, at) VALUES (?, ?, ?)`, `${prefix}:${k}`, JSON.stringify(v), Date.now()); },
      async get(k) {
        sql.exec(`DELETE FROM ${table} WHERE k LIKE ? AND at < ?`, `${prefix}:%`, Date.now() - ttlMs);
        const row = sql.exec(`SELECT v, at FROM ${table} WHERE k = ?`, `${prefix}:${k}`).toArray()[0];
        if (!row || Date.now() - row.at > ttlMs) return undefined;
        return JSON.parse(row.v);
      },
      async del(k) { sql.exec(`DELETE FROM ${table} WHERE k = ?`, `${prefix}:${k}`); },
    };
  }

  // Each socket's attachment carries its peer, keyed by id, so the peer can
  // be found again (or rebuilt after hibernation) from the socket alone.
  peerFor(ws) {
    const snap = ws.deserializeAttachment();
    if (!snap) return null;
    let p = this.office.peers.get(snap.id);
    if (!p) {
      const row = snap.did && this.sql.exec('SELECT v FROM actors WHERE did = ?', snap.did).toArray()[0];
      p = this.office.open(ws, { did: snap.authDid, restored: { ...snap, actor: row ? JSON.parse(row.v) : null } });
    }
    p.ws = ws;
    return p;
  }

  // Attachments are capped at 2 KB, so the character (sprite URLs, stats,
  // bio) goes to storage by DID and the attachment keeps the small stuff.
  persistPeer(p) {
    const { actor, chatTimes, ...snap } = this.office.snapshot(p);
    if (actor && p.did && !p.actorSaved) {
      this.sql.exec('INSERT OR REPLACE INTO actors (did, v) VALUES (?, ?)', p.did, JSON.stringify(actor));
      p.actorSaved = true;
    }
    try { p.ws.serializeAttachment(snap); } catch (e) { console.error('peer attachment', e.message); }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 256 * 1024) return;
    const p = this.peerFor(ws);
    if (!p) return;
    await this.office.message(p, raw);
    this.persistPeer(p);
    // After hibernation the freeq listener is gone; the next message brings it back.
    this.freeq?.presence();
    this.arm();
  }

  webSocketClose(ws) {
    const p = this.peerFor(ws);
    if (p) this.office.leave(p);
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  save() {
    const state = this.office.persisted();
    // Everything office.persisted() returns is one JSON row, except strokes.
    for (const k of Object.keys(state)) if (k !== 'strokes') this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, JSON.stringify(state[k]));
    const live = new Set();
    for (const s of state.strokes) {
      let id = this.strokeRows.get(s);
      if (id === undefined) {
        id = this.sql.exec('INSERT INTO strokes (data) VALUES (?) RETURNING id', JSON.stringify(s)).one().id;
        this.strokeRows.set(s, id);
      }
      live.add(id);
    }
    // Strokes trimmed off the front, or a cleared board.
    const first = Math.min(...live);
    if (!live.size) this.sql.exec('DELETE FROM strokes');
    else this.sql.exec('DELETE FROM strokes WHERE id < ?', first);
  }
}

// Outbound WebSocket from the Durable Object (to freeq): a fetch upgrade,
// accepted here, which behaves like a browser WebSocket afterwards.
async function openOutboundSocket(url) {
  const res = await fetch(url.replace(/^ws/, 'http'), { headers: { upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`freeq didn't accept a WebSocket (HTTP ${res.status})`);
  ws.accept();
  return ws;
}
