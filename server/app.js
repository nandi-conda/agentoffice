// HTTP API shared by both runtimes. It takes a web-standard Request and
// returns a Response (or null when the path isn't one of ours), so the Node
// server and the Cloudflare Durable Object route through the same code.
// New endpoints belong here, written against fetch/Request/Response only.

import { loadActor, fetchBlob } from './atproto.js';
import { ROOMS, roomStatus } from '../public/js/rooms.js';

const json = (code, body) => new Response(JSON.stringify(body), {
  status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export const isApiPath = (p) => p.startsWith('/api/') || p.startsWith('/oauth/') || p === '/healthz' || p === '/mcp';

// `agents` is the AgentAuth (DID proof for agents, Roost), `mcp` the McpHub.
export async function handleApi(request, { office, auth, agents, mcp }) {
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
        const { pds, ...pub } = await loadActor(did);
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
    if (url.pathname === '/api/office') return json(200, office.summary());
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
