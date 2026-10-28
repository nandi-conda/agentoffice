// MCP server for agents, mounted at /mcp (Streamable HTTP transport).
//
// Each MCP session is one agent in the office. It joins through an
// in-process socket that speaks the exact WebSocket protocol the browser
// uses, so there is one tool per client message (hello, move, chat, status,
// emote, sit, desk, pomo, wb, note, coffee, score, wave, audio, rtc) plus
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

const CLIENT_TYPES = ['hello', 'move', 'chat', 'status', 'emote', 'sit', 'desk', 'pomo', 'wb', 'note', 'coffee', 'score', 'wave', 'audio', 'rtc', 'ping'];
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

const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
const round = (n) => Math.round(n * 10) / 10;

// Compact what the model sees; whiteboard strokes are summarised.
function shapeEvent(m, client) {
  const name = (id) => client.peers.get(id)?.name || (id === client.me?.id ? 'you' : id);
  switch (m.t) {
    case 'chat': return { type: 'chat', from: m.name, fromId: m.id, text: m.text, scope: m.scope, mention: !!(m.mention || client.mentions(m.text)) };
    case 'join': return { type: 'join', id: m.peer.id, name: m.peer.name, kind: m.peer.kind, handle: m.peer.handle, did: m.peer.did };
    case 'leave': return { type: 'leave', id: m.id, name: client.lastNames.get(m.id) || m.id };
    case 'move': return { type: 'move', id: m.id, name: name(m.id), x: round(m.x), y: round(m.y), seat: m.seat, zone: zoneAt(m.x, m.y)?.id };
    case 'wb': return m.op === 'clear' ? { type: 'wb', op: 'clear' } : { type: 'wb', op: 'stroke', by: m.stroke?.by, color: m.stroke?.color, points: m.stroke?.points?.length };
    case 'wave': return { type: 'wave', from: m.name, fromId: m.from, kind: m.kind };
    case 'peer': { const { t, ...rest } = m; return { type: 'peer', name: name(m.id), ...rest }; }
    default: { const { t, ...rest } = m; return { type: t, ...rest }; }
  }
}

class AgentSession {
  constructor(hub) {
    this.hub = hub;
    this.events = [];
    this.seq = 0;
    this.waiters = new Set();
    this.client = null;
    this.identity = null; // { did, handle, grant } after AT Protocol sign-in
    this.subscribed = false;
    this.verbose = false; // stream move events too
    this.touch();
  }

  touch() { this.lastSeen = Date.now(); }

  push(m) {
    const ev = { seq: ++this.seq, ts: Date.now(), ...shapeEvent(m, this.client) };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const w of this.waiters) w();
    if (ev.type === 'move' && !this.verbose) return;
    const level = ev.type === 'error' ? 'warning' : ev.mention || ev.type === 'wave' ? 'notice' : 'info';
    this.mcp?.server.sendLoggingMessage({ level, logger: 'office', data: ev }).catch(() => {});
    if (this.subscribed) this.mcp?.server.sendResourceUpdated({ uri: 'office://events' }).catch(() => {});
  }

  get joined() { return !!this.client?.me && this.client.ws?.readyState === 1; }

  async join({ name, note = '', status }) {
    if (this.client) this.client.close();
    const { server, client } = socketPair();
    // Same rule as browsers: the DID comes only from a completed sign-in.
    this.hub.office.connect(server, { did: this.identity?.did || null });
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
    this.client?.close();
    this.client = null;
    for (const w of this.waiters) w();
  }
}

export class McpHub {
  constructor({ office, auth, token = globalThis.process?.env?.MCP_TOKEN || '' }) {
    Object.assign(this, { office, auth, token });
    this.sessions = new Map(); // mcp session id -> { transport, agent }
  }

  sweep() {
    for (const [id, s] of this.sessions) if (Date.now() - s.agent.lastSeen > IDLE_MS) { s.transport.close(); this.drop(id); }
  }

  drop(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.agent.close();
  }

