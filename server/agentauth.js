// AT Protocol sign-in for agents.
//
// Agents can't do a browser OAuth dance, so they prove they control a DID
// the same way a domain proves it controls DNS: the office hands out a
// nonce, the agent writes it into a record in its own repo, and the office
// reads that record back from the PDS listed in the DID document.
//
//   1. challenge()                 -> { nonce, collection, rkey, record }
//   2. agent: com.atproto.repo.putRecord(collection, rkey, record)
//   3. verify(handleOrDid, nonce)  -> { did, handle, grant }
//   4. open /ws?grant=…            -> the agent joins as that DID
//      (MCP agents skip the grant: the hub passes the DID straight in)
//
// Agents without an AT Protocol account can get one from Roost
// (https://roost.latha.org), a PDS built for agents: `roostSignup` enrolls
// through Roost's keyless MCP endpoint and returns a bearer token, and
// `roostSignIn` uses that token once to write the proof record and verify it.
// The office never stores the token.

import { isDid, resolveHandle, resolveDid } from './atproto.js';

const env = globalThis.process?.env || {};
export const ROOST_URL = (env.ROOST_URL || 'https://roost.latha.org').replace(/\/$/, '');
export const PROOF_COLLECTION = env.PROOF_COLLECTION || 'org.agentoffice.proof';
export const PROOF_RKEY = 'self';

const TTL = 10 * 60 * 1000;
const token = (n) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class AgentAuth {
  constructor({ now = () => Date.now(), fetch: f, resolve = defaultResolve, office = 'agent office' } = {}) {
    // Never keep fetch itself as a method: `this.fetch(...)` would call it
    // with `this` = AgentAuth, which Workers rejects ("Illegal invocation").
    const fetchImpl = f || ((...a) => globalThis.fetch(...a));
    Object.assign(this, { now, fetch: (...a) => fetchImpl(...a), resolve, office });
    this.nonces = new Map(); // nonce -> expiresAt
    this.grants = new Map(); // grant -> { did, handle, expiresAt }
  }

  sweep() {
    const t = this.now();
    for (const [k, v] of this.nonces) if (v < t) this.nonces.delete(k);
    for (const [k, v] of this.grants) if (v.expiresAt < t) this.grants.delete(k);
  }

  challenge() {
    this.sweep();
    const nonce = token(16);
    this.nonces.set(nonce, this.now() + TTL);
    return {
      nonce,
      expiresInSeconds: TTL / 1000,
      collection: PROOF_COLLECTION,
      rkey: PROOF_RKEY,
      record: this.proofRecord(nonce),
    };
  }

  proofRecord(nonce) {
    return { $type: PROOF_COLLECTION, nonce, office: this.office, createdAt: new Date(this.now()).toISOString() };
  }

  // Read the proof record from the DID's own PDS and, if it carries a live
  // nonce, swap the nonce for a one-time grant the office's hello accepts.
  async verify(handleOrDid, nonce) {
    this.sweep();
    if (!this.nonces.has(nonce)) throw new Error('unknown or expired nonce; ask for a new challenge');
    const { did, handle, pds } = await this.resolve(String(handleOrDid || '').trim().replace(/^@/, ''));
    const u = `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${PROOF_COLLECTION}&rkey=${PROOF_RKEY}`;
    const res = await this.fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`no ${PROOF_COLLECTION}/${PROOF_RKEY} record in ${did}'s repo (${res.status})`);
    const { value } = await res.json();
    if (value?.nonce !== nonce) throw new Error('the proof record holds a different nonce');
    this.nonces.delete(nonce);
    const grant = token(18);
    this.grants.set(grant, { did, handle, expiresAt: this.now() + TTL });
    return { did, handle, grant };
  }

  // One-time: a grant signs in exactly one connection.
  redeem(grant) {
    this.sweep();
    const g = typeof grant === 'string' && this.grants.get(grant);
    if (!g) return null;
    this.grants.delete(grant);
    return { did: g.did, handle: g.handle };
  }

  // ---- Roost -------------------------------------------------------------

  async roostTerms() {
    const res = await this.fetch(`${ROOST_URL}/tos`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`roost /tos ${res.status}`);
    return res.text();
  }

  // Keyless enrollment through Roost's MCP endpoint (Streamable HTTP,
  // JSON responses, no session), so agents don't need RSA keys or DPoP.
  async roostSignup({ handle, acceptTerms, invite }) {
    if (acceptTerms !== true) throw new Error('read the Roost terms (roost_terms) and pass accept_terms: true');
    const args = { handle, accept_terms: true, ...(invite ? { invite } : {}) };
    const res = await this.fetch(`${ROOST_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'signup', arguments: args } }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const msg = parseRpc(text);
    if (msg?.error) throw new Error(`roost signup: ${msg.error.message}`);
    const result = msg?.result;
    const body = result?.structuredContent || tryJson(result?.content?.map((c) => c.text).join('\n')) || {};
    const flat = JSON.stringify(result ?? text);
    const out = {
      did: body.did || flat.match(/did:plc:[a-z2-7]{24}/)?.[0] || null,
      handle: body.handle || null,
      token: body.token || flat.match(/rmcp_[A-Za-z0-9_-]+/)?.[0] || null,
    };
    if (result?.isError || !out.token) throw new Error(`roost signup failed: ${result?.content?.[0]?.text || text.slice(0, 300)}`);
    return out;
  }

  // Use a Roost bearer token (or any PDS access token, with `pds`) once:
  // learn the DID, write the proof record, verify it, forget the token.
  async roostSignIn({ token, pds = ROOST_URL }) {
    if (!token) throw new Error('missing token');
    const base = String(pds).replace(/\/$/, '');
    if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('pds must be an https URL');
    const auth = { authorization: `Bearer ${token}` };
    const sres = await this.fetch(`${base}/xrpc/com.atproto.server.getSession`, { headers: { ...auth, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!sres.ok) throw new Error(`token rejected by ${new URL(base).host} (${sres.status})`);
    const session = await sres.json();
    const { nonce } = this.challenge();
    const wres = await this.fetch(`${base}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ repo: session.did, collection: PROOF_COLLECTION, rkey: PROOF_RKEY, record: this.proofRecord(nonce) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!wres.ok) throw new Error(`couldn't write the proof record (${wres.status}): ${(await wres.text()).slice(0, 200)}`);
    // Read it back from the PDS the DID document names, not the URL we were
    // handed, so a token for one PDS can't vouch for another DID.
    return this.verify(session.did, nonce);
  }
}

async function defaultResolve(id) {
  const did = isDid(id) ? id : await resolveHandle(id);
  const { pds, handle } = await resolveDid(did);
  return { did, handle: handle || (isDid(id) ? null : id), pds };
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

// A JSON body, or the last `data:` line of an SSE body.
function parseRpc(text) {
  const direct = tryJson(text);
  if (direct) return direct;
  const lines = text.split('\n').filter((l) => l.startsWith('data:'));
  return lines.length ? tryJson(lines.at(-1).slice(5).trim()) : null;
}
