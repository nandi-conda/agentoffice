// The plugin sandbox: every interactive object is WASM run here, the office's
// own (public/plugins) and the code signed-in people upload through the web UI
// (or MCP) and place on the map. The contract is in server/plugins.js and
// docs/plugins.md:
//
//   Cloudflare  a Dynamic Worker per upload (the Worker Loader binding LOADER,
//               Workers Paid plan): its own isolate, no network
//               (globalOutbound: null), no bindings, a CPU limit per call.
//               Runs WASM and JS uploads.
//   Node        a worker thread per call, killed after the timeout. WASM only:
//               Node has no safe way to run untrusted JS.
//
// A Worker can't compile WASM from bytes (WebAssembly.compile is blocked), so
// the office never runs uploads itself: it only checks them (inspectWasm) and
// hands them to the sandbox, where they arrive as a ready module.
//
// The WASM ABI (docs/uploads.md): the module exports `memory`,
// `alloc(len) -> ptr` and `interact(ptr, len) -> i64`. The office writes the
// request JSON into memory from alloc, calls interact, and reads the answer
// JSON at (result >> 32) with length (result & 0xffffffff). Allowed imports:
// office.log(ptr, len) and env.abort (AssemblyScript), nothing else.
//
// Runtime-neutral: no node:* here (see sandbox-node.js for the Node side).

import { readManifest } from '../public/js/manifest.js';
import { log } from './logs.js';

export const MAX_WASM = 512 * 1024;
export const MAX_JS = 128 * 1024;
export const MAX_ANSWER = 64 * 1024;
// The office's own programs (the desk computer) answer with whole workstations.
export const MAX_PROGRAM_ANSWER = 1024 * 1024;
export const MAX_PAGES = 256; // initial memory: 16 MiB
export const CPU_MS = 50;
export const LANGS = ['wasm', 'js'];
export const IMPORTS = ['office.log', 'env.abort'];

// Runs one call of a WASM plugin. Self-contained (no outer references, not
// even imports), because its source is shipped into the sandbox with
// toString(). What the plugin logs goes to onLog(text), and the sandbox hands
// it back to the office to log there (logLines). maxAnswer: bytes the
// answer may take (64 KB; the office's own programs get more).
export async function runWasm(module, req, onLog = null, maxAnswer = 64 * 1024) {
  if (!(module instanceof WebAssembly.Module)) module = await WebAssembly.compile(module);
  let mem = null;
  const logs = [];
  const text = (p, n) => new TextDecoder().decode(new Uint8Array(mem.buffer, p >>> 0, n >>> 0));
  const imports = {
    office: { log: (p, n) => { if (logs.length < 20) logs.push(text(p, Math.min(n >>> 0, 500))); } },
    env: { abort: () => { throw new Error('the plugin aborted'); } },
  };
  const wanted = WebAssembly.Module.imports(module);
  const given = {};
  for (const i of wanted) {
    const f = imports[i.module]?.[i.name];
    if (!f || i.kind !== 'function') throw new Error(`the plugin imports ${i.module}.${i.name}, which the office doesn't provide`);
    (given[i.module] ||= {})[i.name] = f;
  }
  const { exports: x } = await WebAssembly.instantiate(module, given);
  mem = x.memory;
  if (!(mem instanceof WebAssembly.Memory) || typeof x.alloc !== 'function' || typeof x.interact !== 'function') {
    throw new Error('the plugin must export memory, alloc and interact');
  }
  const input = new TextEncoder().encode(JSON.stringify(req));
  const ptr = x.alloc(input.length) >>> 0;
  new Uint8Array(mem.buffer, ptr, input.length).set(input);
  const r = BigInt.asUintN(64, BigInt(x.interact(ptr, input.length)));
  const outPtr = Number(r >> 32n), outLen = Number(r & 0xffffffffn);
  if (outLen > maxAnswer) throw new Error(`the plugin answered ${outLen} bytes (${Math.round(maxAnswer / 1024)} KB at most)`);
  if (outPtr + outLen > mem.buffer.byteLength) throw new Error('the plugin answered outside its memory');
  const answer = outLen ? JSON.parse(text(outPtr, outLen)) : {};
  if (logs.length && onLog) onLog(logs.join(' | '));
  return answer;
}

