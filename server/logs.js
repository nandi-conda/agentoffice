// Server logs for operators: a ring buffer in the World that MCP sessions
// allowed to read logs (see McpHub.can) can tail and stream.
//
// Everything goes through log(level, source, msg, data). It prints to the
// real console too (so `wrangler tail` and the Node terminal still show it),
// redacts secrets, and hands the entry to this isolate's sink: the World's
// LogBuffer when it lives here, otherwise a forwarder that ships entries to
// the World (entity Durable Objects, see worker/entities.js). captureConsole()
// routes plain console.* calls the same way, with source "console".
//
// Runtime-neutral: no node:* imports.

export const LEVELS = ['debug', 'info', 'notice', 'warning', 'error'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));
const MAX_MSG = 2000;

// ---- redaction ------------------------------------------------------------

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|credential|jwk|dpop|private|api[_-]?key|grant|nonce|refresh|access_?jwt|signature/i;
const PATTERNS = [
  [/\brmcp_[A-Za-z0-9_-]{6,}/g, 'rmcp_[redacted]'], // Roost bearer tokens
  [/\b(Bearer|DPoP|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '[jwt redacted]'],
  [/\b(ao_session|ao_[a-z]+)=[^;\s,"']+/g, '$1=[redacted]'], // session cookies
  [/([?&#](?:code|state|token|grant|access_token|refresh_token|key|credential|password|iss)=)[^&\s"']+/gi, '$1[redacted]'],
  [/(["']?(?:credential|password|secret|token)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1[redacted]'], // key: value inside text
];
const literals = new Set(); // exact secret values (MCP_TOKEN, SESSION_SECRET, TURN keys…)

// Remember a secret's exact value so it never shows up in a log line.
export function addSecret(value) {
  if (typeof value === 'string' && value.length >= 6) literals.add(value);
}

export function redact(v, depth = 0) {
  if (typeof v === 'string') {
    let s = v;
    for (const lit of literals) if (s.includes(lit)) s = s.split(lit).join('[redacted]');
    for (const [re, to] of PATTERNS) s = s.replace(re, to);
    return s;
  }
  if (v == null || typeof v !== 'object') return v;
  if (depth > 4) return '[…]';
  if (v instanceof Error) return { error: redact(v.message), ...(v.stack ? { stack: redact(String(v.stack).split('\n').slice(0, 6).join('\n')) } : {}) };
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 50)) out[k] = SECRET_KEY.test(k) && x != null && x !== '' ? '[redacted]' : redact(x, depth + 1);
  return out;
}

// ---- the buffer -------------------------------------------------------------

// The World's recent logs, with live subscribers (MCP sessions streaming them).
export class LogBuffer {
  constructor({ max = 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.now = now;
    this.entries = [];
    this.seq = 0;
    this.subs = new Set();
    this.onAdd = null; // the World persists a tail of them (worker/index.js)
  }

  // entry: { level, source, msg, data?, ts? }. Already redacted by log(),
  // but redacted again here because forwarded entries come from elsewhere.
  add(entry) {
    const e = {
      seq: ++this.seq,
      ts: Number(entry.ts) || this.now(),
      level: LEVELS.includes(entry.level) ? entry.level : 'info',
      source: String(entry.source || 'server').slice(0, 80),
      msg: redact(String(entry.msg ?? '')).slice(0, MAX_MSG),
      ...(entry.data !== undefined ? { data: redact(entry.data) } : {}),
    };
    this.entries.push(e);
    while (this.entries.length > this.max) this.entries.shift();
    for (const fn of this.subs) { try { fn(e); } catch { /* a broken subscriber doesn't stop the rest */ } }
    this.onAdd?.(e);
    return e;
  }

  // Filters shared by the tool, the resource and the live stream.
  static match(e, { level, sources, grep } = {}) {
    if (level && rank(e.level) < rank(level)) return false;
    if (sources?.length && !sources.some((s) => e.source === s || e.source.startsWith(`${s}:`))) return false;
    if (grep && !`${e.msg} ${e.data === undefined ? '' : JSON.stringify(e.data)}`.toLowerCase().includes(String(grep).toLowerCase())) return false;
    return true;
  }

  since(seq = 0, filter = {}, limit = 200) {
    const out = this.entries.filter((e) => e.seq > seq && LogBuffer.match(e, filter));
    return out.slice(-limit);
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  // Persisted tail, so a hibernating World doesn't forget everything.
  snapshot(n = 200) { return { seq: this.seq, entries: this.entries.slice(-n) }; }
  restore(snap) {
    if (!snap?.entries) return;
    this.entries = snap.entries.slice(-this.max);
    this.seq = Math.max(this.seq, Number(snap.seq) || 0, ...this.entries.map((e) => e.seq));
  }
}

// ---- routing ----------------------------------------------------------------

const sinks = { buffer: null, forward: null };
const real = {}; // console methods before captureConsole wrapped them
const METHOD = { debug: 'debug', info: 'log', notice: 'info', warning: 'warn', error: 'error' };
const out = (level) => real[METHOD[level]] || console[METHOD[level]] || console.log;
let inLog = false; // a sink that logs (or fails) mustn't loop back in

// The World registers its buffer; entity objects register a forwarder.
export function setLogSink({ buffer, forward } = {}) {
  if (buffer !== undefined) sinks.buffer = buffer;
  if (forward !== undefined) sinks.forward = forward;
}

export function log(level, source, msg, data, { print = true } = {}) {
  if (!LEVELS.includes(level)) level = 'info';
  const entry = { ts: Date.now(), level, source, msg: redact(String(msg ?? '')), ...(data !== undefined ? { data: redact(data) } : {}) };
  if (print) out(level)(`[${level}] ${source}: ${entry.msg}`, ...(data !== undefined ? [entry.data] : []));
  if (inLog) return;
  inLog = true;
  try {
    if (sinks.buffer) sinks.buffer.add(entry);
    else sinks.forward?.(entry);
  } catch { /* logging never throws */ } finally { inLog = false; }
}

// Plain console.* calls land in the logs too (source "console"). Once per isolate.
export function captureConsole() {
  if (real.log) return;
  for (const [m, level] of [['log', 'info'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warning'], ['error', 'error']]) {
    const orig = console[m].bind(console);
    real[m] = orig;
    console[m] = (...args) => {
      orig(...args);
      const msg = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : safeJson(a))).join(' ');
      log(level, 'console', msg, undefined, { print: false });
    };
  }
}

const safeJson = (v) => { try { return JSON.stringify(redact(v)); } catch { return String(v); } };

// Batches entries from an entity object to the World: one apply() per tick.
export function forwarder(send) {
  let queue = [], timer = null;
  return (entry) => {
    queue.push(entry);
    if (queue.length > 200) queue.shift();
    timer ||= setTimeout(() => {
      const batch = queue; queue = []; timer = null;
      Promise.resolve().then(() => send(batch)).catch((e) => out('error')('log forward failed', e?.message));
    }, 0);
  };
}
