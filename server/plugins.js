// Interactive objects backed by plugin Workers. An object on the map names a
// plugin (`plugin: 'jukebox'`); on Cloudflare the office's env carries a
// service binding PLUGIN_JUKEBOX to a WorkerEntrypoint in another Worker, and
// using the object calls its `interact()` over RPC. Whatever comes back is
// treated as untrusted: clipped, shape-checked, and turned into plain data the
// client renders without HTML.
//
// When the binding is missing or the call fails, the object falls back to a
// built-in copy of the handler if the office ships one (the example objects in
// plugins/objects/src/objects.js), and otherwise shows itself as out of order.
// The Node server has no bindings, so it always runs the built-ins.
//
// Uploaded objects (server/entities/gallery.js) carry their code as
// `object.upload` and run in the sandbox instead (server/sandbox.js): a
// Dynamic Worker on Cloudflare, a worker thread on Node. They have no
// built-in to fall back to; when the sandbox fails they're out of order.

import { OBJECTS } from '../plugins/objects/src/objects.js';
import { cleanItem } from '../public/js/items.js';

export const TIMEOUT_MS = 5000;
export const MAX_STATE = 32 * 1024;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);
const COLOR = /^#[0-9a-f]{3,8}$/i;
const ACTION = /^[\w:.-]{1,64}$/;

export const bindingName = (plugin) => `PLUGIN_${String(plugin).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

// What a client may send: an action id and some typed text.
export function cleanRequest(m) {
  const action = typeof m?.action === 'string' && ACTION.test(m.action) ? m.action : 'use';
  const input = m?.input == null ? null : clip(m.input, 500);
  return { action, input };
}

export class PluginHost {
  constructor({ env = {}, builtins = OBJECTS, sandbox = null, timeoutMs = TIMEOUT_MS, now = () => Date.now() } = {}) {
    this.env = env;
    this.sandbox = sandbox; // runs uploaded objects: { langs, via, run(upload, req) }
    this.builtins = builtins;
    this.timeoutMs = timeoutMs;
    this.now = now;
    // Last problem per plugin, for /api/office and the docs' troubleshooting.
    this.problems = {};
  }

  // How each plugin is wired right now: 'binding', 'builtin' or 'missing'.
  status(plugins) {
    const out = {};
    for (const name of plugins) {
      out[name] = { via: this.env[bindingName(name)] ? 'binding' : this.builtins[name] ? 'builtin' : 'missing' };
      if (this.problems[name]) out[name].problem = this.problems[name];
    }
    return out;
  }

  // object: { id, plugin, name, zone, upload? }; actor: { id, did, handle, name, kind }.
  // upload: { id, version, lang, code } for objects people uploaded.
  // inventory: what the actor carries (plugins see it, and change it only by
  // answering with give/take).
  // Returns { result, state, via } where state is what the object should keep.
  async interact({ object, actor, action = 'use', input = null, state = null, nearby = [], now = this.now(), inventory = [] }) {
    const req = {
      object: { id: object.id, kind: object.plugin, name: object.name || object.plugin, zone: object.zone || null },
      actor: { id: actor.id, did: actor.did || null, handle: actor.handle || null, name: actor.name, kind: actor.kind },
      action, input, state, nearby: nearby.slice(0, 20), now,
      inventory: inventory.slice(0, 40).map(({ id, kind, name, emoji, qty, data }) => ({ id, kind, name, emoji, qty, ...(data !== undefined ? { data } : {}) })),
    };
    const binding = object.upload ? null : this.env[bindingName(object.plugin)];
    let raw, via, problem = null;
    if (object.upload) {
      if (!this.sandbox?.langs.includes(object.upload.lang)) problem = `this office can't run uploaded ${object.upload.lang} plugins`;
      else {
        try {
          raw = await withTimeout(this.sandbox.run(object.upload, req), this.timeoutMs);
          via = this.sandbox.via;
          delete this.problems[object.id];
        } catch (e) {
          problem = clip(e?.message || e, 200);
          this.problems[object.id] = { at: req.now, message: problem };
          console.error(`upload ${object.id}:`, problem);
        }
      }
    } else if (binding) {
      try {
        raw = await withTimeout(binding.interact(req), this.timeoutMs);
        via = 'binding';
        delete this.problems[object.plugin];
      } catch (e) {
        this.problems[object.plugin] = { at: req.now, message: clip(e?.message || e, 200) };
        console.error(`plugin ${object.plugin}:`, e?.message || e);
      }
    }
    if (!via && !object.upload) {
      const builtin = this.builtins[object.plugin];
      if (builtin) {
        try { raw = await withTimeout(builtin(req, this.env), this.timeoutMs); via = 'builtin'; }
        catch (e) { console.error(`builtin ${object.plugin}:`, e?.message || e); }
      }
    }
    if (!via) {
      return {
        via: 'offline', state,
        result: { say: null, toast: `${req.object.name} is out of order right now${problem ? ` (${problem})` : ''}.`, display: { label: 'out of order', glow: '#ef4444' }, ui: null },
      };
    }
    const result = sanitize(raw);
    let next = state;
    if (raw && 'state' in raw) {
      const json = JSON.stringify(raw.state ?? null);
      if (json.length <= MAX_STATE) next = JSON.parse(json);
      else console.error(`plugin ${object.plugin}: state over ${MAX_STATE} bytes, not saved`);
    }
    return { result, state: next, via };
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
