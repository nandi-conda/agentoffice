import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadActor, fetchBlob } from './atproto.js';
import { Office } from './office.js';
import { createAuth } from './auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
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

let saveTimer = null;
function scheduleSave(office) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify(office.persisted()));
    } catch (e) { console.error('save failed', e.message); }
  }, 1000);
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

const auth = createAuth({ publicUrl: process.env.PUBLIC_URL, port: PORT, secret: await sessionSecret() });

// auth.js speaks fetch-style Request/Response so it also runs on Workers.
async function authRoute(req, res, url) {
  if (!url.pathname.startsWith('/oauth/')) return false;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const out = await auth.handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, signal: ac.signal }));
  if (!out) return false;
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
  return true;
}

const office = new Office(await loadState(), {
  onChange: () => scheduleSave(office),
  loadActor: process.env.OFFLINE ? null : loadActor,
});

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (await authRoute(req, res, url)) return;
    if (url.pathname === '/api/me') {
      const did = await auth.didFromCookie(req.headers.cookie);
      if (!did) return send(res, 200, { did: null });
      try {
        const { pds, ...pub } = await loadActor(did);
        return send(res, 200, pub);
      } catch {
        return send(res, 200, { did, handle: null });
      }
    }
    if (url.pathname === '/api/actor') {
      const id = url.searchParams.get('id') || '';
      if (!id || id.length > 253) return send(res, 400, { error: 'missing id' });
      const actor = await loadActor(id);
      const { pds, ...pub } = actor;
      return send(res, 200, pub);
    }
    if (url.pathname === '/api/blob') {
      const blob = await fetchBlob(url.searchParams.get('did') || '', url.searchParams.get('cid') || '');
      res.writeHead(200, { 'content-type': blob.type, 'cache-control': 'public, max-age=86400, immutable' });
      return res.end(blob.buf);
    }
    if (url.pathname === '/api/office') return send(res, 200, office.summary());
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
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
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024, verifyClient: sameOrigin });
wss.on('connection', async (ws, req) => {
  // Hold early messages until we know who this is.
  const early = [];
  const hold = (m) => early.push(m);
  ws.on('message', hold);
  const did = await auth.didFromCookie(req.headers.cookie);
  ws.off('message', hold);
  office.connect(ws, { did });
  for (const m of early) ws.emit('message', m);
});

server.listen(PORT, () => {
  console.log(`agent office open on ${auth.loopback ? `http://127.0.0.1:${PORT}` : auth.origin}`);
  console.log(auth.loopback ? 'sign-in: AT Protocol loopback client (local dev)' : `sign-in: client metadata at ${auth.metadata.client_id}`);
});
