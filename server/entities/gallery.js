// Objects people upload: a WASM (or, on Cloudflare, JS) plugin a signed-in
// person uploads through the web UI or MCP. It's a real object, drawn the way
// its manifest says (an arcade cabinet, a jukebox, its own pixel sprite…),
// and it's always in one of two places: standing in a room, or carried as
// one item in someone's inventory. It moves between them like anything
// else people carry: pick it up, put it down. Two kinds of entity:
//
//   gallery:main   the list of uploaded objects (where each stands, who owns
//                  it, its manifest). The World mirrors it to every client.
//   uobj:<id>      one per object: its code (own storage key, so state saves
//                  don't rewrite it) and its memory. A PluginObject whose
//                  plugin runs in the sandbox (server/sandbox.js), with the
//                  same contract as the office's own WASM objects.
//
// Possession is ownership. Standing in a room, it belongs to whoever put it
// there (the uploader, at first): they (or a moderator, see
// public/js/roles.js) can pick it up or remove it. Carried, it has no owner
// here and doesn't count against anyone: it goes when whoever holds it
// throws it away (or the floor's cleaners sweep it up). Look `item` (the
// Skeleton Key) starts out carried and, put down, lies on the floor like any
// item; every other look starts in the room next to its uploader and, put
// down, stands there as itself.

import { Entity } from './runtime.js';
import { str, num, obj, opt, arr, WHO } from './schema.js';
import { zoneAt } from '../../public/js/map.js';
import { PluginObject } from './plugin.js';
import { checkUpload, fromBase64, MAX_WASM, LANGS } from '../sandbox.js';
import { can } from '../../public/js/roles.js';
import { PERMISSIONS, LEVELS, levelOf, uploadError } from '../../public/js/permissions.js';
import { SKELETON_KEY } from '../../public/js/items.js';
import { LOOKS as LOOK_NAMES, CARRIED, lookOf } from '../../public/js/manifest.js';

export const MAX_PER_OWNER = 3;
export const MAX_OBJECTS = 40;
export const LOOKS = Object.keys(LOOK_NAMES);
export { CARRIED };
// The item an upload is while someone carries it (a key when it may unlock rooms).
export const asItem = (u) => ({ kind: u.permissions?.includes('unlock') ? SKELETON_KEY : 'upload', name: u.name, emoji: u.emoji, data: { upload: u.id } });
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
  emoji: str('Its emoji (on its screen, and as an item)', 8), glow: str('Accent colour #rrggbb', 9), look: str(`How it's drawn: ${LOOKS.join(', ')}`),
  sprite: opt({ type: 'object', description: 'Look sprite: its own pixel art from the manifest, { rows: ["..bb..", …], palette: { b: "#rrggbb" } }, ≤ 16 × 24' }),
  lang: str('wasm or js'), size: num('Code size in bytes', 0), version: str('First bytes of the code\'s SHA-256'),
  x: { type: ['number', 'null'], description: 'Tile x (null: carried)' }, y: { type: ['number', 'null'], description: 'Tile y (null: carried)' }, zone: { type: ['string', 'null'], description: 'Zone it stands in' },
  carried: opt({ type: 'boolean', description: 'Not in a room: one item in someone\'s inventory (with unlock, a skeleton key). Put it down to stand it in a room again' }),
  owner: { type: ['object', 'null'], description: 'Who put it in the room (at first its uploader): { did, handle, name }. Null while carried: it belongs to whoever holds it' },
  createdAt: num('When, epoch ms', 0),
  permissions: arr({ type: 'string', enum: Object.keys(PERMISSIONS) }, 'What its manifest asked for beyond the basics and was granted: ' + Object.entries(PERMISSIONS).map(([p, v]) => `${p} (${v.level})`).join(', ')),
  level: { type: 'string', enum: Object.keys(LEVELS), description: 'basic, trusted (moderators upload it) or privileged (admins upload it)' },
  api: { type: 'object', description: 'The actions its manifest declares, { action: { doc, params? } }: pass one as `action` to uobj_interact (with `input` when it has params.input). Empty when the module has no manifest.' },
}, 'An uploaded object');

// Does an upload stand somewhere? (Carried ones, and look `item`, never do.)
export const placed = (i) => !i.carried && Number.isFinite(i.x);

