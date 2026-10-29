// Objects people upload: a WASM (or, on Cloudflare, JS) plugin a signed-in
// person uploads through the web UI or MCP and places on the map where they
// stand. Two kinds of entity:
//
//   gallery:main   the list of uploaded objects (where each stands, who owns
//                  it, its manifest). The World mirrors it to every client.
//   uobj:<id>      one per object: its code (own storage key, so state saves
//                  don't rewrite it) and its memory. A PluginObject whose
//                  plugin runs in the sandbox (server/sandbox.js), with the
//                  same contract as the plugin Workers.
//
// The uploader (or an admin, ADMIN_DIDS) can remove an object again.

import { Entity } from './runtime.js';
import { str, num, obj, opt, arr, WHO } from './schema.js';
import { FURNITURE, isBlocked, zoneAt } from '../../public/js/map.js';
import { PluginObject } from './plugin.js';
import { checkUpload, fromBase64, MAX_WASM, LANGS } from '../sandbox.js';

export const MAX_PER_OWNER = 3;
export const MAX_OBJECTS = 40;
export const LOOKS = ['plinth', 'kiosk', 'jukebox', 'vending', 'eightball'];
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
  x: num('Tile x', 0), y: num('Tile y', 0), zone: { type: ['string', 'null'], description: 'Zone it stands in' },
  owner: obj({ did: str('Uploader DID'), handle: { type: ['string', 'null'] }, name: str('Uploader name') }, 'Who uploaded it'),
  createdAt: num('When, epoch ms', 0),
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
      doc: `Upload a plugin and place it on the map next to you. Needs AT Protocol sign-in. \`code\` is the file in base64: a WebAssembly module (≤ ${MAX_WASM / 1024} KB) exporting memory, alloc and interact (the ABI in docs/uploads.md), or on Cloudflare a JS module exporting interact(). At most ${MAX_PER_OWNER} per person.`,
      who: true,
      mutates: true,
      params: {
        req: obj({
          name: str('What it\'s called', 40),
          lang: { type: 'string', enum: LANGS, description: 'wasm or js' },
          code: str('The file, base64', B64_MAX),
          prompt: opt(str('What the E prompt says, e.g. "Sign the guestbook"', 60)),
          doc: opt(str('What it does, for the docs and the MCP tool list', 280)),
          emoji: opt(str('An emoji to show on it', 8)),
          glow: opt(str('Accent colour #rrggbb', 9, { pattern: '^#[0-9a-fA-F]{3,8}$' })),
          look: opt({ type: 'string', enum: LOOKS, description: 'How it\'s drawn (default plinth)' }),
        }, 'The upload'),
      },
      returns: { type: 'object', description: '{ ok, object } with the placed object, or { error }' },
    },
    remove: {
      doc: 'Take an uploaded object off the map and delete its code and memory. Only its uploader (or an office admin) can.',
      who: true,
      mutates: true,
      params: { req: obj({ id: str('Object id (u-…)', 20) }, 'Which object') },
      returns: { type: 'object', description: '{ ok } or { error }' },
    },
  };

  get items() { return this.state.items || []; }
  view() { return this.items; }

  async upload(who, req = {}) {
    if (!who?.did) return { error: 'sign in with your AT Protocol handle to upload objects' };
    const sandbox = this.services.plugins?.sandbox;
    const lang = req.lang === 'js' ? 'js' : 'wasm';
    if (!sandbox) return { error: 'this office can\'t run uploaded plugins yet: it needs the Worker Loader binding (docs/uploads.md)' };
    if (!sandbox.langs.includes(lang)) return { error: `this office runs ${sandbox.langs.join(' and ')} uploads, not ${lang}` };
    const name = clip(req.name, 40);
    if (!name) return { error: 'give it a name' };
    if (this.items.filter((i) => i.owner.did === who.did).length >= MAX_PER_OWNER) return { error: `you have ${MAX_PER_OWNER} objects out already: remove one first` };
    if (this.items.length >= MAX_OBJECTS) return { error: 'the office is full of uploaded objects right now' };
    let bytes, info;
    try {
      if (String(req.code || '').length > B64_MAX) throw new Error(`the file is over ${MAX_WASM / 1024} KB`);
      bytes = fromBase64(req.code);
      info = checkUpload(lang, bytes);
    } catch (e) { return { error: `can't use that file: ${e.message}` }; }
    const spot = Number.isFinite(who.x) && Number.isFinite(who.y) ? placeNear(who.x, who.y, this.items) : null;
    if (!spot) return { error: 'no room to put it here: step into open floor and try again' };

    const id = `u-${shortId()}`;
    const item = {
      id, name, lang, size: info.size, version: await digest(bytes),
      prompt: clip(req.prompt, 60) || `Use ${name}`,
      doc: clip(req.doc, 280),
      emoji: [...clip(req.emoji, 8)].slice(0, 2).join('') || '🧩',
      glow: /^#[0-9a-f]{3,8}$/i.test(req.glow || '') ? req.glow : '#a78bfa',
      look: LOOKS.includes(req.look) ? req.look : 'plinth',
      x: spot.x, y: spot.y, zone: zoneAt(spot.x + 0.5, spot.y + 0.5)?.id || null,
      owner: { did: who.did, handle: who.handle || null, name: who.name },
      createdAt: this.now(),
    };
    await this.ref(`uobj:${id}`).install(item, req.code.replace(/\s+/g, ''));
    this.state.items = [...this.items, item];
    await this.save();
    await this.mirror(this.items);
    return { ok: true, object: item };
  }

  async remove(who, { id } = {}) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { error: `no uploaded object ${id}` };
    const admin = (this.services.admins || []).includes(who?.did);
    if (!who?.did || (item.owner.did !== who.did && !admin)) return { error: `only ${item.owner.handle ? `@${item.owner.handle}` : item.owner.name} can remove ${item.name}` };
    await this.ref(`uobj:${id}`).uninstall();
    this.state.items = this.items.filter((i) => i.id !== id);
    await this.save();
    await this.mirror(this.items);
    return { ok: true };
  }
}

export class UploadedObject extends PluginObject {
  static rpc = [];
  static doc = 'An object someone uploaded (gallery:main lists them). Its plugin runs in the sandbox: a Dynamic Worker on Cloudflare, a worker thread on Node. Same contract and panel as the built-in plugin objects.';
  static api = {
    view: PluginObject.api.view,
    interact: { ...PluginObject.api.interact, doc: `${PluginObject.api.interact.doc} The name is the object id (u-…) from gallery_view.` },
    install: { doc: 'Store the code and manifest of a new upload (from gallery:main).', params: { item: ITEM, code: str('Base64 code', B64_MAX) }, mutates: true, internal: true },
    uninstall: { doc: 'Forget the code and memory (from gallery:main).', mutates: true, internal: true },
  };

  get object() {
    const m = this.state.meta;
    return m && { ...m, w: 1, h: 1, plugin: 'upload' };
  }

  async pluginObject(f, zone) {
    this.code ??= await this.host.storage.get('code');
    return { id: f.id, plugin: 'upload', name: f.name, zone, upload: { id: f.id, version: f.version, lang: f.lang, code: this.code } };
  }

  async install(item, code) {
    this.code = code;
    await this.host.storage.put('code', code);
    this.state = { setupDone: true, meta: item, data: null, display: null, via: null };
    await this.save();
    return true;
  }

  async uninstall() {
    this.code = null;
    await this.host.storage.delete('code');
    this.state = { setupDone: true, removed: this.now() };
    await this.save();
    await this.mirror(null);
    return true;
  }
}
