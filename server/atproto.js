// Minimal AT Protocol reads for rpg.actor characters.
//
// Following the rpg.actor developer guidelines, the only hosts we talk to
// are the identity resolvers and the player's own PDS, and we only read the
// records we need: actor.rpg.sprite, actor.rpg.stats and the profile.

// Only web-standard APIs (fetch, Uint8Array) so this runs on Node and on
// Cloudflare Workers alike.

const TTL = 10 * 60 * 1000;
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const HANDLE_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i;
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.:%-]+)$/i;

export const isHandle = (s) => HANDLE_RE.test(s);
export const isDid = (s) => DID_RE.test(s);

async function getJson(url, timeout = 6000, accept = 'application/json') {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

// DNS TXT lookup over DNS-over-HTTPS, since Workers have no resolver API.
// Cloudflare first, Google if that fails.
const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
async function resolveTxt(name) {
  let err;
  for (const base of DOH) {
    try {
      const j = await getJson(`${base}?name=${encodeURIComponent(name)}&type=TXT`, 4000, 'application/dns-json');
      return (j.Answer || []).filter((a) => a.type === 16).map((a) => a.data.replace(/^"|"$/g, '').replace(/" "/g, ''));
    } catch (e) { err = e; }
  }
  throw err;
}

export async function resolveHandle(handle) {
  handle = handle.toLowerCase().replace(/^@/, '');
  if (!isHandle(handle)) throw new Error('not a valid handle');
  return cached(`h:${handle}`, async () => {
    try {
      for (const v of await resolveTxt(`_atproto.${handle}`)) {
        if (v.startsWith('did=') && isDid(v.slice(4))) return v.slice(4);
      }
    } catch { /* fall through to HTTPS */ }
    try {
      const res = await fetch(`https://${handle}/.well-known/atproto-did`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const did = (await res.text()).trim();
        if (isDid(did)) return did;
      }
    } catch { /* fall through to the public resolver */ }
    const j = await getJson(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
    if (!isDid(j.did)) throw new Error('could not resolve handle');
    return j.did;
  });
}

// The raw DID document: plc.directory for did:plc, /.well-known/did.json for did:web.
export async function fetchDidDoc(did) {
  if (!isDid(did)) throw new Error('not a valid DID');
  return cached(`doc:${did}`, async () => {
    const doc = did.startsWith('did:plc:')
      ? await getJson(`https://plc.directory/${did}`, 6000, 'application/did+ld+json,application/json')
      : await getJson(`https://${decodeURIComponent(did.slice(8).replace(/:/g, '/'))}/.well-known/did.json`);
    if (doc?.id !== did) throw new Error(`DID document for ${did} names a different DID`);
    return doc;
  });
}

export async function resolveDid(did) {
  return parseDidDoc(await fetchDidDoc(did));
}

// Identity resolution for the OAuth client. We do it ourselves instead of
// using @atproto's resolvers because those build `new Request(...,
// { redirect: 'error' })`, which Cloudflare Workers rejects, so every
// sign-in failed there with "Failed to resolve identity".
export const identityResolver = {
  async resolve(input) {
    const id = String(input).trim().replace(/^@/, '').replace(/^at:\/\//, '').toLowerCase();
    const did = isDid(id) ? id : await resolveHandle(id);
    const didDoc = await fetchDidDoc(did);
    const { handle: claimed } = parseDidDoc(didDoc); // also checks there is a PDS
    let handle = 'handle.invalid';
    if (claimed && (claimed.toLowerCase() === id || (await resolveHandle(claimed).catch(() => null)) === did)) handle = claimed.toLowerCase();
    if (!isDid(id) && handle !== id) throw new Error(`@${id} points to ${did}, but that DID doesn't list @${id} as its handle`);
    return { did, didDoc, handle };
  },
};

export function parseDidDoc(doc) {
  const svc = (doc.service || []).find((s) => s.id === '#atproto_pds' || s.id?.endsWith('#atproto_pds'));
  if (!svc) throw new Error('DID has no PDS');
  const aka = (doc.alsoKnownAs || []).find((a) => a.startsWith('at://'));
  return { pds: svc.serviceEndpoint.replace(/\/$/, ''), handle: aka ? aka.slice(5) : null };
}

async function getRecord(pds, did, collection, rkey) {
  const u = `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${collection}&rkey=${encodeURIComponent(rkey)}`;
  try { return (await getJson(u)).value; } catch { return null; }
}

async function listRecords(pds, did, collection) {
  const u = `${pds}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}&collection=${collection}&limit=20`;
  try { return (await getJson(u)).records || []; } catch { return []; }
}

const blobCid = (b) => b?.ref?.$link || b?.cid || null;

// Turns the raw records into what the client renders. Blob URLs point at our
// own /api/blob proxy so that canvas reads are same-origin.
export function shapeActor({ did, handle, sprite, stats, profile }) {
  const blobUrl = (cid) => (cid ? `/api/blob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}` : null);
  let s = null;
  if (sprite && blobCid(sprite.spriteSheet)) {
    const emotes = {};
    for (const [name, e] of Object.entries(sprite.emotes || {})) {
      if (!e || typeof e !== 'object' || !e.emoteSheet) continue;
      emotes[name] = { label: e.label || name, sheet: blobUrl(blobCid(e.emoteSheet)), talk: blobUrl(blobCid(e.talkSheet)) };
    }
    s = {
      sheet: blobUrl(blobCid(sprite.spriteSheet)),
      frameWidth: sprite.frameWidth || 48,
      frameHeight: sprite.frameHeight || 48,
      columns: sprite.columns || 3,
      rows: sprite.rows || 4,
      emotes,
    };
  }
  const systems = stats.map((r) => {
    const v = r.value || {};
    const data = v.data || v.stats || {};
    return { system: v.system || r.uri?.split('/').pop(), name: data?._meta?.name || null, summary: summarizeStats(data) };
  });
  return {
    did,
    handle,
    displayName: profile?.displayName || null,
    description: profile?.description ? String(profile.description).slice(0, 280) : null,
    sprite: s,
    stats: systems,
  };
}

// Pull a handful of headline values out of an arbitrary system payload.
function summarizeStats(data) {
  const out = [];
  const visit = (obj, prefix, depth) => {
    if (out.length >= 8 || depth > 2 || !obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_') || out.length >= 8) continue;
      if (typeof v === 'number' || (typeof v === 'string' && v.length < 32)) out.push([prefix + k, v]);
      else if (typeof v === 'object') visit(v, '', depth + 1);
    }
  };
  visit(data, '', 0);
  return out;
}

export async function loadActor(handleOrDid) {
  const id = handleOrDid.trim().replace(/^@/, '');
  const did = isDid(id) ? id : await resolveHandle(id);
  return cached(`a:${did}`, async () => {
    const { pds, handle: claimed } = await resolveDid(did);
    // A DID document can claim any handle; only trust it if the handle
    // resolves back to the same DID.
    let handle = null;
    if (claimed) {
      try { if ((await resolveHandle(claimed)) === did) handle = claimed; } catch { /* unverified */ }
    }
    if (!handle && !isDid(id)) handle = id; // we just resolved this handle to the DID
    const [sprite, stats, profile] = await Promise.all([
      getRecord(pds, did, 'actor.rpg.sprite', 'self'),
      listRecords(pds, did, 'actor.rpg.stats'),
      getRecord(pds, did, 'app.bsky.actor.profile', 'self'),
    ]);
    return { ...shapeActor({ did, handle, sprite, stats, profile }), pds };
  });
}

const blobCache = new Map(); // cid -> { type, buf }
const BLOB_CACHE_MAX = 500;

export async function fetchBlob(did, cid) {
  if (!isDid(did) || !/^[a-z0-9]{20,100}$/i.test(cid)) throw new Error('bad blob ref');
  const hit = blobCache.get(cid);
  if (hit) return hit;
  const { pds } = await resolveDid(did);
  const res = await fetch(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`blob ${res.status}`);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  if (!type.startsWith('image/')) throw new Error('blob is not an image');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 2 * 1024 * 1024) throw new Error('blob too large');
  if (blobCache.size >= BLOB_CACHE_MAX) blobCache.delete(blobCache.keys().next().value);
  const entry = { type, buf };
  blobCache.set(cid, entry);
  return entry;
}