// ---- checking an upload without running it --------------------------------

function reader(bytes) {
  let i = 0;
  const r = {
    get pos() { return i; },
    set pos(v) { i = v; },
    byte() { if (i >= bytes.length) throw new Error('the file ends early'); return bytes[i++]; },
    u32() { let n = 0, shift = 0, b; do { b = r.byte(); n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80 && shift < 70); return n; },
    name() { const n = r.u32(); if (i + n > bytes.length) throw new Error('the file ends early'); const s = new TextDecoder().decode(bytes.subarray(i, i + n)); i += n; return s; },
    limits() { const flag = r.byte(); const min = r.u32(); const max = flag & 1 ? r.u32() : null; return { min, max }; },
  };
  return r;
}

// The imports, exports and memory of a WASM file, from its sections (no
// compiling). Throws with a readable reason when it isn't WebAssembly.
export function inspectWasm(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('not a WebAssembly file (no \\0asm header)');
  if (bytes[4] !== 1 || bytes[5] || bytes[6] || bytes[7]) throw new Error('only WebAssembly version 1 modules are supported (not components)');
  const r = reader(bytes);
  r.pos = 8;
  const out = { imports: [], exports: [], memory: null };
  const KINDS = ['function', 'table', 'memory', 'global', 'tag'];
  while (r.pos < bytes.length) {
    const id = r.byte(), size = r.u32(), end = r.pos + size;
    if (end > bytes.length) throw new Error('a section runs past the end of the file');
    if (id === 2) {
      for (let n = r.u32(); n > 0; n--) {
        const module = r.name(), name = r.name(), kind = r.byte();
        if (kind === 0) r.u32();
        else if (kind === 1) { r.byte(); r.limits(); }
        else if (kind === 2) out.memory = r.limits();
        else if (kind === 3) { r.byte(); r.byte(); }
        else if (kind === 4) { r.byte(); r.u32(); }
        else throw new Error(`unknown import kind ${kind}`);
        out.imports.push({ module, name, kind: KINDS[kind] });
      }
    } else if (id === 5) {
      if (r.u32() > 0) out.memory = r.limits();
    } else if (id === 7) {
      for (let n = r.u32(); n > 0; n--) {
        const name = r.name(), kind = r.byte();
        r.u32();
        out.exports.push({ name, kind: KINDS[kind] || String(kind) });
      }
    }
    r.pos = end;
  }
  return out;
}

