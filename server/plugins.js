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
// Some answers need a permission (public/js/permissions.js): `take` and
// `notify` (trusted) and `unlock` (privileged: into a room someone else booked). The office's
// own objects have what their manifest declares; uploads what was granted at
// upload, which the uploader's role decided. Without it, a take or a note
// is dropped and an unlock refused.

import { log } from './logs.js';
import { ZONES } from '../public/js/map.js';
import { cleanItem, SKELETON_KEY } from '../public/js/items.js';
import { roomById } from '../public/js/rooms.js';
import { cleanPermissions } from '../public/js/permissions.js';
import { MAX_PROGRAM_ANSWER } from './sandbox.js';

export const TIMEOUT_MS = 5000;
export const MAX_STATE = 32 * 1024;
export const MAX_DATA = 16 * 1024;
// JSON sent with an action (a whiteboard stroke).
export const MAX_REQUEST_DATA = 16 * 1024;
// The feed (Permission::Feed): entries per answer, bytes each, entries kept.
export const MAX_APPEND = 20;
export const MAX_FEED_ENTRY = 8 * 1024;
export const MAX_FEED = 3000;
// What the office's own programs (the desk computer) may keep: a whole workstation.
export const MAX_PROGRAM_STATE = MAX_PROGRAM_ANSWER - 64 * 1024;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);
const COLOR = /^#[0-9a-f]{3,8}$/i;
const ACTION = /^[\w:.-]{1,64}$/;
export const MAX_WATCH = 12;
export const MAX_NOTES = 10;
export const MAX_NOTE_TO = 40;
const KIND = /^[\w-]{1,16}$/;

// What a client may send: an action id, some typed text, and some JSON.
// The games a panel can ask the browser to play (Ui::game).
export const GAMES = ['snake'];

export function cleanRequest(m) {
  const action = typeof m?.action === 'string' && ACTION.test(m.action) ? m.action : 'use';
  const input = m?.input == null ? null : clip(m.input, 500);
  return { action, input, data: cleanData(m?.data, MAX_REQUEST_DATA) };
}

export class PluginHost {
  // sandbox: runs WASM { langs, via, run(upload, req) }.
  // wasm: file → Promise<{ code, version }>, the office's own modules (bundledWasm).
  constructor({ sandbox = null, wasm = null, timeoutMs = TIMEOUT_MS, now = () => Date.now() } = {}) {
    this.sandbox = sandbox;
    this.wasm = wasm;
    this.timeoutMs = timeoutMs;
    this.now = now;
    // Last problem per object, for logs and troubleshooting.
    this.problems = {};
  }

  // The code an object runs and what it may do: its upload with what was
  // granted at upload, or the office's own module with what it declares.
  async code(object) {
    if (object.upload) return { upload: object.upload, permissions: cleanPermissions(object.permissions) };
    if (!object.wasm) throw new Error('it has no plugin');
    if (!this.wasm) throw new Error('this office can\'t read its WASM objects');
    const w = await this.wasm(object.wasm);
    return { upload: { id: object.id, version: w.version, lang: 'wasm', code: w.code }, permissions: cleanPermissions(w.permissions) };
  }

  // One call into the sandbox, with the time limit.
  async call(upload, req, opts) {
    if (!this.sandbox?.langs.includes(upload.lang)) throw new Error(`this office can't run ${upload.lang} plugins`);
    return withTimeout(this.sandbox.run(upload, req, opts), this.timeoutMs);
  }