export class Gallery extends Entity {
  static doc = 'Objects people uploaded: WASM (or JS) plugins, each a drawn object that stands in a room or is carried in someone\'s inventory. Keeps where each is, its manifest and who owns it; the code lives in each uobj:<id>. Uploaded objects follow the plugin contract (docs/plugins.md) and run sandboxed (docs/uploads.md).';
  static api = {
    view: { doc: 'Every uploaded object: the ones standing in rooms, and the carried ones.', returns: arr(ITEM, 'Uploaded objects') },
    upload: {
      doc: `Upload a plugin. It becomes one item in your inventory, then stands up as itself on the tile you name with x and y (the same rules as inventory_place: within 3 tiles, reachable on foot, free), or without them on the nearest free tile. A look of \`item\` stays in your inventory (with the unlock permission, a skeleton key that opens booked rooms as its carrier walks up). Needs AT Protocol sign-in. \`code\` is the file in base64: a WebAssembly module (≤ ${MAX_WASM / 1024} KB) exporting memory, alloc and interact (the ABI in docs/uploads.md), or on Cloudflare a JS module exporting interact(). A module built with the agentoffice-plugin crate carries a manifest: its name, prompt, doc, emoji, glow and look fill in whatever you leave out, and the permissions it lists decide who may upload it (trusted ones like take: moderators; privileged ones like unlock: admins). At most ${MAX_PER_OWNER} per person.`,
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
          x: opt(num('Tile x to stand it on (any point in the tile)', 0)), y: opt(num('Tile y', 0)),
          look: opt({ type: 'string', enum: LOOKS, description: `How it's drawn (default: the manifest's look, else ${lookOf()}): ${Object.entries(LOOK_NAMES).map(([k, v]) => `${k} (${v.toLowerCase()})`).join(', ')}. sprite needs a manifest with one; item starts in your inventory` }),
        }, 'The upload'),
      },
      returns: { type: 'object', description: '{ ok, object, item } with the object (standing where it went, or carried) and its stack id in your inventory while carried, or { error }; `placed: false` with `why` when it couldn\'t stand it up and it waits in your inventory' },
    },
    carry: { doc: 'An object standing in a room was picked up: it\'s carried now, and nobody\'s here.', params: { id: str('Object id (u-…)', 20) }, returns: { type: ['object', 'null'], description: 'The object, or null if it wasn\'t standing anywhere' }, mutates: true, internal: true },
    put: { doc: 'A carried object was put down on a tile: it stands there, and is whoever put it there\'s.', params: { id: str('Object id (u-…)', 20), x: num('Tile x', 0), y: num('Tile y', 0), owner: { type: ['object', 'null'], description: '{ did, handle, name }' } }, returns: { type: 'object', description: '{ ok, object } or { error }' }, mutates: true, internal: true },
    remove: {
      doc: 'Take an uploaded object off the map and delete its code and memory. Only its uploader (or a moderator) can. A carried one (look item) belongs to whoever holds it: they throw it away with inventory_destroy; only a moderator can remove it here.',
      who: true, cap: 'uploads.remove',
      mutates: true,
      params: { req: obj({ id: str('Object id (u-…)', 20) }, 'Which object') },
      returns: { type: 'object', description: '{ ok } or { error }' },
    },
    discard: { doc: 'A carried upload\'s item is gone (thrown away, swept off the floor): delete its code and memory.', params: { id: str('Object id (u-…)', 20) }, returns: { type: 'boolean', description: 'Whether there was one' }, mutates: true, internal: true },
  };

  // (Carried ones saved before they stopped having owners lose theirs here,
  // and plinths, which are gone, stand as kiosks.)
  get items() {
    return (this.state.items || []).map((i) => {
      const look = i.look === CARRIED ? CARRIED : lookOf(i.look === 'sprite' && !i.sprite ? null : i.look);
      return { ...i, look, ...(i.carried && i.owner ? { owner: null } : {}) };
    });
  }
  view() { return this.items; }

  // The per-person cap counts exactly what the list shows standing as
  // theirs, and names it, so nobody is told they're full of objects they
  // can't see. Null while there's room.
  full(did) {
    const mine = this.items.filter((i) => placed(i) && i.owner?.did === did);
    if (mine.length < MAX_PER_OWNER) return null;
    return `you have ${MAX_PER_OWNER} objects out already (${mine.map((i) => `${i.name} ${i.id}`).join(', ')})`;
  }

  async upload(who, req = {}) {
    if (!who?.did) return { error: 'sign in with your AT Protocol handle to upload objects' };
    const sandbox = this.services.plugins?.sandbox;
    const lang = req.lang === 'js' ? 'js' : 'wasm';
    if (!sandbox) return { error: 'this office can\'t run uploaded plugins: it was deployed without the Worker Loader binding (LOADER in wrangler.toml), which needs the Workers Paid plan (docs/uploads.md)' };
    if (!sandbox.langs.includes(lang)) return { error: `this office runs ${sandbox.langs.join(' and ')} uploads, not ${lang}` };
    const full = this.full(who.did);
    if (full) return { error: `${full}: pick one up or remove one first` };
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
    const want = LOOKS.includes(req.look) ? req.look : LOOKS.includes(m.look) ? m.look : null;
    const look = want === 'sprite' && !m.sprite ? lookOf(m.look === 'sprite' ? null : m.look) : lookOf(want);

    const id = `u-${shortId()}`;
    const item = {
      id, name, lang, size: info.size, version: await digest(bytes),
      prompt: clip(req.prompt, 60) || m.prompt || `Use ${name}`,
      doc: clip(req.doc, 280) || m.doc || '',
      emoji: [...clip(req.emoji, 8)].slice(0, 2).join('') || m.emoji || '🧩',
      glow: color(req.glow) ? req.glow : color(m.glow) ? m.glow : '#a78bfa',
      look, ...(look === 'sprite' ? { sprite: m.sprite } : {}), permissions, level: levelOf(permissions),
      api: m.api || {},
      x: null, y: null, zone: null, carried: true, owner: null,
      createdAt: this.now(),
    };
    await this.ref(`uobj:${id}`).install(item, req.code.replace(/\s+/g, ''));
    // It starts as the one item it is, in the uploader's inventory: put down
    // (the World does that next, or the uploader picks a spot), it stands up
    // as itself. The item names its upload, which is what it does when used
    // (a key: the office asks it to open doors).
    const r = await this.world.invApply(who.id, { give: [asItem(item)] }).catch((e) => ({ error: e.message }));
    if (r?.error) { await this.ref(`uobj:${id}`).uninstall(); return { error: `couldn't put ${name} in your inventory: ${r.error}` }; }
    this.state.items = [...this.items, item];
    await this.save();
    await this.mirror(this.items);
    return { ok: true, object: item, item: r.items?.find((s) => s.data?.upload === id)?.id || null };
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

  // Picked up (the World checked who and how near): carried now.
  async carry(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item || !placed(item)) return null;
    const carried = { ...item, x: null, y: null, zone: null, carried: true, owner: null };
    this.state.items = this.items.map((i) => (i.id === id ? carried : i));
    await this.save();
    await this.ref(`uobj:${id}`).moved(carried);
    await this.mirror(this.items);
    return carried;
  }

  // Put down on a free tile (the World checked reach): it stands there now.
  async put(id, x, y, owner) {
    const item = this.items.find((i) => i.id === id);
    if (!item || placed(item)) return { error: 'that isn\'t something you\'re carrying' };
    if (item.look === CARRIED) return { error: `${item.name} isn't something that stands in a room` };
    const tx = Math.floor(x), ty = Math.floor(y);
    if (this.items.some((i) => placed(i) && i.x === tx && i.y === ty)) return { error: 'something already stands there' };
    const full = owner?.did && this.full(owner.did);
    if (full) return { error: `${full}: pick one up first` };
    const out = { ...item, x: tx, y: ty, zone: zoneAt(tx + 0.5, ty + 0.5)?.id || null, owner: owner || null };
    delete out.carried;
    this.state.items = this.items.map((i) => (i.id === id ? out : i));
    await this.save();
    await this.ref(`uobj:${id}`).moved(out);
    await this.mirror(this.items);
    return { ok: true, object: out };
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
    // An uploaded whiteboard's strokes, as fast as the boardroom's.
    perform: PluginObject.api.perform,
    // The office's own calls: a carried skeleton key's `open:<room>` as its carrier reaches a door.
    act: { ...PluginObject.api.act, doc: 'The office\'s own call into the object, without the use cooldown or the walk up: a carried Skeleton Key gets `open:<room>` this way as its carrier reaches a booked door.' },
    install: { doc: 'Store the code and manifest of a new upload (from gallery:main).', params: { item: ITEM, code: str('Base64 code', B64_MAX) }, mutates: true, internal: true },
    uninstall: { doc: 'Forget the code and memory (from gallery:main).', mutates: true, internal: true },
    moved: { doc: 'Where it is now (from gallery:main, when it\'s picked up or put down).', params: { item: ITEM }, mutates: true, internal: true },
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

  async moved(item) {
    if (!this.state.meta) return false;
    this.state.meta = item;
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
