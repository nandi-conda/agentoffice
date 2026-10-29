// MCP server for agents, mounted at /mcp (Streamable HTTP transport).
//
// Each MCP session is one agent in the office. It joins through an
// in-process socket that speaks the exact WebSocket protocol the browser
// uses, so there is one tool per client message (hello, move, chat, status,
// emote, desk, pomo, wb, note, coffee, score, wave, audio, rtc) plus
// higher-level helpers (walk_to, take_desk, look), and every server message
// (welcome, join, leave, move, peer, chat, desks, pomo, wb, notes, scores,
// counters, wave, toast, rtc, error) is streamed back:
//
//   - as `notifications/message` log notifications on the session's SSE stream
//   - as `notifications/resources/updated` for the subscribable office://events
//   - and through the read_events tool, which long-polls for clients that
//     don't surface notifications to the model.
//
// The HTTP side is fetch-shaped (Request in, Response out) and uses only web
// APIs plus node:events, so the same hub runs under Node (server/index.js
// adapts req/res) and inside a Cloudflare Worker / Durable Object
// (nodejs_compat) next to the Office.

import { EventEmitter } from 'node:events';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentClient } from '../scripts/agent-sdk.mjs';
import { ZONES, FURNITURE, SEATS, DESKS, zoneAt, canHear, SPAWN } from '../public/js/map.js';
import { ROOST_URL, PROOF_COLLECTION } from './agentauth.js';
import { ROOMS, roomStatus } from '../public/js/rooms.js';
import { isoize } from '../public/js/time.js';
import { describeApi, generatedTools } from './apidoc.js';
import { atLeast, can } from '../public/js/roles.js';
import { LEVELS, LogBuffer, log } from './logs.js';

const CLIENT_TYPES = ['hello', 'move', 'chat', 'status', 'emote', 'desk', 'pomo', 'wb', 'note', 'coffee', 'score', 'wave', 'audio', 'rtc', 'book', 'av', 'use', 'inv', 'ping'];
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const MAX_EVENTS = 300;
const IDLE_MS = 10 * 60 * 1000; // drop agents that stop calling in
const later = (fn) => setTimeout(fn, 0);
const STATUSES = ['available', 'focus', 'meeting', 'away', 'coffee'];

// A connected pair of ws-shaped objects: one end goes to Office.connect, the
// other to AgentClient. Delivery is async, like a real socket.
export function socketPair() {
  const a = new EventEmitter(), b = new EventEmitter();
  for (const [me, peer] of [[a, b], [b, a]]) {
    me.readyState = 1;
    me.send = (s) => { if (me.readyState === 1) later(() => peer.readyState === 1 && peer.emit('message', s)); };
    me.close = () => {
      if (me.readyState !== 1) return;
      me.readyState = peer.readyState = 3;
      later(() => { me.emit('close'); peer.emit('close'); });
    };
  }
  later(() => b.emit('open'));
  return { server: a, client: b };
}

const json = (v) => ({ content: [{ type: 'text', text: isoize(JSON.stringify(v, null, 1)) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: isoize(msg) }], isError: true });
const round = (n) => Math.round(n * 10) / 10;

// Compact what the model sees; whiteboard strokes are summarised.
// `client` is null for read-only observers, who see office-wide broadcasts.
function shapeEvent(m, client, office) {
  const name = (id) => client?.peers.get(id)?.name || (id === client?.me?.id ? 'you' : office.peers.get(id)?.name || id);
  switch (m.t) {
    case 'chat': return { type: 'chat', from: m.name, fromId: m.id, text: m.text, scope: m.scope, mention: !!(m.mention || client?.mentions(m.text)) };
    case 'join': return { type: 'join', id: m.peer.id, name: m.peer.name, kind: m.peer.kind, handle: m.peer.handle, did: m.peer.did };
    case 'leave': return { type: 'leave', id: m.id, name: client?.lastNames.get(m.id) || m.lastName || m.id };
    case 'move': return { type: 'move', id: m.id, name: name(m.id), x: round(m.x), y: round(m.y), zone: zoneAt(m.x, m.y)?.id };
    case 'wb': return m.op === 'clear' ? { type: 'wb', op: 'clear' } : m.op === 'set' ? { type: 'wb', op: 'set', strokes: m.strokes?.length || 0 } : { type: 'wb', op: 'stroke', by: m.stroke?.by, color: m.stroke?.color, points: m.stroke?.points?.length };
    case 'wave': return { type: 'wave', from: m.name, fromId: m.from, kind: m.kind };
    case 'peer': { const { t, ...rest } = m; return { type: 'peer', name: name(m.id), ...rest }; }
    case 'bookings': return { type: 'bookings', upcoming: m.bookings.filter((b) => b.end > Date.now()).length, tip: 'call rooms for the schedule' };
    default: { const { t, ...rest } = m; for (const k of ['text', 'message']) if (typeof rest[k] === 'string') rest[k] = isoize(rest[k]); return { type: t, ...rest }; }
  }
}

class AgentSession {
  constructor(hub) {
    this.hub = hub;
    this.events = [];
    this.seq = 0;
    this.waiters = new Set();
    this.client = null;
    this.identity = null; // { did, handle } after AT Protocol sign-in
    this.operator = false; // connected with MCP_TOKEN
    this.oauth = false; // signed in through the office's OAuth (mcpauth.js): every request carries the token
    this.subscribed = false;
    this.verbose = false; // stream move events too
    this.logStream = null; // { filter, off } while streaming server logs
    this.logsSubscribed = false; // office://logs
    this.touch();
  }

  touch() { this.lastSeen = Date.now(); }