  // One of the office's own modules run as a program, not an object someone
  // walks up to: the desk computer (server/entities/workstation.js) calls a
  // method with its params as JSON `data` (not held to the 16 KB an action's
  // data gets), and the module answers with `reply` or `error` (SDK:
  // Request::data_as, Response::reply / fail). Only modules the office
  // ships (object.wasm), never uploads, and nothing beyond the basics: an
  // answer's give, take or unlock is ignored. They keep more than objects
  // on the map (a workstation with its notes), up to MAX_PROGRAM_STATE.
  // Returns { reply, state, wakeAt, toast, via }; throws the module's error,
  // or that it's out of order.
  async program({ object, actor, method, args = null, state = null, now = this.now() }) {
    const name = object.name || object.plugin;
    if (!object.wasm || object.upload) throw new Error('only the office\'s own modules run as programs');
    const req = {
      object: { id: object.id, kind: object.plugin, name, zone: object.zone || null },
      actor: { id: actor.id, did: actor.did || null, handle: actor.handle || null, name: actor.name, kind: actor.kind, role: actor.role || null },
      action: method, input: null, data: args, state, nearby: [], inventory: [], now, event: null, permissions: [],
      seed: Math.floor(Math.random() * 2 ** 53),
    };
    let raw;
    try {
      const { upload } = await this.code(object);
      raw = await this.call(upload, req, { maxAnswer: MAX_PROGRAM_ANSWER });
      delete this.problems[object.id];
    } catch (e) {
      const problem = clip(e?.message || e, 200);
      this.problems[object.id] = { at: now, message: problem };
      log('error', `plugin:${object.id}`, problem);
      throw new Error(`the ${name} is out of order right now (${problem})`);
    }
    raw = raw && typeof raw === 'object' ? raw : {};
    if (raw.error) throw new Error(clip(raw.error, 300));
    let next = state;
    if ('state' in raw) {
      const json = JSON.stringify(raw.state ?? null);
      if (json.length > MAX_PROGRAM_STATE) throw new Error(`the ${name} is full (over ${MAX_PROGRAM_STATE >> 10} KB): delete something first`);
      next = JSON.parse(json);
    }
    return {
      reply: raw.reply ?? null, state: next,
      wakeAt: Number.isFinite(raw.wakeAt) ? raw.wakeAt : null,
      toast: raw.toast ? clip(raw.toast, 200) : null,
      via: this.sandbox.via,
    };
  }

