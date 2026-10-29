import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadActor } from './atproto.js';
import { Office } from './office.js';
import { createAuth, SESSION_TTL_MS } from './auth.js';
import { handleApi, isApiPath } from './app.js';
import { AgentAuth } from './agentauth.js';
import { McpHub } from './mcp.js';
import { FreeqBridge, FREEQ_URL } from './freeq.js';
import { LocalRuntime } from './entities/runtime.js';
import { PluginHost } from './plugins.js';
import { NodeSandbox } from './sandbox-node.js';
import { KINDS } from './entities/kinds.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ENTITIES_FILE = path.join(DATA_DIR, 'entities.json');
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}

// Debounced JSON saves: the World's own state, and every entity's.
function saver(file, data) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
        await writeFile(file, JSON.stringify(data()), { mode: 0o600 });
      } catch (e) { console.error('save failed', e.message); }
    }, 1000);
  };
}

// Cookie-signing key: SESSION_SECRET, or one generated once and kept in DATA_DIR.
async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try { return (await readFile(file, 'utf8')).trim(); } catch { /* make one */ }
  const secret = randomBytes(32).toString('hex');
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, secret, { mode: 0o600 });
  return secret;
}

// Where OAuth sessions were kept before actors held them (read once, then moved).
async function fileStore(name, ttlMs) {
  const file = path.join(DATA_DIR, name);
  let data = {};
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch { /* none yet */ }
  const save = async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(data), { mode: 0o600 });
  };
  return {
    async set(k, v) { data[k] = { v, at: Date.now() }; await save(); },
    async get(k) {
      const e = data[k];
      if (!e) return undefined;
      if (Date.now() - e.at > ttlMs) { delete data[k]; await save(); return undefined; }
      return e.v;
    },
    async del(k) { if (k in data) { delete data[k]; await save(); } },
  };
}

// Entities (actors, rooms, desks, the whiteboard…) live in this process,
// saved together in DATA_DIR/entities.json; on Workers each is a Durable Object.
let entityData = {};
try { entityData = JSON.parse(await readFile(ENTITIES_FILE, 'utf8')); } catch { /* first run */ }
const actorLoader = process.env.OFFLINE ? null : loadActor;
const runtime = new LocalRuntime({ kinds: KINDS, data: entityData, services: { loadActor: actorLoader, plugins: new PluginHost({ sandbox: new NodeSandbox() }), admins: (process.env.ADMIN_DIDS || '').split(',').map((d) => d.trim()).filter(Boolean) }, onWrite: saver(ENTITIES_FILE, () => entityData) });

// Each person's OAuth session is kept by their actor entity, so a restart
// (or `just dev` reloading) doesn't lose it while their cookie still says
// they're signed in. Sessions from the older oauth-sessions.json move over.
const oldSessions = await fileStore('oauth-sessions.json', SESSION_TTL_MS);
const actor = (did) => runtime.ref(`actor:${did}`);
const sessionStore = {
  async get(did) {
    const v = await actor(did).sessionGet(SESSION_TTL_MS);
    if (v !== undefined) return v;
    const old = await oldSessions.get(did);
    if (old !== undefined) { await actor(did).sessionSet(old); await oldSessions.del(did); }
    return old;
  },
  set: (did, v) => actor(did).sessionSet(v),
  async del(did) { await actor(did).sessionDel(); await oldSessions.del(did); },
};
const auth = createAuth({ publicUrl: process.env.PUBLIC_URL, port: PORT, secret: await sessionSecret(), sessionStore });

const saved = await loadState();
// state.json from before entities: keep a copy, the entities take it over.
if (!saved.migrated && Object.keys(saved).length) await writeFile(path.join(DATA_DIR, 'state.pre-entities.json'), JSON.stringify(saved)).catch(() => {});
const office = new Office(saved, {
  onChange: saver(STATE_FILE, () => office.persisted()),
  loadActor: actorLoader,
  runtime,
});
const agents = new AgentAuth({ office: process.env.OFFICE_NAME || 'agent office' });
const mcp = new McpHub({ office, auth: agents });

// freeq: populated IRC channels attached to office areas (FREEQ=off to disable).
if (process.env.FREEQ !== 'off' && !process.env.OFFLINE) {
  const keyFile = path.join(DATA_DIR, 'freeq-key.json');
  const stateFile = path.join(DATA_DIR, 'freeq-state.json');
  new FreeqBridge({
    office, auth,
    url: process.env.FREEQ_URL || FREEQ_URL,
    rooms: process.env.FREEQ_ROOMS || '',
    minMembers: Number(process.env.FREEQ_MIN_MEMBERS) || 2,
    openSocket: async (url) => new WebSocket(url),
    keyStore: {
      get: async () => { try { return JSON.parse(await readFile(keyFile, 'utf8')); } catch { return null; } },
      set: async (jwk) => { await mkdir(DATA_DIR, { recursive: true }); await writeFile(keyFile, JSON.stringify(jwk), { mode: 0o600 }); },
    },
    // Who was in which channel and the last message heard, so a restart
    // doesn't redraw everyone and missed messages get caught up.
    stateStore: {
      get: async () => { try { return JSON.parse(await readFile(stateFile, 'utf8')); } catch { return null; } },
      set: async (snap) => { await mkdir(DATA_DIR, { recursive: true }); await writeFile(stateFile, JSON.stringify(snap)); },
    },
  });
}

// Booking reminders run on each room's alarm; this is a safety net.
setInterval(() => office.tickRooms().catch(() => {}), 60000).unref();

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // API and OAuth routes live in app.js, written against fetch-style
    // Request/Response so they also run on Cloudflare Workers.
    if (isApiPath(url.pathname)) {
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : req;
      const out = await handleApi(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body, duplex: 'half', signal: ac.signal }), { office, auth, agents, mcp });
      if (!out) return send(res, 404, { error: 'not found' });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      // Stream, so MCP's server-sent events reach the agent as they happen.
      if (out.body) try { for await (const chunk of out.body) res.write(chunk); } catch { /* client went away */ }
      return res.end();
    }

    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    else if (p.endsWith('/')) p += 'index.html'; // /docs/api/ → docs/api/index.html, as Workers assets do
    else if (!path.extname(p)) return res.writeHead(307, { location: `${p}/${url.search}` }).end();
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return send(res, 404, 'not found', 'text/plain');
    send(res, url.pathname.startsWith('/api/') ? 502 : 500, { error: e.message });
  }
});

// Browsers always send Origin; refusing foreign ones stops another site from
// opening a socket that rides on the visitor's session cookie. Agents (no
// Origin) are fine, they never carry the cookie.
const sameOrigin = ({ origin, req }) => !origin || new URL(origin).host === req.headers.host;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024, verifyClient: sameOrigin });
wss.on('connection', async (ws, req) => {
  // Hold early messages until we know who this is.
  const early = [];
  const hold = (m) => early.push(m);
  ws.on('message', hold);
  // Browsers sign in with OAuth (cookie); agents with a one-time grant.
  const grant = new URL(req.url, 'http://x').searchParams.get('grant');
  const did = (await auth.didFromCookie(req.headers.cookie)) || agents.redeem(grant)?.did || null;
  ws.off('message', hold);
  office.connect(ws, { did });
  for (const m of early) ws.emit('message', m);
});

server.listen(PORT, () => {
  console.log(`agent office open on ${auth.loopback ? `http://127.0.0.1:${PORT}` : auth.origin}`);
  console.log(auth.loopback ? 'sign-in: AT Protocol loopback client (local dev)' : `sign-in: client metadata at ${auth.metadata.client_id}`);
});