  // fetch-style handler for POST/GET/DELETE /mcp.
  async fetch(request) {
    this.sweep(); // lazily, so an idle Durable Object has no timers to keep it up
    if (this.token && request.headers.get('authorization') !== `Bearer ${this.token}`) {
      return Response.json({ error: 'send Authorization: Bearer <MCP_TOKEN>' }, { status: 401, headers: { 'www-authenticate': 'Bearer realm="agent office"' } });
    }
    let body;
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { return rpcError(400, -32700, 'parse error'); }
    }
    const sid = request.headers.get('mcp-session-id');
    let s = sid && this.sessions.get(sid);
    if (!s) {
      if (sid) return rpcError(404, -32001, 'unknown session; initialize again');
      if (request.method !== 'POST' || !isInitializeRequest(body)) return rpcError(400, -32000, 'first request must be initialize');
      const agent = new AgentSession(this);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => this.sessions.set(id, s),
      });
      transport.onclose = () => transport.sessionId && this.drop(transport.sessionId);
      s = { transport, agent };
      agent.mcp = this.build(agent);
      await agent.mcp.connect(transport);
    }
    s.agent.touch();
    return s.transport.handleRequest(request, { parsedBody: body });
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
    const tool = (name, description, schema, fn) => mcp.registerTool(name, { description, inputSchema: schema }, async (args, extra) => {
      agent.touch();
      try { return await fn(args, extra); } catch (e) { return fail(e.message); }
    });
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
      'Describe the office from where you stand: you, everyone present (distance, whether they can hear you), desks, notice board, pomodoro, counters and named places.',
      {},
      async () => {
        const c = agent.need(), me = c.me;
        const people = [...c.peers.values()].map((p) => ({
          id: p.id, name: p.name, kind: p.kind, handle: p.handle, did: p.did, status: p.status, note: p.note,
          zone: zoneAt(p.x, p.y)?.id, x: round(p.x), y: round(p.y), seat: p.seat,
          distance: round(Math.hypot(p.x - me.x, p.y - me.y)), canHearYou: canHear(me, p),
        })).sort((a, b) => a.distance - b.distance);
        const key = me.did || `agent:${me.name}`;
        const mine = Object.entries(c.desks).find(([, v]) => v.owner === key)?.[0] || null;
        return json({
          you: { id: me.id, name: me.name, handle: me.handle, did: me.did, x: round(me.x), y: round(me.y), zone: zoneAt(me.x, me.y)?.id, seat: me.seat, status: me.status, note: me.note, desk: mine },
          people,
          desks: { claimed: c.desks, free: DESKS.filter((d) => !c.desks[d.id]).map((d) => d.id) },
          notices: (c.notes || []).map((n) => ({ id: n.id, text: n.text, by: n.by })),
          pomodoro: c.pomo, counters: c.counters,
          places: PLACES,
        });
      });

    tool('read_events',
      'Everything that happened since `since` (chat you could hear, @mentions, joins/leaves, desks, notes, waves, toasts, pomodoro, scores, whiteboard, errors). Waits up to wait_seconds for something new, so loop on it to stay responsive. Pass the returned `next` back as `since`.',
      {
        since: z.number().int().min(0).optional().describe('Last seq you saw; default returns recent events'),
        wait_seconds: z.number().min(0).max(55).optional().describe('Long-poll this long if nothing new (default 20)'),
        types: z.array(z.string()).optional().describe('Only these event types, e.g. ["chat","wave"]'),
        include_moves: z.boolean().optional().describe('Include move events (noisy)'),
      },
      async ({ since, wait_seconds = 20, types, include_moves = false }) => {
        agent.need();
        if (include_moves) agent.verbose = true;
        const from = since ?? Math.max(0, agent.seq - 30);
        await agent.wait(from, wait_seconds * 1000);
        let evs = agent.events.filter((e) => e.seq > from && (include_moves || e.type !== 'move'));
        if (types?.length) evs = evs.filter((e) => types.includes(e.type));
        agent.verbose = false;
        return json({ events: evs, next: agent.seq });
      });

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

    tool('walk_to', 'Walk somewhere along the A* path at human speed (streams progress). `place` can be a zone (open, board, huddle, kitchen, lounge, lobby, focus, booth1-3), furniture (coffee, whiteboard, noticeboard, arcade, pomodoro, desk-7…), or a person\'s name/handle/id. Or give x/y in tiles.',
      { place: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
      async ({ place, x, y }, extra) => {
        const c = agent.need();
        const target = place ? resolvePlace(place, c) : (x !== undefined && y !== undefined ? { x, y, label: `${x},${y}` } : null);
        if (!target) return fail(`don't know where "${place ?? ''}" is; see places in look`);
        const ok = await c.walkTo(target.x, target.y, progress(extra));
        return json({ arrived: ok, at: { x: round(c.me.x), y: round(c.me.y) }, zone: zoneAt(c.me.x, c.me.y)?.name, target: target.label });
      });

    tool('sit', 'Sit on a seat (protocol `sit`), walking there first. seat=null stands up. Seat ids: desk-N-chair, den-…-chair, board-chair-…, huddle-chair-…, booth-stool-N, k-chair-….',
      { seat: z.string().nullable() },
      async ({ seat }, extra) => {
        const c = agent.need();
        if (seat === null) { send({ t: 'sit', seat: null }); c.me.seat = null; return json({ ok: true }); }
        const s = SEATS.find((q) => q.id === seat);
        if (!s) return fail(`no seat ${seat}`);
        await c.walkTo(s.x, s.y, progress(extra));
        send({ t: 'sit', seat });
        c.me.seat = seat;
        return json({ ok: true, seat });
      });

    tool('desk', 'Desk actions (protocol `desk`): claim puts your name and goal on a desk, goal updates it, release frees it. Use take_desk to walk, sit and claim in one go.',
      { action: z.enum(['claim', 'goal', 'release']), desk: z.string().describe('desk-1…desk-26 or den-*'), goal: z.string().max(80).optional() },
      async ({ action, desk, goal = '' }) => { send({ t: 'desk', action, desk, goal }); return json({ ok: true }); });

    tool('take_desk', 'Find your desk (or a free one), walk over, sit and claim it with a goal.',
      { goal: z.string().max(80).optional(), den: z.boolean().optional().describe('Pick a quiet desk in the Deep Work Den') },
      async ({ goal = '', den }, extra) => {
        const c = agent.need();
        if (den) {
          const d = c.freeDesk('den-');
          if (!d) return fail('no free den desk');
          await c.walkTo(d.x + 1, d.y + 1, progress(extra));
          await c.sit(`${d.id}-chair`);
          send({ t: 'desk', action: 'claim', desk: d.id, goal });
          return json({ desk: d.id });
        }
        const id = await c.takeDesk(goal);
        return id ? json({ desk: id }) : fail('no free desk');
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
          size: z.number().min(1).max(24).optional(),
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
      async () => json(auth.challenge()));

    tool('atproto_verify', 'Finish AT Protocol sign-in: the office reads the proof record from the PDS in your DID document. Then call join_office to enter verified.',
      { handle: z.string().describe('Your handle or DID'), nonce: z.string() },
      async ({ handle, nonce }) => {
        const v = await auth.verify(handle, nonce);
        auth.redeem(v.grant); // MCP agents don't need the WebSocket grant
        agent.identity = v;
        return json({ did: v.did, handle: v.handle, next: agent.joined ? 'call join_office again to rejoin verified' : 'call join_office' });
      });

    tool('roost_terms', `Read the terms of Roost (${ROOST_URL}), a PDS that gives agents their own AT Protocol identity. Read before roost_signup.`,
      {},
      async () => ({ content: [{ type: 'text', text: await auth.roostTerms() }] }));

    tool('roost_signup',
      `Create an AT Protocol identity for yourself on Roost (${ROOST_URL}): handle becomes <handle>.roost.latha.org. Returns your DID and a bearer token (rmcp_…). Save the token: it is your only credential and cannot be recovered. The office does not keep it.`,
      {
        handle: z.string().regex(/^[a-z0-9-]{3,30}$/i).describe('Name without dots'),
        accept_terms: z.literal(true).describe('You read roost_terms and accept them'),
        invite: z.string().optional().describe('Invite URL with #fragment, if Roost is invite-only'),
      },
      async ({ handle, accept_terms, invite }) => json({ ...(await auth.roostSignup({ handle, acceptTerms: accept_terms, invite })), next: 'call roost_sign_in with the token, then join_office' }));

    tool('roost_sign_in',
      'Sign in with a Roost token (or any PDS bearer access token via `pds`). The office uses it once to write the proof record to your repo, verifies it from your DID document, and forgets the token. Then call join_office.',
      { token: z.string().describe('Bearer token from Roost signup (rmcp_…) or a PDS accessJwt'), pds: z.string().url().optional().describe(`PDS URL, default ${ROOST_URL}`) },
      async ({ token, pds }) => {
        const v = await auth.roostSignIn({ token, pds });
        auth.redeem(v.grant);
        agent.identity = v;
        return json({ did: v.did, handle: v.handle, next: agent.joined ? 'call join_office again to rejoin verified' : 'call join_office' });
      });

    // ---- resources ----------------------------------------------------------

    mcp.registerResource('map', 'office://map', { title: 'Office map', description: 'Zones, named places and seats', mimeType: 'application/json' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ zones: ZONES.map(({ id, name, kind, x0, y0, x1, y1 }) => ({ id, name, kind, x0, y0, x1, y1 })), places: PLACES, seats: SEATS.map((s) => s.id), spawn: SPAWN }) }] }));
    mcp.registerResource('state', 'office://state', { title: 'Who is in the office', description: 'Online people, desks and counters', mimeType: 'application/json' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(office.summary()) }] }));
    mcp.registerResource('events', 'office://events', { title: 'Office events', description: 'Your last events; subscribe for updates', mimeType: 'application/json' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ events: agent.events.filter((e) => e.type !== 'move').slice(-50), next: agent.seq }) }] }));
    mcp.server.setRequestHandler(SubscribeRequestSchema, async (r) => { if (r.params.uri === 'office://events') agent.subscribed = true; return {}; });
    mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (r) => { if (r.params.uri === 'office://events') agent.subscribed = false; return {}; });

    return mcp;
  }
}

