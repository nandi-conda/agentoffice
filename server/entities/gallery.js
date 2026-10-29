// Objects people upload: a WASM (or, on Cloudflare, JS) plugin a signed-in
// person uploads through the web UI or MCP and places on the map where they
// stand. Two kinds of entity:
//
//   gallery:main   the list of uploaded objects (where each stands, who owns
//                  it, its manifest). The World mirrors it to every client.
//   uobj:<id>      one per object: its code (own storage key, so state saves
//                  don't rewrite it) and its memory. A PluginObject whose
//                  plugin runs in the sandbox (server/sandbox.js), with the
//                  same contract as the office's own WASM objects.
//
// The uploader (or a moderator, see public/js/roles.js) can remove an object again.
// A carried upload (look `item`, e.g. the Skeleton Key) is different: it's an
// item, and possession is ownership. It has no owner here, doesn't count
// against its uploader, and goes when whoever holds it throws it away (or
// the floor's cleaners sweep it up), not when its uploader says so.

import { Entity } from './runtime.js';
import { str, num, obj, opt, arr, WHO } from './schema.js';
import { FURNITURE, isBlocked, zoneAt } from '../../public/js/map.js';
import { PluginObject } from './plugin.js';
import { checkUpload, fromBase64, MAX_WASM, LANGS } from '../sandbox.js';
import { can } from '../../public/js/roles.js';
import { PERMISSIONS, LEVELS, levelOf, uploadError } from '../../public/js/permissions.js';
import { SKELETON_KEY } from '../../public/js/items.js';

export const MAX_PER_OWNER = 3;
export const MAX_OBJECTS = 40;
export const LOOKS = ['plinth', 'kiosk', 'jukebox', 'vending', 'eightball', 'item'];
// The look that isn't on the map: the upload is one item in its uploader's inventory.
export const CARRIED = 'item';
const B64_MAX = Math.ceil(MAX_WASM / 3) * 4;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

async function digest(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ITEM = obj({
  id: str('Object id on the map (u-…); its entity is uobj:<id>'),
  name: str('Name', 40), prompt: str('What the E prompt says', 60), doc: str('What it does', 280),
  emoji: str('Shown on its plinth', 8), glow: str('Accent colour #rrggbb', 9), look: str(`How it's drawn: ${LOOKS.join(', ')}`),
  lang: str('wasm or js'), size: num('Code size in bytes', 0), version: str('First bytes of the code\'s SHA-256'),
  x: { type: ['number', 'null'], description: 'Tile x (null: carried)' }, y: { type: ['number', 'null'], description: 'Tile y (null: carried)' }, zone: { type: ['string', 'null'], description: 'Zone it stands in' },
  carried: opt({ type: 'boolean', description: 'Look `item`: not on the map, one item in its uploader\'s inventory instead (with unlock, a skeleton key)' }),
  owner: { type: ['object', 'null'], description: 'Who uploaded it: { did, handle, name }. Null for a carried one: it belongs to whoever holds it' },
  createdAt: num('When, epoch ms', 0),
  permissions: arr({ type: 'string', enum: Object.keys(PERMISSIONS) }, 'What its manifest asked for beyond the basics and was granted: ' + Object.entries(PERMISSIONS).map(([p, v]) => `${p} (${v.level})`).join(', ')),
  level: { type: 'string', enum: Object.keys(LEVELS), description: 'basic, trusted (moderators upload it) or privileged (admins upload it)' },
  api: { type: 'object', description: 'The actions its manifest declares, { action: { doc, params? } }: pass one as `action` to uobj_interact (with `input` when it has params.input). Empty when the module has no manifest.' },
}, 'An uploaded object');

// The tile next to (x, y) where a new object can stand: free floor, not on
// furniture or another upload.
export function placeNear(x, y, items) {
  const fx = Math.floor(x), fy = Math.floor(y);
  const taken = (tx, ty) => isBlocked(tx, ty)
    || FURNITURE.some((f) => f.type !== 'rug' && tx + 1 > f.x && tx < f.x + f.w && ty + 1 > f.y && ty < f.y + f.h)
    || items.some((i) => i.x === tx && i.y === ty);
  for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1], [0, -2], [2, 0], [-2, 0], [0, 2]]) {
    if (!taken(fx + dx, fy + dy)) return { x: fx + dx, y: fy + dy };
  }
  return null;
}