  push(m) {
    const ev = { seq: ++this.seq, ts: Date.now(), ...shapeEvent(m, this.client, this.hub.office) };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const w of this.waiters) w();
    if (ev.type === 'move' && !this.verbose) return;
    const level = ev.type === 'error' ? 'warning' : ev.mention || ev.type === 'wave' ? 'notice' : 'info';
    this.mcp?.server.sendLoggingMessage({ level, logger: 'office', data: ev }).catch(() => {});
    if (this.subscribed) this.mcp?.server.sendResourceUpdated({ uri: 'office://events' }).catch(() => {});
  }

  get joined() { return !!this.client?.me && this.client.ws?.readyState === 1; }

  // Acting in the office needs a proven identity (Roost / AT Protocol) or
  // the operator token; without either, a session is a read-only observer.
  // So are the banned.
  get canAct() { return (!!this.identity?.did || this.operator) && this.role !== 'banned'; }

  // The session's server role (public/js/roles.js): observer until it signs
  // in, then whatever its DID has (agent by default); the operator token is an owner.
  get role() { return this.hub.office.roleFor({ did: this.identity?.did || null, operator: this.operator }); }

  // Only list the tools this session may use; the client hears
  // tools/list_changed when that changes (sign-in, a role granted or revoked).
  refreshTools() {
    for (const [reg, show] of this.tools || []) {
      const on = !!show(this);
      if (on !== reg.enabled) on ? reg.enable() : reg.disable();
    }
  }

  async join({ name, note = '', status }) {
    if (!this.canAct) throw new Error(SIGN_IN_HELP);
    if (this.client) this.client.close();
    const { server, client } = socketPair();
    // Same rule as browsers: the DID comes only from a completed sign-in.
    this.hub.office.connect(server, { did: this.identity?.did || null, operator: this.operator });
    const bot = new AgentClient({ name, note, socket: () => client });
    bot.lastNames = new Map();
    this.client = bot;
    const origTrack = bot.track.bind(bot);
    bot.track = (m) => {
      if (m.t === 'leave') bot.lastNames.set(m.id, bot.peers.get(m.id)?.name);
      origTrack(m);
      if (m.t !== 'welcome' && m.t !== 'pong') this.push(m);
    };
    bot.on('close', () => { if (this.client === bot) this.push({ t: 'toast', text: 'you left the office' }); });
    let timer;
    try {
      await Promise.race([bot.connect(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('join timed out')), 15000); })]);
    } finally { clearTimeout(timer); }
    if (status) bot.status(status, note);
    this.joinedAs = { name, note, status };
    this.hub.persist(this);
    return bot;
  }

  need() {
    if (!this.joined) throw new Error('not in the office yet: call join_office first');
    return this.client;
  }

  async wait(since, ms) {
    const ready = () => this.events.some((e) => e.seq > since && (e.type !== 'move' || this.verbose));
    if (ready() || ms <= 0) return;
    await new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(check); resolve(); };
      const check = () => { if (ready()) done(); };
      const t = setTimeout(done, ms);
      this.waiters.add(check);
    });
  }

  close() {
    this.logStream?.off();
    this.logStream = null;
    this.client?.close();
    this.client = null;
    this.joinedAs = null;
    this.hub.persist(this);
    for (const w of this.waiters) w();
  }
}

export class McpHub {
  // store (optional): { get(id), set(id, json), del(id) }, where get() returns
  // what set() was given, or nothing once IDLE_MS has passed. With one,
  // sessions outlive a restart of the process or Durable Object: the agent's
  // next request picks its session up again and puts it back in the office.
  // logDids: DIDs that may read the server logs without the admin role
  // (LOG_DIDS, comma-separated, or a list). Admins and owners always may
  // (public/js/roles.js), and so do operators with MCP_TOKEN, who are owners.
  // oauth (optional): the office's OAuth server for MCP clients (mcpauth.js).
  // With it, /mcp needs credentials (a 401 starts the client's OAuth flow)
  // and read-only observers connect to /mcp/public instead.
  constructor({ office, auth, oauth = null, token = globalThis.process?.env?.MCP_TOKEN || '', store = null, logDids = globalThis.process?.env?.LOG_DIDS ?? '' }) {
    Object.assign(this, { office, auth, oauth, token, store });
    this.logDids = new Set((Array.isArray(logDids) ? logDids : String(logDids).split(',')).map((d) => d.trim()).filter(Boolean));
    this.sessions = new Map(); // mcp session id -> { transport, agent }
    // Observers (sessions that haven't joined) get the office-wide
    // broadcasts: joins, leaves, shouts, desks, notes, bookings, pomodoro…
    const broadcast = office.broadcast.bind(office);
    office.broadcast = (msg, except) => {
      broadcast(msg, except);
      if (!this.sessions.size) return;
      if (msg.t === 'leave') msg = { ...msg, lastName: this.lastNames?.get(msg.id) };
      for (const { agent } of this.sessions.values()) if (!agent.joined) agent.push(msg);
    };
    const leave = office.leave.bind(office);
    office.leave = (p) => { (this.lastNames ||= new Map()).set(p.id, p.name); if (this.lastNames.size > 500) this.lastNames.clear(); leave(p); };
    // Someone's role changed: every session lists what it may use now.
    office.onRoles?.(() => { for (const { agent } of this.sessions.values()) agent.refreshTools(); });
  }

  // The one access check for gated capabilities, by the session's server
  // role (public/js/roles.js CAPS). 'logs': the server logs (logs_tail,
  // logs_stream, office://logs), also for DIDs in LOG_DIDS.
  can(agent, capability) {
    if (can(agent.role, capability)) return true;
    if (capability === 'logs') return !!agent.identity?.did && agent.role !== 'banned' && this.logDids.has(agent.identity.did);
    return false;
  }

  sweep() {
    for (const [id, s] of this.sessions) if (Date.now() - s.agent.lastSeen > IDLE_MS) { s.transport.close(); this.drop(id); }
  }

  drop(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.agent.close();
    this.store?.del(id);
  }

  // Save what a session needs to come back after a restart: who it signed
  // in as, and whether (and as whom) it was in the office.
  persist(agent) {
    if (!this.store || !agent.sid || !this.sessions.has(agent.sid)) return;
    const v = JSON.stringify({ identity: agent.identity, operator: agent.operator, oauth: agent.oauth, joined: agent.joinedAs || null });
    if (v === agent.saved && Date.now() - agent.savedAt < 60000) return;
    agent.saved = v; agent.savedAt = Date.now();
    this.store.set(agent.sid, v);
  }

  // An agent's GET stream and its next POST can both arrive after a restart;
  // they share one restored session.
  restore(sid) {
    if (!this.store) return null;
    this.restoring ||= new Map();
    if (!this.restoring.has(sid)) this.restoring.set(sid, this.revive(sid).finally(() => this.restoring.delete(sid)));
    return this.restoring.get(sid);
  }

  async revive(sid) {
    const row = await this.store?.get(sid);
    if (!row) return null;
    const saved = JSON.parse(row);
    const agent = new AgentSession(this);
    agent.identity = saved.identity || null;
    agent.operator = !!saved.operator;
    agent.oauth = !!saved.oauth;
    const s = await this.open(agent);
    // The client initialized this session before the restart; the SDK has
    // no public way to adopt a session id, so set what initialize would have.
    s.transport.sessionId = sid;
    s.transport._initialized = true;
    agent.sid = sid;
    this.sessions.set(sid, s);
    if (saved.joined) {
      try {
        await agent.join(saved.joined);
        agent.push({ t: 'toast', text: 'the office restarted; you were put back in' });
      } catch (e) {
        agent.push({ t: 'toast', text: `the office restarted and couldn't put you back (${e.message}); call join_office` });
      }
    }
    return s;
  }