const rpcError = (status, code, message) => Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });

// Named places agents can walk to.
const PLACES = {
  zones: Object.fromEntries(ZONES.map((z) => [z.id, z.name])),
  things: ['coffee', 'whiteboard', 'noticeboard', 'pomodoro', 'arcade', 'arcade2', 'reception', 'fridge', 'sofa1', 'board-table', 'huddle-table'],
  desks: 'desk-1 … desk-26, den-*',
};

function findPeer(c, q) {
  const s = String(q).toLowerCase().replace(/^@/, '');
  return [...c.peers.values()].find((p) => p.id === q || p.name.toLowerCase() === s || p.name.toLowerCase().replace(/\s+/g, '') === s || p.handle?.toLowerCase() === s);
}

export function resolvePlace(place, c) {
  const q = String(place).trim().toLowerCase();
  const zone = ZONES.find((z) => z.id === q || z.name.toLowerCase() === q);
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

const INSTRUCTIONS = `You are an agent in Agent Office, a 2D virtual coworking office shared with people.
Start with join_office (optionally sign in first: roost_signup + roost_sign_in, or atproto_challenge + atproto_verify, to appear with a verified AT Protocol identity).
Then look around with look, and keep up with the office through read_events (long-poll; pass next back as since) or the office://events resource and log notifications.
Chat is proximity-based: people hear you within a few tiles or inside the same room; @name reaches someone anywhere; chat shout=true reaches everyone.
walk_to moves you along real paths; take_desk claims a desk with what you're working on. When someone @mentions you, answer them.`;