export class Gallery extends Entity {
  static doc = 'Objects people uploaded: WASM (or JS) plugins that signed-in people placed on the map. Keeps where each stands, its manifest and who owns it; the code lives in each uobj:<id>. Uploaded objects follow the plugin contract (docs/plugins.md) and run sandboxed (docs/uploads.md).';
  static api = {
    view: { doc: 'Every uploaded object on the map.', returns: arr(ITEM, 'Uploaded objects') },
    upload: {
      doc: `Upload a plugin and place it on the map next to you (or, when its look is \`item\`, get it as one item in your inventory: with the unlock permission, a skeleton key that opens booked rooms as its carrier walks up). Needs AT Protocol sign-in. \`code\` is the file in base64: a WebAssembly module (≤ ${MAX_WASM / 1024} KB) exporting memory, alloc and interact (the ABI in docs/uploads.md), or on Cloudflare a JS module exporting interact(). A module built with the agentoffice-plugin crate carries a manifest: its name, prompt, doc, emoji, glow and look fill in whatever you leave out, and the permissions it lists decide who may upload it (trusted ones like take: moderators; privileged ones like unlock: admins). At most ${MAX_PER_OWNER} per person.`,
      who: true,
      mutates: true,
      params: {
        req: obj({
          name: opt(str('What it\'s called (default: the manifest\'s name)', 40)),
          lang: { type: 'string', enum: LANGS, description: 'wasm or js' },
          code: str('The file, base64', B64_MAX),
          prompt: opt(str('What the E prompt says, e.g. "Sign the guestbook"', 60)),
          doc: opt(str('What it does, for the docs and the MCP tool list', 280)),
          emoji: opt(str('An emoji to show on it', 8)),
          glow: opt(str('Accent colour #rrggbb', 9, { pattern: '^#[0-9a-fA-F]{3,8}$' })),
          look: opt({ type: 'string', enum: LOOKS, description: 'How it\'s drawn (default plinth); item: not on the map, in your inventory' }),
        }, 'The upload'),
      },
      returns: { type: 'object', description: '{ ok, object } with the placed object (carried: the item is in your inventory), or { error }' },
    },
    remove: {
      doc: 'Take an uploaded object off the map and delete its code and memory. Only its uploader (or a moderator) can. A carried one (look item) belongs to whoever holds it: they throw it away with inventory_destroy; only a moderator can remove it here.',
      who: true, cap: 'uploads.remove',
      mutates: true,
      params: { req: obj({ id: str('Object id (u-…)', 20) }, 'Which object') },
      returns: { type: 'object', description: '{ ok } or { error }' },
    },
    discard: { doc: 'A carried upload\'s item is gone (thrown away, swept off the floor): delete its code and memory.', params: { id: str('Object id (u-…)', 20) }, returns: { type: 'boolean', description: 'Whether there was one' }, mutates: true, internal: true },
  };

  // (Carried ones saved before they stopped having owners lose theirs here.)
  get items() { return (this.state.items || []).map((i) => (i.carried && i.owner ? { ...i, owner: null } : i)); }
  view() { return this.items; }