  async open(agent) {
    const s = { agent };
    s.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => { agent.sid = id; this.sessions.set(id, s); this.persist(agent); },
    });
    s.transport.onclose = () => s.transport.sessionId && this.drop(s.transport.sessionId);
    agent.mcp = this.build(agent);
    await agent.mcp.connect(s.transport);
    return s;
  }

  // fetch-style handler for POST/GET/DELETE /mcp.
  async fetch(request) {
    this.sweep(); // lazily, so an idle Durable Object has no timers to keep it up
    let body;
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { return rpcError(400, -32700, 'parse error'); }
    }
    const sid = request.headers.get('mcp-session-id');
    const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const url = new URL(request.url);
    // An office OAuth token is checked on every request, so an expired one
    // gets the 401 that makes the client refresh it.
    let granted = null;
    if (this.oauth && this.oauth.isToken(bearer)) {
      granted = await this.oauth.verify(bearer);
      if (!granted) return this.unauthorized(url, body, 'invalid_token', 'access token expired or revoked');
    }
    let s = sid && (this.sessions.get(sid) || await this.restore(sid));
    if (s?.agent.oauth && granted?.did !== s.agent.identity?.did) {
      return this.unauthorized(url, body, 'invalid_token', 'this session needs its OAuth access token');
    }
    if (!s) {
      if (sid) return rpcError(404, -32001, 'unknown session; initialize again');
      if (request.method !== 'POST' || !isInitializeRequest(body)) return rpcError(400, -32000, 'first request must be initialize');
      const agent = new AgentSession(this);
      // Optional credentials, checked once when the session starts:
      //   Authorization: Bearer <Roost token rmcp_… or PDS access token>
      //   X-Atproto-Pds: <PDS URL>   (only for non-Roost tokens)
      //   Authorization: Bearer <MCP_TOKEN>  (operator: may act, as a guest)
      // No header: read-only.
      //   Authorization: Bearer mcpat_…  (from the office's OAuth: the person who signed in)
      // No header: read-only, or with OAuth on, a 401 pointing at it (/mcp/public stays read-only).
      if (granted) {
        agent.identity = { did: granted.did, handle: granted.handle || null };
        agent.oauth = true;
        // Their AT Protocol sign-in is kept, so they talk on freeq as themselves.
        this.office.freeq?.rememberOAuthAgent?.(granted.did);
      } else if (!bearer && this.oauth && url.pathname !== '/mcp/public') {
        return this.unauthorized(url, body, null, 'sign in: this MCP server uses OAuth with your AT Protocol identity (or connect to /mcp/public for read-only)');
      } else if (bearer && this.token && bearer === this.token) agent.operator = true;
      else if (bearer) {
        try {
          const v = await this.auth.roostSignIn({ token: bearer, pds: request.headers.get('x-atproto-pds') || undefined });
          this.auth.redeem(v.grant);
          agent.identity = { did: v.did, handle: v.handle };
          // Kept in memory so the agent can talk on freeq as its own DID.
          this.office.freeq?.rememberAgentToken(v.did, bearer, v.pds);
        } catch (e) {
          log('warning', 'mcp', `sign-in on connect failed: ${e.message}`);
          return Response.json(
            { jsonrpc: '2.0', error: { code: -32001, message: `sign-in failed: ${e.message}. Send a Roost token as Authorization: Bearer rmcp_…, or no Authorization header for read-only access.` }, id: body?.id ?? null },
            { status: 401, headers: { 'www-authenticate': 'Bearer realm="agent office"' } });
        }
      }
      s = await this.open(agent);
      log('info', 'mcp', `session opened (${agent.operator ? 'operator' : agent.identity ? `${agent.identity.handle || ''} ${agent.identity.did}${agent.oauth ? ' via OAuth' : ''}`.trim() : 'read-only'})`);
    }
    s.agent.touch();
    this.persist(s.agent); // at most once a minute unless something changed, which keeps it from expiring
    return s.transport.handleRequest(request, { parsedBody: body });
  }

  unauthorized(url, body, error, message) {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32001, message }, id: body?.id ?? null },
      { status: 401, headers: { 'www-authenticate': this.oauth.challenge(url, error) } });
  }

  build(agent) {
    const mcp = new McpServer(
      { name: 'agent-office', version: '0.1.0' },
      {
        capabilities: { logging: {}, resources: { subscribe: true } },
        instructions: INSTRUCTIONS,
      },
    );
    const office = this.office, auth = this.auth;
    const taken = new Set();
    // Each tool is listed only to sessions that may use it: by role (the
    // least one, public/js/roles.js), or by a check of its own. Read-only
    // tools are for everyone (observers too), the rest need a session that
    // can act, generated ones say their role, and logs ask can().
    agent.tools = [];
    const roleOf = (name, annotations) => (annotations?.readOnlyHint || OPEN_TOOLS.has(name) ? 'observer' : 'guest');
    const tool = (name, description, schema, fn, annotations, show = null) => {
      taken.add(name);
      const role = roleOf(name, annotations);
      const reg = mcp.registerTool(name, { description, inputSchema: schema, ...(annotations ? { annotations } : {}) }, async (args, extra) => {
        agent.touch();
        try { return await fn(args, extra); } catch (e) { return fail(e.message); }
      });
      agent.tools.push([reg, show || ((a) => (role === 'observer' || a.canAct) && atLeast(a.role === 'banned' ? 'observer' : a.role, role))]);
      return reg;
    };
    const signedIn = () => { agent.refreshTools(); this.persist(agent); };
    const progress = (extra) => (done, total) => {
      const token = extra?._meta?.progressToken;
      if (token !== undefined) extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: done, total } }).catch(() => {});
    };
    const send = (msg) => { agent.need().send(msg); };

    // ---- presence ---------------------------------------------------------

    tool('join_office',
      'Enter the office as an agent (protocol `hello`). To appear as your AT Protocol identity (handle, DID, rpg.actor character), sign in first with roost_sign_in or atproto_challenge + atproto_verify; otherwise you join as a guest. Re-joining replaces your current presence.',
      {
        name: z.string().min(1).max(32).describe('Display name; people @mention you by it with spaces removed'),
        note: z.string().max(80).optional().describe('"Working on" note shown on your profile'),
        status: z.enum(STATUSES).optional(),
      },
      async (a) => {
        const bot = await agent.join(a);
        return json({ you: bot.me, zone: zoneAt(bot.me.x, bot.me.y)?.name, signedIn: !!bot.me.did, peopleHere: bot.peers.size, tip: 'call look to see the office, read_events to hear what happens' });
      });

    tool('leave_office', 'Leave the office (closes your connection).', {}, async () => { agent.close(); return json({ ok: true }); });

    tool('look',
      'Describe the office: everyone present (zone, status, note; plus distance and whether they can hear you once you have joined), desks, notice board, pomodoro, counters and named places. Read-only, no sign-in needed.',
      {},
      async () => {
        const c = agent.joined ? agent.client : null, me = c?.me;
        const online = office.summary().online.filter((p) => p.id !== me?.id);
        const people = online.map((p) => ({
          id: p.id, name: p.name, kind: p.kind, handle: p.handle, did: p.did, status: p.status, note: p.note,
          zone: zoneAt(p.x, p.y)?.id, x: round(p.x), y: round(p.y),
          ...(me ? { distance: round(Math.hypot(p.x - me.x, p.y - me.y)), canHearYou: canHear(me, p) } : {}),
        })).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
        const key = me && (me.did || `agent:${me.name}`);
        const mine = key && Object.entries(office.desks).find(([, v]) => v.owner === key)?.[0] || null;
        return json({
          you: me
            ? { id: me.id, name: me.name, handle: me.handle, did: me.did, x: round(me.x), y: round(me.y), zone: zoneAt(me.x, me.y)?.id, status: me.status, note: me.note, desk: mine }
            : { observer: true, signedInAs: agent.identity?.handle || agent.identity?.did || null, canJoin: agent.canAct },
          people,
          desks: { claimed: office.desks, free: DESKS.filter((d) => !office.desks[d.id]).map((d) => d.id) },
          notices: office.notes.map((n) => ({ id: n.id, text: n.text, by: n.by })),
          pomodoro: office.pomoState(), counters: office.counters,
          floor: office.floor.map((e) => ({ id: e.id, item: `${e.item.emoji} ${e.item.name}${e.item.qty > 1 ? ` ×${e.item.qty}` : ''}`, x: round(e.x), y: round(e.y), by: e.by, ...(me ? { distance: round(Math.hypot(e.x - me.x, e.y - me.y)) } : {}) })),
          places: PLACES,
        });
      }, READ_ONLY);

    tool('whoami', 'Your sign-in state and server role: observer (read-only) or signed in as an AT Protocol identity (agent, or a role an admin gave you), and how to sign in. Tools you may not use are not listed; signing in or getting a role lists more.', {},
      async () => json({
        identity: agent.identity, operator: agent.operator, role: agent.role, canAct: agent.canAct, inOffice: agent.joined, canReadLogs: this.can(agent, 'logs'),
        ...(agent.canAct ? {} : { howToSignIn: SIGN_IN_HELP }),
      }), READ_ONLY);

    tool('read_events',
      'Everything that happened since `since`. Before you join (read-only observers): office-wide events (joins, leaves, shouts, desks, notes, bookings, pomodoro, scores). After joining: also chat you could hear, @mentions, joins/leaves, desks, notes, waves, toasts, pomodoro, scores, whiteboard, errors). Waits up to wait_seconds for something new, so loop on it to stay responsive. Pass the returned `next` back as `since`.',
      {
        since: z.number().int().min(0).optional().describe('Last seq you saw; default returns recent events'),
        wait_seconds: z.number().min(0).max(55).optional().describe('Long-poll this long if nothing new (default 20)'),
        types: z.array(z.string()).optional().describe('Only these event types, e.g. ["chat","wave"]'),
        include_moves: z.boolean().optional().describe('Include move events (noisy)'),
      },
      async ({ since, wait_seconds = 20, types, include_moves = false }) => {
        if (include_moves) agent.verbose = true;
        const from = since ?? Math.max(0, agent.seq - 30);
        await agent.wait(from, wait_seconds * 1000);
        let evs = agent.events.filter((e) => e.seq > from && (include_moves || e.type !== 'move'));
        if (types?.length) evs = evs.filter((e) => types.includes(e.type));
        agent.verbose = false;
        return json({ events: evs, next: agent.seq });
      }, READ_ONLY);

    // ---- the protocol, one tool per client message ------------------------

    tool('chat', 'Say something (protocol `chat`). Reaches people who can hear you (proximity, or everyone in your room); @name reaches that person anywhere; shout=true reaches the whole office.',
      { text: z.string().min(1).max(500), shout: z.boolean().optional() },
      async ({ text, shout }) => { send({ t: 'chat', text: shout ? `/shout ${text}` : text }); return json({ ok: true }); });

    tool('move', 'Low-level position update (protocol `move`): at most 6 tiles per call, no walls. Prefer walk_to.',
      { x: z.number(), y: z.number(), dir: z.number().int().min(0).max(3).optional().describe('0 down, 1 left, 2 right, 3 up'), moving: z.boolean().optional() },
      async ({ x, y, dir = 0, moving = false }) => {
        const c = agent.need();
        send({ t: 'move', x, y, dir, moving });
        if (Math.hypot(x - c.me.x, y - c.me.y) <= 6) Object.assign(c.me, { x, y });
        return json({ ok: true, x: c.me.x, y: c.me.y });
      });

    tool('walk_to', 'Run somewhere along the A* path at the same speed browsers run auto-paths (streams progress). `place` can be a zone (open, board, huddle, kitchen, lounge, lobby, focus, booth1-3), furniture (coffee, whiteboard, noticeboard, arcade, pomodoro, vending, desk-7…), a person\'s name/handle/id, or the id of something on the floor (floor_view). Or give x/y in tiles.',
      { place: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
      async ({ place, x, y }, extra) => {
        const c = agent.need();
        const dropped = place && office.floor.find((e) => e.id === place);
        const target = dropped ? { x: dropped.x, y: dropped.y, label: dropped.item.name } : place ? resolvePlace(place, c) : (x !== undefined && y !== undefined ? { x, y, label: `${x},${y}` } : null);
        if (!target) return fail(`don't know where "${place ?? ''}" is; see places in look`);
        const ok = await c.walkTo(target.x, target.y, progress(extra));
        return json({ arrived: ok, at: { x: round(c.me.x), y: round(c.me.y) }, zone: zoneAt(c.me.x, c.me.y)?.name, target: target.label });
      });

    tool('follow', 'Keep running after someone (a person\'s name, handle or id), a tile behind, like the Follow button in a profile. Lasts until they leave, you walk somewhere else, or stop=true. Use follow_me to have your browser avatar follow instead.',
      { person: z.string().max(253).optional(), stop: z.boolean().optional() },
      async ({ person, stop }) => {
        const c = agent.need();
        if (stop || !person) { c.unfollow(); return json({ following: null }); }
        const q = office.findPeer(person);
        if (!q || q.id === c.me.id) return fail(`nobody called ${person} is here`);
        c.follow(q.id);
        return json({ following: { id: q.id, name: q.name }, distance: round(Math.hypot(q.x - c.me.x, q.y - c.me.y)) });
      });

    // Your own avatar (the one your browser shows when it's signed in as the
    // same identity), moved through your actor: no join_office needed, and
    // it doesn't open a second presence.
    tool('move_me', 'Walk the avatar of the identity you are signed in as, the one your browser shows: you watch it walk there on screen. No join_office needed. If you are not in the office, it is where you come back. `place` is a zone, #channel, seat or desk id, furniture id or a person; or give x/y in tiles. teleport=true appears there instead. Moderators may move someone else with `person` (people.move).',
      {
        place: z.string().max(253).optional(), x: z.number().optional(), y: z.number().optional(),
        teleport: z.boolean().optional(), person: z.string().max(253).optional().describe('Someone else (moderators): peer id, name or handle'),
      },
      async ({ place, x, y, teleport, person }) => {
        if (!agent.canAct) return fail(SIGN_IN_HELP);
        let key = agent.identity?.did || null;
        if (person) {
          if (!can(agent.role, 'people.move')) return fail('moving other people needs the moderator role (people.move)');
          const q = office.findPeer(person);
          if (!q) return fail(`nobody called ${person} is here`);
          key = office.ownerKey(q);
        }
        if (!key) return fail('sign in as an AT Protocol identity first: move_me moves the avatar that identity has');
        if (place === undefined && (x === undefined || y === undefined)) return fail('give a place, or x and y');
        const who = { key: agent.identity?.did || 'operator', role: agent.role, name: agent.identity?.handle || 'operator' };
        const r = await office.ref(`actor:${key}`).moveTo(who, { place, x, y, teleport });
        if (r.error) return fail(r.error);
        return json({ ...r, zone: ZONES.find((z) => z.id === r.zone)?.name || r.zone, note: r.online ? (teleport ? 'there now' : 'walking there now') : 'not in the office: that is where they come back' });
      });

    tool('follow_me', 'Have the avatar of the identity you are signed in as (the one your browser shows) follow someone, like pressing Follow on their profile; stop=true stops. Needs you in the office in a browser.',
      { person: z.string().max(253).optional(), stop: z.boolean().optional() },
      async ({ person, stop }) => {
        if (!agent.canAct) return fail(SIGN_IN_HELP);
        const key = agent.identity?.did;
        if (!key) return fail('sign in as an AT Protocol identity first: follow_me moves the avatar that identity has');
        let q = null;
        if (!stop && person) {
          q = office.findPeer(person);
          if (!q || office.ownerKey(q) === key) return fail(`nobody else called ${person} is here`);
        } else if (!stop) return fail('give a person, or stop=true');
        const r = office.followFor(key, q?.id ?? null);
        if (!r.online) return fail('you are not in the office in a browser');
        return json({ following: q ? { id: q.id, name: q.name } : null });
      });

    // Until the World has the agent at that desk, so the next call (a
    // workstation tool, say) finds them there. Gives up after a second.
    const atDesk = async (id) => {
      for (let i = 0; i < 50 && office.deskOf(office.peers.get(agent.client?.me?.id)) !== id; i++) await new Promise((r) => setTimeout(r, 20));
    };

    tool('desk', 'Desk actions (protocol `desk`): claim puts your name and goal on a desk, goal updates it, release frees it. Use take_desk to walk over and claim in one go.',
      { action: z.enum(['claim', 'goal', 'release']), desk: z.string().describe('desk-1…desk-26 or den-*'), goal: z.string().max(80).optional() },
      async ({ action, desk, goal = '' }) => { send({ t: 'desk', action, desk, goal }); return json({ ok: true }); });

    tool('take_desk', 'Find your desk (or a free one), walk up to it and claim it with a goal.',
      { goal: z.string().max(80).optional(), den: z.boolean().optional().describe('Pick a quiet desk in the Deep Work Den') },
      async ({ goal = '', den }, extra) => {
        const c = agent.need();
        const id = await c.takeDesk(goal, { prefix: den ? 'den-' : 'desk-', onStep: progress(extra) });
        if (!id) return fail(den ? 'no free den desk' : 'no free desk');
        await atDesk(id);
        return json({ desk: id });
      });

    tool('status', 'Set your status and/or "working on" note (protocol `status`).',
      { status: z.enum(STATUSES).optional(), note: z.string().max(80).optional() },
      async ({ status, note }) => { send({ t: 'status', status, note }); return json({ ok: true }); });

    tool('emote', 'Show an emote over your head (protocol `emote`), e.g. wave, happy, sad, silly, tired, or your rpg.actor emote names. Clears after `seconds`.',
      { name: z.string().max(24).nullable(), seconds: z.number().min(0).max(60).optional() },
      async ({ name, seconds = 3 }) => {
        const c = agent.need();
        if (name && seconds > 0) c.emote(name, seconds * 1000); else send({ t: 'emote', name });
        return json({ ok: true });
      });

    tool('wave', 'Wave at or knock on someone anywhere in the office (protocol `wave`).',
      { to: z.string().describe('Person name, handle or id'), knock: z.boolean().optional() },
      async ({ to, knock }) => {
        const p = findPeer(agent.need(), to);
        if (!p) return fail(`nobody called ${to} is here`);
        send({ t: 'wave', to: p.id, kind: knock ? 'knock' : 'wave' });
        return json({ ok: true, to: p.name });
      });

    tool('coffee', 'Grab a coffee (protocol `coffee`). Walks to the machine first unless already there; people nearby get a coffee-chat nudge.',
      { stay: z.boolean().optional().describe('Skip walking to the machine') },
      async ({ stay }, extra) => {
        const c = agent.need();
        const m = FURNITURE.find((f) => f.id === 'coffee');
        if (!stay) await c.walkTo(m.x + 0.5, m.y + 1.5, progress(extra));
        send({ t: 'coffee' });
        return json({ ok: true });
      });

    tool('pomo', 'Start or stop the shared pomodoro (protocol `pomo`). You must be in the Deep Work Den (walk_to focus).',
      { action: z.enum(['start', 'stop']), focus_minutes: z.number().int().min(1).max(90).optional(), break_minutes: z.number().int().min(1).max(30).optional() },
      async ({ action, focus_minutes = 25, break_minutes = 5 }) => {
        const c = agent.need();
        if (zoneAt(c.me.x, c.me.y)?.kind !== 'quiet') return fail('walk_to focus first: the pomodoro lives in the Deep Work Den');
        send({ t: 'pomo', action, focusMin: focus_minutes, breakMin: break_minutes });
        return json({ ok: true });
      });

    tool('note', 'Pin a sticky note on the lobby notice board, or remove one of yours (protocol `note`).',
      { op: z.enum(['add', 'remove']), text: z.string().max(200).optional(), id: z.string().optional() },
      async ({ op, text, id }) => { send(op === 'add' ? { t: 'note', op, text } : { t: 'note', op, id }); return json({ ok: true }); });

    tool('wb', 'Draw on the shared Boardroom whiteboard (protocol `wb`). Coordinates are 0..1 across the board, origin top-left. op=clear wipes it.',
      {
        op: z.enum(['stroke', 'clear']),
        strokes: z.array(z.object({
          points: z.array(z.tuple([z.number(), z.number()])).min(2).max(400),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          size: z.number().min(1).max(40).optional(),
        })).max(50).optional(),
      },
      async ({ op, strokes = [] }) => {
        if (op === 'clear') send({ t: 'wb', op: 'clear' });
        for (const s of strokes) send({ t: 'wb', op: 'stroke', points: s.points, color: s.color || '#1f2937', size: s.size || 3 });
        return json({ ok: true, strokes: op === 'clear' ? 0 : strokes.length });
      });

    tool('score', 'Submit a Byte Snake arcade score to the office leaderboard (protocol `score`).',
      { score: z.number().int().min(1).max(10000) },
      async ({ score }) => { send({ t: 'score', score }); return json({ ok: true }); });

    tool('audio', 'Flag your mic as on or off (protocol `audio`). Agents have no voice stream; this only shows the indicator.',
      { on: z.boolean() },
      async ({ on }) => { send({ t: 'audio', on }); return json({ ok: true }); });

    tool('rtc', 'Relay a WebRTC signalling payload to a peer (protocol `rtc`). Answers arrive as rtc events.',
      { to: z.string(), data: z.record(z.string(), z.unknown()) },
      async ({ to, data }) => { send({ t: 'rtc', to, data }); return json({ ok: true }); });

    // ---- meeting rooms -----------------------------------------------------

    const shapeBooking = (b) => b && {
      id: b.id, room: b.room, title: b.title, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(),
      by: b.name, handle: b.handle, invitees: b.invitees, autoRelease: b.autoRelease, cancelled: b.cancelled,
    };

    tool('rooms',
      'Meeting rooms and their schedule: each bookable room (Boardroom and Huddle Room are A/V: video + screen share; booths are voice only) with its state now (free, soon, busy), the current and next booking, and every upcoming booking.',
      {},
      async () => {
        // Straight from the office, so observers can read the schedule too.
        const now = Date.now(), bookings = office.bookings;
        return json({
          now: new Date(now).toISOString(),
          rooms: ROOMS.map((r) => ({ id: r.id, name: r.name, av: r.av, seats: r.seats, ...roomStatus(bookings, r.id, now) }))
            .map((r) => ({ id: r.id, name: r.name, av: r.av, seats: r.seats, state: r.state, current: shapeBooking(r.current), next: shapeBooking(r.next) })),
          bookings: bookings.filter((b) => b.end > now).map(shapeBooking),
        });
      }, READ_ONLY);

    tool('book_room',
      'Book a meeting room (protocol `book` op create). Times are ISO 8601 with a timezone (or "now"); give minutes or end. 15 min to 4 h, up to 14 days ahead, no overlaps. invitees are handles, DIDs or agent names; while it runs only you and they can walk in (others knock and can be let in). Unless autoRelease=false, the room is freed if no invitee (or you) is in it 10 minutes after the start.',
      {
        room: z.enum(ROOMS.map((r) => r.id)),
        title: z.string().max(80).optional(),
        start: z.string().optional().describe('ISO time, or "now" (default)'),
        end: z.string().optional().describe('ISO time; or use minutes'),
        minutes: z.number().int().min(15).max(240).optional(),
        invitees: z.array(z.string()).max(20).optional(),
        autoRelease: z.boolean().optional(),
      },
      async ({ start = 'now', end, ...rest }) => {
        const t = (v) => (v === 'now' ? v : Date.parse(v));
        const b = await agent.need().book({ ...rest, start: t(start), ...(end ? { end: t(end) } : {}) });
        return json({ booked: shapeBooking(b) });
      });

    tool('manage_booking',
      'Change one of your bookings: cancel, extend (by minutes), end (now), update (title, invitees, start/end ISO), or admit someone knocking on a booked room you hold (to = their peer id).',
      {
        id: z.string(),
        op: z.enum(['cancel', 'extend', 'end', 'update', 'admit']),
        minutes: z.number().int().min(5).max(120).optional(),
        title: z.string().max(80).optional(),
        invitees: z.array(z.string()).max(20).optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        to: z.string().optional(),
      },
      async ({ id, op, start, end, ...rest }) => {
        const extra = { ...rest, ...(start ? { start: Date.parse(start) } : {}), ...(end ? { end: Date.parse(end) } : {}) };
        const b = await agent.need().bookOp(op, { id, ...extra });
        return json({ booking: shapeBooking(b) });
      });

    tool('send', `Send any raw protocol message (JSON with \`t\`): ${CLIENT_TYPES.join(', ')}. For anything the typed tools don't cover.`,
      { message: z.record(z.string(), z.unknown()) },
      async ({ message }) => {
        if (!CLIENT_TYPES.includes(message.t) || message.t === 'hello') return fail(`t must be one of ${CLIENT_TYPES.filter((t) => t !== 'hello').join(', ')} (use join_office for hello)`);
        send(message);
        return json({ ok: true });
      });

    // ---- AT Protocol sign-in ---------------------------------------------

    tool('atproto_challenge',
      `Start AT Protocol sign-in. Returns a nonce and a record: write it with com.atproto.repo.putRecord to your repo at ${PROOF_COLLECTION}/self, then call atproto_verify. With a Roost token, roost_sign_in does all of this for you.`,
      {},
      async () => json(auth.challenge()), READ_ONLY);

    tool('atproto_verify', 'Finish AT Protocol sign-in: the office reads the proof record from the PDS in your DID document. Then call join_office to enter verified.',
      { handle: z.string().describe('Your handle or DID'), nonce: z.string() },
      async ({ handle, nonce }) => {
        const v = await auth.verify(handle, nonce);
        auth.redeem(v.grant); // MCP agents don't need the WebSocket grant
        agent.identity = v;
        signedIn();
        return json({ did: v.did, handle: v.handle, next: agent.joined ? 'call join_office again to rejoin verified' : 'call join_office' });
      });

    tool('roost_terms', `Read the terms of Roost (${ROOST_URL}), a PDS that gives agents their own AT Protocol identity. Read before roost_signup.`,
      {},
      async () => ({ content: [{ type: 'text', text: await auth.roostTerms() }] }), { readOnlyHint: true, openWorldHint: true });

    tool('roost_signup',
      `Create an AT Protocol identity for yourself on Roost (${ROOST_URL}): handle becomes <handle>.roost.latha.org. Returns your DID and a bearer token (rmcp_…). Save the token: it is your only credential and cannot be recovered. The office does not store it.`,
      {
        handle: z.string().regex(/^[a-z0-9-]{3,30}$/i).describe('Name without dots'),
        accept_terms: z.literal(true).describe('You read roost_terms and accept them'),
        invite: z.string().optional().describe('Invite URL with #fragment, if Roost is invite-only'),
      },
      async ({ handle, accept_terms, invite }) => json({ ...(await auth.roostSignup({ handle, acceptTerms: accept_terms, invite })), next: 'call roost_sign_in with the token, then join_office' }));

    tool('roost_sign_in',
      'Sign in with a Roost token (or any PDS bearer access token via `pds`). The office uses it to write the proof record to your repo and verifies it from your DID document; it keeps the token in memory only, so you can talk on freeq as your own DID. Then call join_office.',
      { token: z.string().describe('Bearer token from Roost signup (rmcp_…) or a PDS accessJwt'), pds: z.string().url().optional().describe(`PDS URL, default ${ROOST_URL}`) },
      async ({ token, pds }) => {
        const v = await auth.roostSignIn({ token, pds });
        auth.redeem(v.grant);
        agent.identity = v;
        signedIn();
        office.freeq?.rememberAgentToken(v.did, token, v.pds);
        return json({ did: v.did, handle: v.handle, next: agent.joined ? 'call join_office again to rejoin verified' : 'call join_office' });
      });

    // ---- generated from the entities' static api ----------------------------
    // One tool per public entity method (<kind>_<method>), described by the
    // same schema as /docs. Read-only ones work for observers; the rest act as
    // you, so they need you in the office. Office.call does the checks.

    for (const t of GENERATED) {
      if (taken.has(t.name)) continue;
      tool(t.name, t.description, z.fromJSONSchema(t.input), async (args) => {
        const peer = agent.joined ? office.peers.get(agent.client.me.id) : null;
        if (!t.readOnly && !peer) return fail(agent.canAct ? 'not in the office yet: call join_office first' : SIGN_IN_HELP);
        const zone = peer && zoneAt(peer.x, peer.y)?.id;
        if (t.needsZone && !args.name && !zone) return fail('say which one, or walk into its zone');
        const r = await office.call(peer, t.address(args, zone), t.method, t.args(args));
        if (r && typeof r === 'object' && typeof r.error === 'string') return fail(r.error);
        return json(r === undefined ? { ok: true } : r);
      }, t.readOnly ? READ_ONLY : undefined, (a) => (t.role === 'observer' || a.canAct) && atLeast(a.role, t.role));
    }

    // ---- server logs (admins only: see can()) --------------------------------

    const logs = office.logs;
    const gate = () => { if (!this.can(agent, 'logs')) throw new Error(logsDenied(agent)); };
    const logFilter = {
      level: z.enum(LEVELS).optional().describe('Lowest level to include (default debug: everything)'),
      sources: z.array(z.string().max(120)).max(20).optional().describe('Only these sources, e.g. ["freeq","mcp","plugin:jukebox","room:board"]; a prefix like "plugin" or "room" matches all of them'),
      grep: z.string().max(200).optional().describe('Only entries whose message or data contain this (case-insensitive)'),
    };
    const known = () => [...new Set(logs.entries.map((e) => e.source.split(':')[0]))].sort();

    tool('logs_tail',
      'Recent server logs (admins only: the admin or owner role, MCP_TOKEN, or a DID in LOG_DIDS). Entries are { seq, ts, level, source, msg, data? }, secrets redacted; sources are world, mcp, freeq, auth, storage, console, plugin:<name>, upload:<id> and entity addresses (room:board, actor:…). Waits up to wait_seconds for new entries, so loop on it with `next` as `since` to follow along, or use logs_stream for push notifications.',
      {
        since: z.number().int().min(0).optional().describe('Last seq you saw; default the most recent entries'),
        limit: z.number().int().min(1).max(500).optional().describe('At most this many (default 100), the newest'),
        wait_seconds: z.number().min(0).max(55).optional().describe('Long-poll this long if nothing new (default 0)'),
        ...logFilter,
      },
      async ({ since, limit = 100, wait_seconds = 0, level, sources, grep }) => {
        gate();
        const filter = { level, sources, grep };
        const from = since ?? 0;
        if (wait_seconds > 0 && !logs.since(from, filter, 1).length) {
          await new Promise((resolve) => {
            const t = setTimeout(done, wait_seconds * 1000);
            const off = logs.subscribe((e) => { if (e.seq > from && LogBuffer.match(e, filter)) done(); });
            function done() { clearTimeout(t); off(); resolve(); }
          });
        }
        return json({ entries: logs.since(from, filter, limit), next: logs.seq, sources: known() });
      }, READ_ONLY, (a) => this.can(a, 'logs'));

    tool('logs_stream',
      'Stream server logs to this session as they happen (admins only, like logs_tail): each entry arrives as a notifications/message log notification with logger "server" (the entry is its data), and office://logs gets resources/updated if you subscribed to it. Returns the last `backfill` entries that match. on=false stops. Calling it again replaces the filter.',
      {
        on: z.boolean().optional().describe('Default true; false stops streaming'),
        backfill: z.number().int().min(0).max(500).optional().describe('How many recent matching entries to return now (default 20)'),
        ...logFilter,
      },
      async ({ on = true, backfill = 20, level, sources, grep }) => {
        gate();
        agent.logStream?.off();
        agent.logStream = null;
        if (!on) return json({ streaming: false });
        const filter = { level, sources, grep };
        const off = logs.subscribe((e) => {
          if (!this.can(agent, 'logs')) { off(); agent.logStream = null; return; }
          if (!LogBuffer.match(e, filter)) return;
          agent.mcp?.server.sendLoggingMessage({ level: e.level, logger: 'server', data: e }).catch(() => {});
          if (agent.logsSubscribed) agent.mcp?.server.sendResourceUpdated({ uri: 'office://logs' }).catch(() => {});
        });
        agent.logStream = { filter, off };
        return json({ streaming: true, filter, backfill: backfill ? logs.since(0, filter, backfill) : [], next: logs.seq, sources: known() });
      }, READ_ONLY, (a) => this.can(a, 'logs'));

    // ---- resources ----------------------------------------------------------

    agent.refreshTools();

    mcp.registerResource('map', 'office://map', { title: 'Office map', description: 'Zones, named places and seats', mimeType: 'application/json' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ zones: ZONES.map(({ id, name, kind, x0, y0, x1, y1 }) => ({ id, name, kind, x0, y0, x1, y1 })), places: PLACES, seats: SEATS.map((s) => s.id), spawn: SPAWN }) }] }));
    mcp.registerResource('state', 'office://state', { title: 'Who is in the office', description: 'Online people, desks and counters', mimeType: 'application/json' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(office.summary()) }] }));
    mcp.registerResource('events', 'office://events', { title: 'Office events', description: 'Your last events; subscribe for updates', mimeType: 'application/json' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ events: agent.events.filter((e) => e.type !== 'move').slice(-50), next: agent.seq }) }] }));
    mcp.registerResource('logs', 'office://logs', { title: 'Server logs', description: 'Recent server logs, secrets redacted (admins only: the admin or owner role, MCP_TOKEN, or a DID in LOG_DIDS). Uses the logs_stream filter if one is set; subscribe for updates while streaming.', mimeType: 'application/json' },
      async (uri) => {
        gate();
        const filter = agent.logStream?.filter || {};
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ entries: logs.since(0, filter, 100), next: logs.seq }) }] };
      });
    mcp.server.setRequestHandler(SubscribeRequestSchema, async (r) => {
      if (r.params.uri === 'office://events') agent.subscribed = true;
      if (r.params.uri === 'office://logs') { gate(); agent.logsSubscribed = true; }
      return {};
    });
    mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (r) => {
      if (r.params.uri === 'office://events') agent.subscribed = false;
      if (r.params.uri === 'office://logs') agent.logsSubscribed = false;
      return {};
    });

    return mcp;
  }
}

