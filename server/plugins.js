// Interactive objects: every one is a WASM module (Rust, built with
// crates/agentoffice-plugin) run in the uploads sandbox (server/sandbox.js):
// a Dynamic Worker on Cloudflare, a worker thread on Node. The office's own
// objects on the map name their module (`wasm: 'jukebox.wasm'` in
// public/js/map.js, the file in public/plugins); objects people upload carry
// their code as `object.upload`. Whatever comes back is treated as untrusted:
// clipped, shape-checked, and turned into plain data the client renders
// without HTML. Without a sandbox, or when the call fails, the object is out
// of order.
//
// The sandbox has no network, so what a plugin needs from outside it asks the
// office for in its answer. Today that's the language model: an answer with
// `ask: { prompt, system?, maxTokens? }` makes the office run the model (the
// `ai` service: Workers AI on Cloudflare) and call the plugin again straight
// away with the same action and `reply: { text, model } | { error }`. Only the
// office's own objects get an answer; uploads get an error reply.

import { log } from './logs.js';
import { ZONES } from '../public/js/map.js';
import { cleanItem } from '../public/js/items.js';

export const TIMEOUT_MS = 5000;
export const AI_TIMEOUT_MS = 20000;
export const MAX_STATE = 32 * 1024;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);
const COLOR = /^#[0-9a-f]{3,8}$/i;
const ACTION = /^[\w:.-]{1,64}$/;
export const MAX_WATCH = 12;

// What a client may send: an action id and some typed text.
export function cleanRequest(m) {
  const action = typeof m?.action === 'string' && ACTION.test(m.action) ? m.action : 'use';
  const input = m?.input == null ? null : clip(m.input, 500);
  return { action, input };
}

// Workers AI models the office tries in turn (AI_MODEL in the env goes
// first). Cloudflare retires models now and then (llama-3.1-8b-instruct went
// on 2026-05-30), which is why there's a list: the first that answers wins.
export const AI_MODELS = ['@cf/meta/llama-3.1-8b-instruct-fast', '@cf/zai-org/glm-4.7-flash', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];

// The `ai` service on Cloudflare: ({ system, prompt, maxTokens }) → { text, model }.
export function workersAi(ai, { model = null } = {}) {
  const models = model ? [model, ...AI_MODELS.filter((m) => m !== model)] : AI_MODELS;
  // Workers AI models answer in one of two shapes.
  const replyText = (out) => String(out?.response ?? out?.choices?.[0]?.message?.content ?? '').trim();
  return async ({ system, prompt, maxTokens = 200 }) => {
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
    const errors = [];
    for (const m of models) {
      try {
        const text = replyText(await ai.run(m, { messages, max_tokens: maxTokens }));
        if (text) return { text, model: m };
        errors.push(`${m}: empty answer`);
      } catch (e) { errors.push(`${m}: ${e?.message || e}`); }
    }
    throw new Error(errors.join('; '));
  };
}

// Workers AI over Cloudflare's REST API, for the Node server: the same
// `run(model, input)` as the AI binding. Needs an account id and an API token
// with Workers AI access (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_TOKEN).
export function restAi({ accountId, token, fetch: f = fetch }) {
  return {
    async run(model, input) {
      const r = await f(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body?.success) throw new Error(body?.errors?.[0]?.message || `HTTP ${r.status}`);
      return body.result;
    },
  };
}

export class PluginHost {
  // sandbox: runs WASM { langs, via, run(upload, req) }.
  // wasm: file → Promise<{ code, version }>, the office's own modules (bundledWasm).
  // ai: ({ system, prompt, maxTokens }) → Promise<{ text, model }>, or null.
  constructor({ sandbox = null, wasm = null, ai = null, timeoutMs = TIMEOUT_MS, aiTimeoutMs = AI_TIMEOUT_MS, now = () => Date.now() } = {}) {
    this.sandbox = sandbox;
    this.wasm = wasm;
    this.ai = ai;
    this.timeoutMs = timeoutMs;
    this.aiTimeoutMs = aiTimeoutMs;
    this.now = now;
    // Last problem per object, for logs and troubleshooting.
    this.problems = {};
  }

