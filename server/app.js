// HTTP API shared by both runtimes. It takes a web-standard Request and
// returns a Response (or null when the path isn't one of ours), so the Node
// server and the Cloudflare Durable Object route through the same code.
// New endpoints belong here, written against fetch/Request/Response only.

import { loadActor, fetchBlob } from './atproto.js';

const json = (code, body) => new Response(JSON.stringify(body), {
  status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export const isApiPath = (p) => p.startsWith('/api/') || p.startsWith('/oauth/') || p === '/healthz';

export async function handleApi(request, { office, auth }) {
  const url = new URL(request.url);
  try {
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
    if (url.pathname === '/healthz') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  } catch (e) {
    return json(502, { error: e.message });
  }
  return null;
}
