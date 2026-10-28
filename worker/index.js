// Cloudflare Workers entry. Static files in public/ are served by Workers
// static assets before this code runs; everything else (the /ws socket and
// the /api routes) goes to the World, the Durable Object that holds the
// sockets. Every entity (actors, rooms, desks, the whiteboard, topics…) is
// its own Durable Object too, see worker/entities.js.

import { DurableObject } from 'cloudflare:workers';
import { Office } from '../server/office.js';
import { handleApi } from '../server/app.js';
import { loadActor } from '../server/atproto.js';
import { createAuth } from '../server/auth.js';
import { AgentAuth } from '../server/agentauth.js';
import { McpHub } from '../server/mcp.js';
import { FreeqBridge, FREEQ_URL } from '../server/freeq.js';
import { SESSION_TTL_MS } from '../server/auth.js';
import { DORuntime } from './entities.js';

export { ActorDO, RoomDO, ItemDO, TopicDO } from './entities.js';

const HEARTBEAT_MS = 60 * 1000;
const GHOST_MS = 10 * 60 * 1000; // a socket silent this long (browsers ping every 30 s) is a ghost
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

    const saved = {};
    for (const { k, v } of this.sql.exec('SELECT k, v FROM kv')) saved[k] = JSON.parse(v);
    // Before entities, the whiteboard lived here (kv and strokes are kept,
    // untouched, as a backup; the entities have their own copies now).
    if (!saved.migrated) saved.strokes = this.sql.exec('SELECT data FROM strokes ORDER BY id').toArray().map((r) => JSON.parse(r.data));
    // The World's copy of what each entity shows, kept so waking from
    // hibernation doesn't mean asking every entity again.
    this.sql.exec('CREATE TABLE IF NOT EXISTS mirror (k TEXT PRIMARY KEY, v TEXT)');
    const mirror = saved.migrated ? this.sql.exec('SELECT k, v FROM mirror').toArray().map((r) => [r.k, JSON.parse(r.v)]) : [];
    this.mirrorDirty = new Set();
    this.runtime = new DORuntime(env);
    this.office = new Office(saved, {
      onChange: () => this.scheduleSave(),
      loadActor: env.OFFLINE ? null : loadActor,
      runtime: this.runtime,
      mirror,
      onMirror: (k) => { this.mirrorDirty.add(k); this.scheduleSave(); },
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
        // Who was in which channel and the last message heard, so a restart
        // doesn't redraw everyone and missed messages get caught up.
        stateStore: {
          get: async () => { const row = this.sql.exec("SELECT v FROM meta WHERE k = 'freeq-state'").toArray()[0]; return row && JSON.parse(row.v); },
          set: async (snap) => { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('freeq-state', ?)", JSON.stringify(snap)); },
        },
      });
    }

    // Waking from hibernation or a restart (deploys, evictions): rebuild
    // peers from the sockets that stayed open, and if anyone is here, bring
    // the freeq listener back now rather than on their next message.
    for (const ws of ctx.getWebSockets()) this.peerFor(ws, { rebuild: true });
    // Browsers ping to show they're alive; answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    this.freeq?.presence();
    this.arm();
  }

  // Durable Object RPC from entities: the World's side of the messaging layer.
  async invoke(address, method, args = []) {
    if (address !== 'world:main') throw new Error(`this is the world, not ${address}`);
    const api = this.office.worldApi();
    if (!api[method]) throw new Error(`the world has no method ${method}`);
    return api[method](...args);
  }

  // While anyone is in, a heartbeat alarm restarts a freeq listener lost to
  // an eviction, even while the object hibernates. (Rooms, pomodoro timers
  // and other entities keep their own alarms.)
  arm() {
    const here = [...this.office.peers.values()].some((p) => p.ready && p.kind !== 'freeq');
    if (!this.freeq || !here) return;
    const t = Date.now() + HEARTBEAT_MS;
    // Keep an alarm that's already due sooner, so the heartbeat isn't pushed back forever.
    if (this.alarmAt > Date.now() && this.alarmAt <= t) return;
    this.alarmAt = t;
    this.ctx.storage.setAlarm(t);
  }

  async alarm() {
    this.alarmAt = null;
    this.reapGhosts();
    this.freeq?.presence();
    this.arm();
  }

  async fetch(request) {
    await this.office.ready;
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
      sessionStore: this.actorSessionStore(),
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

  // Each person's OAuth session lives in their actor's Durable Object.
  // Sessions saved here before that move over on first use.
  actorSessionStore() {
    const legacy = this.sqlStore('session', SESSION_TTL_MS);
    const actor = (did) => this.runtime.ref(`actor:${did}`);
    return {
      async set(did, v) { await actor(did).sessionSet(v); },
      async get(did) {
        const v = await actor(did).sessionGet(SESSION_TTL_MS);
        if (v !== undefined) return v;
        const old = await legacy.get(did);
        if (old !== undefined) { await actor(did).sessionSet(old); await legacy.del(did); }
        return old;
      },
      async del(did) { await actor(did).sessionDel(); await legacy.del(did); },
    };
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

  // Sockets whose other end is gone without a close (a laptop lid, a dead
  // network) would otherwise stand in the office for good.
  reapGhosts() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const p = this.peerFor(ws);
      if (!p) continue;
      const last = Math.max(p.lastSeen || p.joinedAt || 0, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0);
      if (now - last < GHOST_MS) continue;
      try { ws.close(1001, 'gone quiet'); } catch { /* already closed */ }
      this.office.leave(p);
    }
  }

  // Each socket's attachment carries its peer, keyed by id, so the peer can
  // be found again from the socket alone. Only on wake-up (`rebuild`) is a
  // missing peer rebuilt from it; later, a missing peer means the office
  // already let it go (replaced by a newer connection, or reaped), and it
  // mustn't come back as a ghost.
  peerFor(ws, { rebuild = false } = {}) {
    const snap = ws.deserializeAttachment();
    if (!snap) return null;
    let p = this.office.peers.get(snap.id);
    if (!p) {
      if (!rebuild) return null;
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
    if (!p) { try { ws.close(1008, 'not in the office'); } catch { /* already closed */ } return; }
    p.lastSeen = Date.now();
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

  // The World's own state is small now (one JSON row per key); everything
  // else is kept by the entities.
  save() {
    const state = this.office.persisted();
    for (const k of Object.keys(state)) this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, JSON.stringify(state[k]));
    for (const k of this.mirrorDirty) this.sql.exec('INSERT OR REPLACE INTO mirror (k, v) VALUES (?, ?)', k, JSON.stringify(this.office.mirror.get(k) ?? null));
    this.mirrorDirty.clear();
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