  // object: { id, plugin, name, zone, wasm? , upload? }; actor: { id, did, handle, name, kind, role }.
  // upload: { id, version, lang, code } for objects people uploaded; wasm:
  // the file of one of the office's own (public/plugins).
  // inventory: what the actor carries (plugins see it, and change it only by
  // answering with give/take).
  // Returns { result, state, via } where state is what the object should keep.
  // event: { type: 'enter' | 'exit', zone } when the call is a zone the
  // object watches (answer `watch`), not someone using it.
  // rooms: () => Promise<[{ id, name, booking }]>, the bookable rooms and
  // what's on in them, read only for plugins with the unlock permission.
  // object.permissions: what an upload was granted.
  async interact({ object, actor, action = 'use', input = null, data = null, state = null, nearby = [], now = this.now(), inventory = [], event = null, rooms = null }) {
    const req = {
      object: { id: object.id, kind: object.plugin, name: object.name || object.plugin, zone: object.zone || null },
      actor: { id: actor.id, did: actor.did || null, handle: actor.handle || null, name: actor.name, kind: actor.kind, role: actor.role || null },
      action, input, data: cleanData(data, MAX_REQUEST_DATA), state, nearby: nearby.slice(0, 20), now, event,
      inventory: inventory.slice(0, 40).map(({ id, kind, name, emoji, qty, data }) => ({ id, kind, name, emoji, qty, ...(data !== undefined ? { data } : {}) })),
      // WASM has no randomness of its own.
      seed: Math.floor(Math.random() * 2 ** 53),
    };
    let raw, problem = null, permissions = [];
    try {
      const code = await this.code(object), upload = code.upload;
      permissions = code.permissions;
      req.permissions = permissions;
      if (permissions.includes('unlock') && rooms) req.rooms = await Promise.resolve(rooms()).catch(() => []);
      raw = await this.call(upload, req);
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
    // What it answered with but may not do.
    if (!permissions.includes('take') && result.take.length) {
      log('warning', `plugin:${object.id}`, 'answered with take without the take permission: dropped');
      result.take = [];
    }
    if ((result.append.length || result.clearFeed) && !permissions.includes('feed')) {
      log('warning', `plugin:${object.id}`, 'answered with a feed change without the feed permission: dropped');
      result.append = [];
      result.clearFeed = false;
    }
    if (!permissions.includes('notify') && result.notify.length) {
      log('warning', `plugin:${object.id}`, 'answered with notify without the notify permission: dropped');
      result.notify = [];
    }
    // A skeleton key opens booked rooms: one comes only from an admin's upload,
    // never a give. Nor does anything that says it's an upload: carrying one is
    // what owns it (picking it up, putting it down, throwing it away).
    const forged = (i) => i.kind === SKELETON_KEY || i.kind === 'upload' || i.data?.upload !== undefined;
    if (result.give.some(forged)) {
      log('warning', `plugin:${object.id}`, 'gave a skeleton key or an upload: dropped');
      result.give = result.give.filter((i) => !forged(i));
    }
    if (result.unlock && !permissions.includes('unlock')) {
      log('warning', `plugin:${object.id}`, 'answered with unlock without the unlock permission: refused');
      result.unlock = null;
      result.toast = `${req.object.name} can't open doors: it doesn't have the unlock permission.`;
    }
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

function cleanData(d, max = MAX_DATA) {
  if (d === undefined || d === null) return null;
  try {
    const json = JSON.stringify(d);
    return json && json.length <= max ? JSON.parse(json) : null;
  } catch { return null; }
}

// A plugin's answer, reduced to what the office knows how to show.
export function sanitize(r) {
  r = r && typeof r === 'object' ? r : {};
  const act = (a) => (typeof a === 'string' && ACTION.test(a) ? a : null);
  const out = { say: r.say ? clip(r.say, 280) : null, toast: r.toast ? clip(r.toast, 200) : null, display: null, ui: null, wakeAt: null, give: [], take: [], unlock: null, append: [], clearFeed: !!r.clearFeed, notify: [], reply: null };
  // Entries for the object's feed (needs the feed permission): plain JSON, each ≤ 8 KB.
  if (Array.isArray(r.append)) out.append = r.append.slice(0, MAX_APPEND).map((e) => cleanData(e, MAX_FEED_ENTRY)).filter((e) => e !== null);
  // Items for the person who used it (give), and things of theirs it uses up
  // (take, by kind): the office applies both together, all or nothing.
  if (Array.isArray(r.give)) out.give = r.give.slice(0, 5).map((i) => cleanItem(i)).filter(Boolean).map(({ at, from, ...i }) => i);
  if (Array.isArray(r.take)) {
    out.take = r.take.slice(0, 5).filter((t) => typeof t?.kind === 'string' && /^[a-z0-9][a-z0-9:._-]{0,31}$/.test(t.kind))
      .map((t) => ({ kind: t.kind, qty: Math.max(1, Math.min(20, Math.floor(+t.qty) || 1)) }));
  }
  // Notes for particular people anywhere in the office (needs the notify
  // permission): `to` names them (keys, DIDs, handles, agent names), `inside`
  // / `outside` a zone narrows it; no `to` means everyone in `inside`.
  const zone = (z) => (typeof z === 'string' && ZONES.some((x) => x.id === z) ? z : null);
  if (Array.isArray(r.notify)) {
    out.notify = r.notify.slice(0, MAX_NOTES).filter((n) => n && typeof n.text === 'string' && n.text.trim()).map((n) => ({
      text: clip(n.text, 280),
      to: (Array.isArray(n.to) ? n.to : []).filter((x) => typeof x === 'string').map((x) => clip(x, 253)).filter(Boolean).slice(0, MAX_NOTE_TO),
      inside: zone(n.inside), outside: zone(n.outside), keep: !!n.keep,
      kind: KIND.test(n.kind || '') ? n.kind : null, re: typeof n.re === 'string' ? clip(n.re, 32) : null,
    })).filter((n) => n.to.length || n.inside);
  }
  // Data for whoever called (the World, agents), never shown to anyone else.
  out.reply = cleanData(r.reply);
  // Let the person who used it into a booked room (needs the unlock permission).
  const room = typeof r.unlock === 'string' ? r.unlock : r.unlock?.room;
  out.unlock = typeof room === 'string' && roomById(room) ? { room } : null;
  if (r.display && typeof r.display === 'object') {
    out.display = {
      label: r.display.label ? clip(r.display.label, 40) : null,
      glow: COLOR.test(r.display.glow || '') ? r.display.glow : null,
      until: Number.isFinite(r.display.until) ? r.display.until : null,
      // Music the office plays near the object: tune `id` (public/js/music.js), started at `at` (epoch ms).
      music: r.display.music && /^[\w-]{1,32}$/.test(r.display.music.id || '') && Number.isFinite(r.display.music.at) ? { id: r.display.music.id, at: r.display.music.at } : null,
      // Plain JSON every browser gets, for objects the office draws itself
      // (the notice board's notes, the pomodoro's phase).
      data: cleanData(r.display.data),
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
      // A browser game above the panel (public/js/objects.js GAMES); a round's
      // score comes back as `<action>:<score>`.
      game: u.game && GAMES.includes(u.game.kind) && act(`${u.game.action}:1`) ? { kind: u.game.kind, action: u.game.action } : null,
    };
  }
  return out;
}