  // The code an object runs: its upload, or the office's own module.
  async code(object) {
    if (object.upload) return object.upload;
    if (!object.wasm) throw new Error('it has no plugin');
    if (!this.wasm) throw new Error('this office can\'t read its WASM objects');
    const w = await this.wasm(object.wasm);
    return { id: object.id, version: w.version, lang: 'wasm', code: w.code };
  }

  // One call into the sandbox, with the time limit.
  async call(upload, req) {
    if (!this.sandbox?.langs.includes(upload.lang)) throw new Error(`this office can't run ${upload.lang} plugins`);
    return withTimeout(this.sandbox.run(upload, req), this.timeoutMs);
  }

  // The model's reply to a plugin's `ask`.
  async reply(object, ask) {
    if (!object.wasm) return { error: 'only the office\'s own objects can ask its model' };
    if (!this.ai) return { error: 'this office has no model' };
    const q = { prompt: clip(ask.prompt, 2000), system: ask.system ? clip(ask.system, 4000) : null, maxTokens: Math.min(400, Math.max(1, Math.floor(+ask.maxTokens) || 200)) };
    if (!q.prompt) return { error: 'empty question' };
    try {
      const r = await withTimeout(this.ai(q), this.aiTimeoutMs);
      return { text: clip(r.text, 2000), model: r.model || null };
    } catch (e) {
      const error = clip(e?.message || e, 300);
      log('error', `plugin:${object.id}`, `model failed: ${error}`);
      return { error };
    }
  }

  // object: { id, plugin, name, zone, wasm? , upload? }; actor: { id, did, handle, name, kind }.
  // upload: { id, version, lang, code } for objects people uploaded; wasm:
  // the file of one of the office's own (public/plugins).
  // inventory: what the actor carries (plugins see it, and change it only by
  // answering with give/take).
  // Returns { result, state, via } where state is what the object should keep.
  // event: { type: 'enter' | 'exit', zone } when the call is a zone the
  // object watches (answer `watch`), not someone using it.
  async interact({ object, actor, action = 'use', input = null, state = null, nearby = [], now = this.now(), inventory = [], event = null }) {
    const req = {
      object: { id: object.id, kind: object.plugin, name: object.name || object.plugin, zone: object.zone || null },
      actor: { id: actor.id, did: actor.did || null, handle: actor.handle || null, name: actor.name, kind: actor.kind },
      action, input, state, nearby: nearby.slice(0, 20), now, event,
      inventory: inventory.slice(0, 40).map(({ id, kind, name, emoji, qty, data }) => ({ id, kind, name, emoji, qty, ...(data !== undefined ? { data } : {}) })),
      // WASM has no randomness of its own.
      seed: Math.floor(Math.random() * 2 ** 53),
    };
    let raw, problem = null;
    try {
      const upload = await this.code(object);
      raw = await this.call(upload, req);
      // It asked the model: keep that answer's state and call again with the reply.
      if (raw?.ask && typeof raw.ask === 'object') {
        const kept = 'state' in raw ? raw.state : state;
        const reply = await this.reply(object, raw.ask);
        const again = await this.call(upload, { ...req, state: kept, reply, seed: Math.floor(Math.random() * 2 ** 53) });
        raw = again && typeof again === 'object' && !('state' in again) ? { ...again, state: kept } : again;
      }
      delete this.problems[object.id];
    } catch (e) {
      problem = clip(e?.message || e, 200);
      this.problems[object.id] = { at: req.now, message: problem };
      log('error', `plugin:${object.id}`, problem);
    }
    if (problem) {
      return {
        via: 'offline', state,
        result: { say: null, toast: `${req.object.name} is out of order right now (${problem}).`, display: { label: 'out of order', glow: '#ef4444' }, ui: null },
      };
    }
    const result = sanitize(raw);
    let next = state;
    if (raw && 'state' in raw) {
      const json = JSON.stringify(raw.state ?? null);
      if (json.length <= MAX_STATE) next = JSON.parse(json);
      else log('warning', `plugin:${object.id}`, `state over ${MAX_STATE} bytes, not saved`);
    }
    return { result, state: next, via: this.sandbox.via };
  }
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`no answer within ${ms} ms`)), ms); }),
  ]);
}