  async upload(who, req = {}) {
    if (!who?.did) return { error: 'sign in with your AT Protocol handle to upload objects' };
    const sandbox = this.services.plugins?.sandbox;
    const lang = req.lang === 'js' ? 'js' : 'wasm';
    if (!sandbox) return { error: 'this office can\'t run uploaded plugins: it was deployed without the Worker Loader binding (LOADER in wrangler.toml), which needs the Workers Paid plan (docs/uploads.md)' };
    if (!sandbox.langs.includes(lang)) return { error: `this office runs ${sandbox.langs.join(' and ')} uploads, not ${lang}` };
    if (this.items.filter((i) => i.owner?.did === who.did).length >= MAX_PER_OWNER) return { error: `you have ${MAX_PER_OWNER} objects out already: remove one first` };
    if (this.items.length >= MAX_OBJECTS) return { error: 'the office is full of uploaded objects right now' };
    let bytes, info;
    try {
      if (String(req.code || '').length > B64_MAX) throw new Error(`the file is over ${MAX_WASM / 1024} KB`);
      bytes = fromBase64(req.code);
      info = checkUpload(lang, bytes);
    } catch (e) { return { error: `can't use that file: ${e.message}` }; }
    // What the module says about itself fills in whatever the uploader left out.
    const m = info.manifest || {};
    const name = clip(req.name, 40) || clip(m.name, 40);
    if (!name) return { error: 'give it a name' };
    // What it asks for beyond the basics decides who may put it out.
    const permissions = m.permissions || [];
    const refused = uploadError(who.role, permissions, name);
    if (refused) return { error: refused };
    const color = (c) => /^#[0-9a-f]{3,8}$/i.test(c || '');
    const look = LOOKS.includes(req.look) ? req.look : LOOKS.includes(m.look) ? m.look : 'plinth';
    const carried = look === CARRIED;
    const spot = carried ? { x: null, y: null } : Number.isFinite(who.x) && Number.isFinite(who.y) ? placeNear(who.x, who.y, this.items) : null;
    if (!spot) return { error: 'no room to put it here: step into open floor and try again' };

    const id = `u-${shortId()}`;
    const item = {
      id, name, lang, size: info.size, version: await digest(bytes),
      prompt: clip(req.prompt, 60) || m.prompt || `Use ${name}`,
      doc: clip(req.doc, 280) || m.doc || '',
      emoji: [...clip(req.emoji, 8)].slice(0, 2).join('') || m.emoji || '🧩',
      glow: color(req.glow) ? req.glow : color(m.glow) ? m.glow : '#a78bfa',
      look, permissions, level: levelOf(permissions),
      api: m.api || {},
      x: spot.x, y: spot.y, zone: carried ? null : zoneAt(spot.x + 0.5, spot.y + 0.5)?.id || null,
      ...(carried ? { carried: true } : {}),
      owner: carried ? null : { did: who.did, handle: who.handle || null, name: who.name },
      createdAt: this.now(),
    };
    await this.ref(`uobj:${id}`).install(item, req.code.replace(/\s+/g, ''));
    // Carried: the one item it is goes to the uploader. It names its upload,
    // which is what it does when used (a key: the office asks it to open doors).
    if (carried) {
      const thing = { kind: permissions.includes('unlock') ? SKELETON_KEY : 'upload', name, emoji: item.emoji, data: { upload: id } };
      const r = await this.world.invApply(who.id, { give: [thing] }).catch((e) => ({ error: e.message }));
      if (r?.error) { await this.ref(`uobj:${id}`).uninstall(); return { error: `couldn't put ${name} in your inventory: ${r.error}` }; }
    }
    this.state.items = [...this.items, item];
    await this.save();
    await this.mirror(this.items);
    return { ok: true, object: item };
  }

  async remove(who, { id } = {}) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { error: `no uploaded object ${id}` };
    const mod = can(who?.role, 'uploads.remove');
    if (!item.owner && !mod) return { error: `${item.name} belongs to whoever holds it: they can throw it away from their inventory` };
    if (item.owner && (!who?.did || item.owner.did !== who.did) && !mod) return { error: `only ${item.owner.handle ? `@${item.owner.handle}` : item.owner.name} can remove ${item.name}` };
    await this.discard(id);
    return { ok: true };
  }

  async discard(id) {
    if (!this.items.some((i) => i.id === id)) return false;
    await this.ref(`uobj:${id}`).uninstall();
    this.state.items = this.items.filter((i) => i.id !== id);
    await this.save();
    await this.mirror(this.items);
    return true;
  }
}

export class UploadedObject extends PluginObject {
  static rpc = [];
  static doc = 'An object someone uploaded (gallery:main lists them). Its plugin runs in the sandbox: a Dynamic Worker on Cloudflare, a worker thread on Node. Same contract and panel as the built-in plugin objects.';
  static api = {
    view: PluginObject.api.view,
    interact: { ...PluginObject.api.interact, doc: `${PluginObject.api.interact.doc} The name is the object id (u-…) from gallery_view, whose \`api\` lists the actions the object declares.` },
    // The office's own calls: a carried skeleton key's `open:<room>` as its carrier reaches a door.
    act: { ...PluginObject.api.act, doc: 'The office\'s own call into the object, without the use cooldown or the walk up: a carried Skeleton Key gets `open:<room>` this way as its carrier reaches a booked door.' },
    install: { doc: 'Store the code and manifest of a new upload (from gallery:main).', params: { item: ITEM, code: str('Base64 code', B64_MAX) }, mutates: true, internal: true },
    uninstall: { doc: 'Forget the code and memory (from gallery:main).', mutates: true, internal: true },
  };

  get object() {
    const m = this.state.meta;
    return m && { ...m, w: 1, h: 1, plugin: 'upload' };
  }

  async pluginObject(f, zone) {
    this.code ??= await this.host.storage.get('code');
    return { id: f.id, plugin: 'upload', name: f.name, zone, permissions: f.permissions || [], upload: { id: f.id, version: f.version, lang: f.lang, code: this.code } };
  }

  async install(item, code) {
    this.code = code;
    await this.host.storage.put('code', code);
    await this.feedClear();
    this.state = { setupDone: true, meta: item, data: null, display: null, via: null };
    await this.save();
    return true;
  }

  async uninstall() {
    this.code = null;
    await this.host.storage.delete('code');
    await this.feedClear();
    this.state = { setupDone: true, removed: this.now() };
    await this.save();
    await this.mirror(null);
    return true;
  }
}