const b64chars = (s) => /^[A-Za-z0-9+/]*={0,2}$/.test(s);
export function fromBase64(s) {
  s = String(s || '').replace(/\s+/g, '');
  if (!b64chars(s)) throw new Error('code must be base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Whether an upload can run: { size, exports, manifest } or throws with the
// reason. manifest is what the module says about itself (public/js/manifest.js), or null.
export function checkUpload(lang, bytes) {
  if (!LANGS.includes(lang)) throw new Error(`lang must be ${LANGS.join(' or ')}`);
  if (!bytes.length) throw new Error('the file is empty');
  if (lang === 'js') {
    if (bytes.length > MAX_JS) throw new Error(`JS plugins can be ${MAX_JS / 1024} KB at most`);
    const src = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/\binteract\b/.test(src)) throw new Error('a JS plugin must export a function called interact');
    return { size: bytes.length };
  }
  if (bytes.length > MAX_WASM) throw new Error(`WASM plugins can be ${MAX_WASM / 1024} KB at most`);
  const w = inspectWasm(bytes);
  const has = (name, kind) => w.exports.some((e) => e.name === name && e.kind === kind);
  const missing = [['memory', 'memory'], ['alloc', 'function'], ['interact', 'function']].filter(([n, k]) => !has(n, k)).map(([n]) => n);
  if (missing.length) throw new Error(`the module must export ${missing.join(', ')} (see the ABI in the docs)`);
  const bad = w.imports.filter((i) => i.kind !== 'function' || !IMPORTS.includes(`${i.module}.${i.name}`));
  if (bad.length) throw new Error(`the module imports ${bad.map((i) => `${i.module}.${i.name}`).join(', ')}; only ${IMPORTS.join(' and ')} are provided (no WASI)`);
  if (w.memory && w.memory.min > MAX_PAGES) throw new Error(`the module starts with ${w.memory.min * 64} KiB of memory (${MAX_PAGES * 64} KiB at most)`);
  return { size: bytes.length, exports: w.exports.map((e) => e.name), manifest: readManifest(bytes) };
}

// The office's own WASM objects: read(file) gives the bytes of
// public/plugins/<file> (the disk on Node, the ASSETS binding on Cloudflare).
// Returns file -> Promise<{ code (base64), version, permissions }>, each read
// once. The office's own objects get the permissions their manifest declares.
export function bundledWasm(read) {
  const cache = new Map();
  return (file) => {
    if (!/^[\w-]+\.wasm$/.test(file)) return Promise.reject(new Error(`bad wasm file ${file}`));
    if (!cache.has(file)) {
      const p = (async () => {
        const bytes = new Uint8Array(await read(file));
        const info = checkUpload('wasm', bytes);
        const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return { code: toBase64(bytes), version: [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(''), permissions: info.manifest?.permissions || [] };
      })();
      p.catch(() => cache.delete(file)); // try again next time
      cache.set(file, p);
    }
    return cache.get(file);
  };
}

// What an upload logged during a call (office.log), into the server logs.
export function logLines(upload, logs) {
  if (logs) log('info', `upload:${upload.id}`, String(logs).slice(0, 10000));
}

// ---- Cloudflare: one Dynamic Worker per upload -------------------------------

// The main module of each Dynamic Worker: an entrypoint whose interact() runs
// the uploaded module. The upload itself is plugin.wasm or plugin.js.
export const WRAPPERS = {
  wasm: `import { WorkerEntrypoint } from 'cloudflare:workers';
import plugin from './plugin.wasm';
const __name = (f) => f; // esbuild's keepNames helper, which runWasm's source may call
const runWasm = ${runWasm.toString()};
export default class extends WorkerEntrypoint {
  async interact(req, maxAnswer) {
    let logs = null;
    const answer = await runWasm(plugin, req, (l) => { logs = l; }, maxAnswer);
    return { answer, logs };
  }
}
`,
  js: `import { WorkerEntrypoint } from 'cloudflare:workers';
import * as plugin from './plugin.js';
const fn = typeof plugin.interact === 'function' ? plugin.interact
  : typeof plugin.default?.interact === 'function' ? plugin.default.interact.bind(plugin.default)
  : typeof plugin.default === 'function' ? plugin.default : null;
export default class extends WorkerEntrypoint {
  async interact(req) {
    if (!fn) throw new Error('the plugin must export a function called interact');
    return { answer: await fn(req), logs: null };
  }
}
`,
};

export class DynamicSandbox {
  // loader: env.LOADER, a [[worker_loaders]] binding.
  constructor(loader, { cpuMs = CPU_MS, compatibilityDate = '2026-10-01' } = {}) {
    this.loader = loader;
    this.cpuMs = cpuMs;
    this.compatibilityDate = compatibilityDate;
    this.langs = LANGS;
    this.via = 'dynamic-worker';
  }

  // upload: { id, version, lang, code (base64) }. The loader keeps the
  // isolate warm by id, so the code is only decoded when it starts cold.
  async run(upload, req, { maxAnswer = MAX_ANSWER } = {}) {
    const worker = this.loader.get(`${upload.id}@${upload.version}`, () => this.workerCode(upload));
    const { answer, logs } = await worker.getEntrypoint().interact(req, maxAnswer);
    logLines(upload, logs);
    return answer;
  }

  workerCode({ lang, code }) {
    const bytes = fromBase64(code);
    return {
      compatibilityDate: this.compatibilityDate,
      mainModule: 'main.js',
      modules: {
        'main.js': WRAPPERS[lang],
        ...(lang === 'wasm' ? { 'plugin.wasm': { wasm: bytes.buffer } } : { 'plugin.js': new TextDecoder().decode(bytes) }),
      },
      env: {},
      globalOutbound: null,
      limits: { cpuMs: this.cpuMs },
    };
  }
}