// A plugin's answer, reduced to what the office knows how to show.
export function sanitize(r) {
  r = r && typeof r === 'object' ? r : {};
  const act = (a) => (typeof a === 'string' && ACTION.test(a) ? a : null);
  const out = { say: r.say ? clip(r.say, 280) : null, toast: r.toast ? clip(r.toast, 200) : null, display: null, ui: null, wakeAt: null, give: [], take: [] };
  // Items for the person who used it (give), and things of theirs it uses up
  // (take, by kind): the office applies both together, all or nothing.
  if (Array.isArray(r.give)) out.give = r.give.slice(0, 5).map((i) => cleanItem(i)).filter(Boolean).map(({ at, from, ...i }) => i);
  if (Array.isArray(r.take)) {
    out.take = r.take.slice(0, 5).filter((t) => typeof t?.kind === 'string' && /^[a-z0-9][a-z0-9:._-]{0,31}$/.test(t.kind))
      .map((t) => ({ kind: t.kind, qty: Math.max(1, Math.min(20, Math.floor(+t.qty) || 1)) }));
  }
  if (r.display && typeof r.display === 'object') {
    out.display = {
      label: r.display.label ? clip(r.display.label, 40) : null,
      glow: COLOR.test(r.display.glow || '') ? r.display.glow : null,
      until: Number.isFinite(r.display.until) ? r.display.until : null,
      // Music the office plays near the object: tune `id` (public/js/music.js), started at `at` (epoch ms).
      music: r.display.music && /^[\w-]{1,32}$/.test(r.display.music.id || '') && Number.isFinite(r.display.music.at) ? { id: r.display.music.id, at: r.display.music.at } : null,
    };
  }
  // Ask to be called again (action 'tick') at this time, e.g. when a song ends.
  out.wakeAt = Number.isFinite(r.wakeAt) ? r.wakeAt : null;
  // Zones to hear about: the office calls back with `enter:<zone>` and
  // `exit:<zone>` as people walk in and out. [] stops; leave it out to keep.
  out.watch = Array.isArray(r.watch) ? [...new Set(r.watch.filter((z) => ZONES.some((x) => x.id === z)))].slice(0, MAX_WATCH) : null;
  const u = r.ui;
  if (u && typeof u === 'object') {
    out.ui = {
      title: clip(u.title, 60),
      text: clip(u.text, 1500),
      items: (Array.isArray(u.items) ? u.items : []).slice(0, 24).filter((i) => act(i?.action))
        .map((i) => ({ label: clip(i.label, 80), detail: clip(i.detail, 80), action: i.action, disabled: !!i.disabled })),
      buttons: (Array.isArray(u.buttons) ? u.buttons : []).slice(0, 6).filter((b) => act(b?.action))
        .map((b) => ({ label: clip(b.label, 30), action: b.action, primary: !!b.primary })),
      list: u.list && Array.isArray(u.list.rows) ? { title: clip(u.list.title, 60), rows: u.list.rows.slice(0, 20).map((x) => clip(x, 120)) } : null,
      input: u.input && act(u.input.action)
        ? { placeholder: clip(u.input.placeholder, 80), action: u.input.action, button: clip(u.input.button, 20) || 'Send', maxLength: Math.min(500, Math.max(1, Number(u.input.maxLength) || 200)) }
        : null,
    };
  }
  return out;
}
