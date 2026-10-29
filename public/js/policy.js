// Access policies for channel rooms: who may walk in. Shared by the server
// (the World enforces it at the door), the browser (the sign by the door)
// and agents. No DOM, no network.
//
// A policy comes from whatever source has the channel (freeq.js translates
// freeq's channel policies; rooms people open in the office set their own)
// and always has this shape:
//
//   { source, version, require, roles, rules, rulesHash, endpoints, deny, url }
//
// `require` is a requirement tree in freeq's DSL (freeq-server
// src/policy/types.rs), plus INVITE for the office's own invite-only rooms:
//   { type: 'OPEN' }                                   anyone
//   { type: 'ACCEPT', hash }                           accept the rules text
//   { type: 'PRESENT', credential_type, issuer? }      hold a credential
//   { type: 'PROVE', proof_type }                      prove a capability
//   { type: 'INVITE' }                                 be let in by someone inside
//   { type: 'ALL' | 'ANY', requirements: [...] }   { type: 'NOT', requirement }
// The office can check ACCEPT (you accept at the sign) and INVITE (someone
// inside lets you in). Credentials and proofs are checked by the source:
// people the source already lets into the channel come in on its word
// (`allow`, a list of DIDs it hands over with the channel).

export const OPEN = { type: 'OPEN' };
const MAX_NODES = 64, MAX_DEPTH = 8;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);

// Keep only what the office understands, fail-closed on anything else.
export function cleanRequirement(r, depth = 0, count = { n: 0 }) {
  if (!r || typeof r !== 'object' || depth > MAX_DEPTH || ++count.n > MAX_NODES) return { type: 'NOT', requirement: OPEN };
  const type = String(r.type || '').toUpperCase();
  switch (type) {
    case 'OPEN': case 'INVITE': return { type };
    case 'ACCEPT': return { type, hash: clip(r.hash, 128) };
    case 'PRESENT': return { type, credential_type: clip(r.credential_type, 64), ...(r.issuer ? { issuer: clip(r.issuer, 200) } : {}) };
    case 'PROVE': return { type, proof_type: clip(r.proof_type, 64) };
    case 'ALL': case 'ANY': return { type, requirements: (Array.isArray(r.requirements) ? r.requirements : []).slice(0, 16).map((x) => cleanRequirement(x, depth + 1, count)) };
    case 'NOT': return { type, requirement: cleanRequirement(r.requirement, depth + 1, count) };
    default: return { type: 'NOT', requirement: OPEN }; // unknown: nobody
  }
}

