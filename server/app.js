// HTTP API shared by both runtimes. It takes a web-standard Request and
// returns a Response (or null when the path isn't one of ours), so the Node
// server and the Cloudflare Durable Object route through the same code.
// New endpoints belong here, written against fetch/Request/Response only.

import { loadActor, fetchBlob } from './atproto.js';
import { describeApi } from './apidoc.js';
import { ROOMS, roomStatus } from '../public/js/rooms.js';
import { STUN } from './turn.js';

const json = (code, body) => new Response(JSON.stringify(body), {
  status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// Stock character parts: the rpg.actor Sprite Generator's layer PNGs
// (CC BY 4.0, see README), proxied so the browser can recolour their pixels.
const STOCK_ROOT = 'https://rpg.actor/assets/generator/';
const STOCK_PATH = /^(body|hairstyle\/(hair|bangs|beard)|clothing\/(undies|tops|bottoms|hands|feet)|accessories\/(headwear|glasses|necklaces)|face\/(eyes|nose|mouth))\/[A-Za-z0-9_-]{1,80}\.png$/;
const stockCache = new Map();

// Workers' fetch sends no User-Agent, which bot protection tends to refuse.
const STOCK_HEADERS = { 'user-agent': 'agentoffice/0.1 (+https://github.com/nandi-conda/agentoffice)', accept: 'image/png' };

export async function stockAsset(path, fetchImpl = (...a) => fetch(...a)) {
  if (!STOCK_PATH.test(path)) return { status: 404, reason: 'not a generator part' };
  if (stockCache.has(path)) return stockCache.get(path);
  let out;
  try {
    const res = await fetchImpl(STOCK_ROOT + path, { headers: STOCK_HEADERS });
    const type = res.headers.get('content-type') || '';
    out = res.ok && type.startsWith('image/png')
      ? { status: 200, body: new Uint8Array(await res.arrayBuffer()) }
      : { status: res.status === 404 ? 404 : 502, reason: `rpg.actor answered ${res.status} ${type}` };
  } catch (e) {
    out = { status: 502, reason: `rpg.actor unreachable: ${e.message}` };
  }
  // Missing parts are remembered too, so a bad name isn't refetched per viewer.
  if (out.status !== 502) {
    if (stockCache.size > 500) stockCache.delete(stockCache.keys().next().value);
    stockCache.set(path, out);
  }
  return out;
}

export const isApiPath = (p) => p.startsWith('/api/') || p.startsWith('/oauth/') || p === '/healthz' || p === '/mcp';

// `agents` is the AgentAuth (DID proof for agents, Roost), `mcp` the McpHub,
// `ice` the ICE server source (server/turn.js).
export async function handleApi(request, { office, auth, agents, mcp, ice }) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/mcp' && mcp) return await mcp.fetch(request);
    if (url.pathname.startsWith('/api/agent/') && agents) {
      // AT Protocol sign-in for WebSocket agents: the returned grant goes on
      // /ws?grant=… (MCP agents use the sign-in tools instead).
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      try {
        if (url.pathname === '/api/agent/challenge') return json(200, agents.challenge());
        if (url.pathname === '/api/agent/verify' && request.method === 'POST') return json(200, await agents.verify(body.handle, body.nonce));
        if (url.pathname === '/api/agent/roost-signin' && request.method === 'POST') return json(200, await agents.roostSignIn({ token: body.token, pds: body.pds }));
      } catch (e) {
        return json(403, { error: e.message });
      }
      return null;
    }
    if (url.pathname.startsWith('/oauth/')) return await auth.handle(request);
    if (url.pathname === '/api/me') {
      const did = await auth.didFromCookie(request.headers.get('cookie'));
      if (!did) return json(200, { did: null });
      try {
        // Don't keep the page waiting on a slow PDS; the office loads the
        // character again on join anyway.
        const timeout = new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000));
        const { pds, ...pub } = await Promise.race([loadActor(did), timeout]);
        return json(200, pub);
      } catch {
        return json(200, { did, handle: null });
      }
    }
    if (url.pathname === '/api/actor') {
      const id = url.searchParams.get('id') || '';
      if (!id || id.length > 253) return json(400, { error: 'missing id' });
      const { pds, ...pub } = await loadActor(id);
      return json(200, pub);
    }
    if (url.pathname === '/api/blob') {
      const blob = await fetchBlob(url.searchParams.get('did') || '', url.searchParams.get('cid') || '');
      return new Response(blob.buf, { headers: { 'content-type': blob.type, 'cache-control': 'public, max-age=86400, immutable' } });
    }
    if (url.pathname.startsWith('/api/stock/')) {
      const a = await stockAsset(url.pathname.slice('/api/stock/'.length));
      if (a.status !== 200) return new Response(a.reason || '', { status: a.status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
      return new Response(a.body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
    }
    // STUN/TURN servers for voice and video (short-lived TURN credentials when configured).
    if (url.pathname === '/api/ice') {
      const { error, ...out } = ice ? await ice.get() : { iceServers: STUN, ttl: 86400, turn: false };
      return json(200, out);
    }
    if (url.pathname === '/api/office') return json(200, office.summary());
    // The whole API (entities, World, plugins) as JSON; /docs is the same, rendered.
    if (url.pathname === '/api/schema') return json(200, describeApi());
    // Meeting rooms with their live status and schedule (read-only; book over /ws).
    if (url.pathname === '/api/rooms') {
      const now = office.now();
      return json(200, {
        now,
        rooms: ROOMS.map((r) => {
          const { state, current, next } = roomStatus(office.bookings, r.id, now);
          return { id: r.id, name: r.name, av: r.av, seats: r.seats, state, current: current?.id || null, next: next?.id || null };
        }),
        bookings: office.bookings.filter((b) => b.end > now).map(({ sent, ...b }) => b),
      });
    }
    if (url.pathname === '/healthz') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  } catch (e) {
    return json(502, { error: e.message });
  }
  return null;
}