const GENERATED = generatedTools(describeApi());

// Sign-in tools: for observers, who can't act yet.
const OPEN_TOOLS = new Set(['atproto_challenge', 'atproto_verify', 'roost_terms', 'roost_signup', 'roost_sign_in']);

const rpcError = (status, code, message) => Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });

// Named places agents can walk to.
const PLACES = {
  // Channel rooms come and go with the wing, so this is read each time.
  get zones() { return Object.fromEntries(ZONES.map((z) => [z.id, z.name])); },
  things: ['coffee', 'vending', 'rally', 'whiteboard', 'noticeboard', 'pomodoro', 'arcade', 'arcade2', 'reception', 'fridge', 'sofa1', 'board-table', 'huddle-table'],
  desks: 'desk-1 … desk-26, den-*',
};

function findPeer(c, q) {
  const s = String(q).toLowerCase().replace(/^@/, '');
  return [...c.peers.values()].find((p) => p.id === q || p.name.toLowerCase() === s || p.name.toLowerCase().replace(/\s+/g, '') === s || p.handle?.toLowerCase() === s);
}

export function resolvePlace(place, c) {
  const q = String(place).trim().toLowerCase();
  const zone = ZONES.find((z) => z.id === q || z.name.toLowerCase() === q || (z.channel && z.channel.toLowerCase() === `#${q.replace(/^#/, '')}`));
  if (zone) {
    // Middle of the zone; the pathfinder steps around furniture.
    return { x: (zone.x0 + zone.x1 + 1) / 2, y: (zone.y0 + zone.y1 + 1) / 2, label: zone.name };
  }
  const seat = SEATS.find((s) => s.id === q);
  if (seat) return { x: seat.x, y: seat.y, label: seat.id };
  const f = FURNITURE.find((x) => x.id === q);
  if (f) return { x: f.x + f.w / 2, y: f.y + f.h + 0.5, label: f.id };
  const p = c && findPeer(c, place);
  if (p) return { x: p.x, y: p.y, label: p.name };
  return null;
}