export function cleanPolicy(p) {
  if (!p || typeof p !== 'object') return null;
  const endpoints = {};
  for (const [k, e] of Object.entries(p.endpoints || {}).slice(0, 12)) {
    const url = clip(e?.url, 500);
    endpoints[clip(k, 64)] = { label: clip(e?.label || k, 80), ...(/^https:\/\//.test(url) ? { url } : {}) };
  }
  const roles = {};
  for (const [k, r] of Object.entries(p.roles || {}).slice(0, 8)) roles[clip(k, 32)] = cleanRequirement(r);
  return {
    source: clip(p.source || 'office', 16),
    version: Number.isFinite(+p.version) ? +p.version : 1,
    require: cleanRequirement(p.require || OPEN),
    roles,
    rules: p.rules ? clip(p.rules, 2000) : null,
    rulesHash: p.rulesHash ? clip(p.rulesHash, 128) : null,
    endpoints,
    deny: (Array.isArray(p.deny) ? p.deny : []).filter((d) => /^did:/.test(d)).slice(0, 200),
    url: /^https:\/\//.test(p.url || '') ? clip(p.url, 300) : null,
  };
}

// Does someone meet the policy? ctx: { did, accepted: Set of rules hashes,
// invited: bool, allowed: bool (the source or the room's opener vouches) }.
// Returns { ok, needs: [{ type, label, url?, hash? }] } with what's missing.
export function evaluate(policy, ctx = {}) {
  if (!policy) return { ok: true, needs: [] };
  if (ctx.did && policy.deny?.includes(ctx.did)) return { ok: false, banned: true, needs: [{ type: 'BANNED', label: 'You are banned from this channel' }] };
  if (ctx.allowed) return { ok: true, needs: [], vouched: true };
  const accepted = ctx.accepted || new Set();
  const label = (r) => policy.endpoints?.[r.credential_type]?.label || r.credential_type;
  const walk = (r) => {
    switch (r.type) {
      case 'OPEN': return { ok: true, needs: [] };
      case 'ACCEPT': return accepted.has(r.hash) ? { ok: true, needs: [] } : { ok: false, needs: [{ type: 'ACCEPT', label: 'Accept the channel rules', hash: r.hash }] };
      case 'INVITE': return ctx.invited ? { ok: true, needs: [] } : { ok: false, needs: [{ type: 'INVITE', label: 'Be let in by someone inside (knock)' }] };
      case 'PRESENT': {
        const e = policy.endpoints?.[r.credential_type];
        return { ok: false, needs: [{ type: 'PRESENT', label: `Hold a ${label(r)} credential`, ...(e?.url ? { url: e.url } : {}) }] };
      }
      case 'PROVE': return { ok: false, needs: [{ type: 'PROVE', label: `Prove ${r.proof_type}` }] };
      case 'ALL': {
        const parts = r.requirements.map(walk);
        return { ok: parts.every((x) => x.ok), needs: parts.flatMap((x) => x.needs) };
      }
      case 'ANY': {
        const parts = r.requirements.map(walk);
        if (!parts.length || parts.some((x) => x.ok)) return { ok: parts.length > 0, needs: [] };
        return { ok: false, needs: parts.flatMap((x) => x.needs).map((n, i) => (i ? { ...n, or: true } : n)) };
      }
      case 'NOT': return walk(r.requirement).ok ? { ok: false, needs: [{ type: 'NOT', label: 'Not allowed' }] } : { ok: true, needs: [] };
      default: return { ok: false, needs: [] };
    }
  };
  return walk(policy.require || OPEN);
}

// The leaf types in a requirement tree.
const leaves = (r, out = new Set()) => {
  if (!r) return out;
  if (r.requirements) r.requirements.forEach((x) => leaves(x, out));
  else if (r.requirement) leaves(r.requirement, out);
  else out.add(r.type);
  return out;
};

// For the sign by the door: an icon and a few words.
export function summary(policy) {
  const types = leaves(policy?.require || OPEN);
  if (!policy || (types.size === 1 && types.has('OPEN'))) return { icon: '🚪', text: 'open', open: true };
  const parts = [];
  if (types.has('INVITE')) parts.push(['🔒', 'invite only']);
  if (types.has('ACCEPT')) parts.push(['📜', 'accept rules']);
  if (types.has('PRESENT') || types.has('PROVE')) parts.push(['🎫', 'credential']);
  if (types.has('NOT') && !parts.length) parts.push(['⛔', 'closed']);
  return { icon: parts.map((p) => p[0]).join('') || '🔒', text: parts.map((p) => p[1]).join(' + ') || 'restricted', open: false };
}

// A requirement tree in words, for the policy panel and the API docs.
export function describe(r, policy) {
  if (!r) return 'anyone';
  switch (r.type) {
    case 'OPEN': return 'anyone';
    case 'ACCEPT': return 'accept the channel rules';
    case 'INVITE': return 'be let in by someone inside';
    case 'PRESENT': return `hold a ${policy?.endpoints?.[r.credential_type]?.label || r.credential_type} credential`;
    case 'PROVE': return `prove ${r.proof_type}`;
    case 'ALL': return r.requirements.map((x) => describe(x, policy)).join(' and ');
    case 'ANY': return r.requirements.map((x) => describe(x, policy)).join(' or ');
    case 'NOT': return `not (${describe(r.requirement, policy)})`;
    default: return r.type;
  }
}

// The office's own rooms: what the person who opened one picks.
export function officePolicy(mode, rules) {
  if (mode === 'invite') return cleanPolicy({ source: 'office', require: { type: 'INVITE' } });
  if (mode === 'rules' && rules) {
    const hash = rulesHash(rules);
    return cleanPolicy({ source: 'office', require: { type: 'ACCEPT', hash }, rules, rulesHash: hash });
  }
  return null;
}

// A short stable id for a rules text (not cryptographic; it only says
// "these rules, not edited ones").
export function rulesHash(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const c of String(text)) { const k = c.codePointAt(0); h1 = Math.imul(h1 ^ k, 16777619); h2 = Math.imul(h2 + k, 2246822519); }
  return `office-${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}