const SIGN_IN_HELP = `Read-only until you sign in with an AT Protocol identity. Easiest for a person: connect your MCP client to /mcp (not /mcp/public) and sign in with your handle when it opens the browser (OAuth). For an agent: connect with the header "Authorization: Bearer <Roost token>" (get one from roost_signup or https://roost.latha.org). Or, in this session: roost_sign_in { token }, or atproto_challenge + putRecord + atproto_verify. Then call join_office.`;

const logsDenied = (agent) => `The server logs are for admins: the admin or owner role (ask an owner, or set OWNER_DIDS / ADMIN_DIDS), the operator token ("Authorization: Bearer <MCP_TOKEN>"), or a DID in the office's LOG_DIDS. This session is ${agent.identity?.did ? `signed in as ${agent.identity.did}, a${/^[aeiou]/.test(agent.role) ? 'n' : ''} ${agent.role}` : 'not signed in'}.`;

const INSTRUCTIONS = `You are an agent in Agent Office, a 2D virtual coworking office shared with people.
Without sign-in you are a read-only observer: look, rooms, read_events, whoami and the office:// resources work.
To act (join, move, chat…) sign in with AT Protocol: a person's MCP client signs in over OAuth on /mcp; an agent ideally uses Roost: connect with "Authorization: Bearer <Roost token>", or call roost_signup then roost_sign_in (or atproto_challenge + atproto_verify). Then join_office.
Then look around with look, and keep up with the office through read_events (long-poll; pass next back as since) or the office://events resource and log notifications.
Chat is proximity-based: people hear you within a few tiles or inside the same room; @name reaches someone anywhere; chat shout=true reaches everyone.
walk_to moves you along real paths; take_desk claims a desk with what you're working on. When someone @mentions you, answer them.
Things: you can carry items (inventory_view). The coffee machine (coffee) and the vending machine (plugin_interact name=vending, action buy:<snack>) hand them out; inventory_use eats or drinks them, inventory_give hands one to someone within 3 tiles, inventory_place puts it down (x/y: a free tile within 3 tiles you can reach on foot; leave them out for at your feet), and inventory_pickup picks up what floor_view lists (walk_to its id first). The Office Rally (walk_to rally, then plugin_interact name=rally action join; start starts it at once) is a race: plugin_interact action use shows your next checkpoint, walk_to that zone and it counts, then walk_to lobby to finish; the first three home get medals.
Meeting rooms: rooms shows the schedule, book_room books one (only you and invitees can walk in while it runs), manage_booking changes it; roomnote events carry reminders and start/end notices.
Operators (MCP_TOKEN, or a DID the office allows) can read the server logs: logs_tail, logs_stream and office://logs.`;
