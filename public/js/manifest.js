// The manifest an uploaded WASM plugin can carry: JSON in a custom section
// named `agentoffice.manifest` (the agentoffice-plugin Rust crate's export_plugin!
// writes it). It says what the object is called, how it looks, and which
// actions its panels send, so the upload form fills itself in and agents see
// the actions in gallery_view. Shared by the upload panel (gallery.js) and
// the server's checks (server/sandbox.js); nothing in it is trusted.

import { cleanPermissions } from './permissions.js';

export const MANIFEST_SECTION = 'agentoffice.manifest';
const MAX_BYTES = 8 * 1024;
const MAX_ACTIONS = 24;

// How an object can be drawn: the same art the office's own objects use, or
// the plugin's own pixel sprite. `item` isn't on the map when uploaded: it
// starts in its uploader's inventory. (Old uploads said `plinth`: a kiosk now.)
export const LOOKS = {
  kiosk: 'Screen kiosk with its emoji', arcade: 'Arcade cabinet', jukebox: 'Jukebox', vending: 'Vending machine',
  eightball: 'Crystal ball', coffee: 'Coffee machine', rally: 'Chequered flag', whiteboard: 'Whiteboard', board: 'Notice board',
  pomodoro: 'Focus timer', reception: 'Desk bell', panel: 'Door panel', computer: 'Desk computer', sprite: 'Its own drawing', item: 'An item in my inventory',
};
export const DEFAULT_LOOK = 'kiosk';
export const CARRIED = 'item';
export const lookOf = (look) => (LOOKS[look] ? look : DEFAULT_LOOK);
export const SPRITE_W = 16, SPRITE_H = 24;
// Looks whose object opens one of the browser's own surfaces instead of a
// plain panel (main.js interact), for the office's objects and uploads alike.
export const SURFACES = { whiteboard: 'whiteboard', board: 'noticeboard', coffee: 'coffee', computer: 'computer' };

// A placed upload that looks like a desk computer works like one: standing
// next to it (as close as you'd be to an object you press E on) opens a
// workstation that runs its program. The nearest one within reach, or null.
export const COMPUTER = 'computer';
export const COMPUTER_REACH = 1.6;
export function computerAt(items, x, y) {
  let best = null, bd = COMPUTER_REACH;
  for (const it of items || []) {
    if (it.look !== COMPUTER || it.carried || !Number.isFinite(it.x)) continue;
    const d = Math.hypot(Math.max(it.x, Math.min(x, it.x + 1)) - x, Math.max(it.y, Math.min(y, it.y + 1)) - y);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');

// Only the fields the office uses, clipped. null when it isn't a manifest.
export function cleanManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {
    name: clip(raw.name, 40), prompt: clip(raw.prompt, 60), doc: clip(raw.doc, 280),
    emoji: [...clip(raw.emoji, 8)].slice(0, 2).join(''),
    glow: /^#[0-9a-f]{3,8}$/i.test(raw.glow || '') ? raw.glow : '',
    look: /^[a-z]{1,16}$/.test(raw.look || '') ? raw.look : '',
    sprite: cleanSprite(raw.sprite),
    // What it needs beyond the basics (public/js/permissions.js): decides who may upload it.
    permissions: cleanPermissions(raw.permissions),
    api: {},
  };
  if (out.look === 'sprite' && !out.sprite) out.look = '';
  const api = raw.api && typeof raw.api === 'object' ? Object.entries(raw.api) : [];
  for (const [id, spec] of api.slice(0, MAX_ACTIONS)) {
    if (!/^[\w:.<>-]{1,64}$/.test(id) || !spec || typeof spec !== 'object') continue;
    const a = { doc: clip(spec.doc, 200) };
    const input = spec.params?.input;
    if (input && typeof input === 'object') a.params = { input: { type: 'string', maxLength: 500, description: clip(input.description, 200) } };
    out.api[id] = a;
  }
  return out;
}

// A plugin's own pixel art: { rows: ['..bb..', …], palette: { b: '#7c2d12' } },
// at most 16 × 24, '.' or ' ' see-through. null when it isn't one.
export function cleanSprite(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows) || !raw.palette || typeof raw.palette !== 'object') return null;
  const palette = {};
  for (const [c, v] of Object.entries(raw.palette).slice(0, 16)) {
    if (/^[\x21-\x7e]$/.test(c) && c !== '.' && /^#[0-9a-f]{3,8}$/i.test(v || '')) palette[c] = v;
  }
  const rows = raw.rows.slice(0, SPRITE_H).map((r) => (typeof r === 'string' ? [...r.slice(0, SPRITE_W)].map((c) => (palette[c] ? c : '.')).join('') : ''));
  return rows.some((r) => /[^.]/.test(r)) ? { rows, palette } : null;
}

// The manifest in a WASM file's bytes, or null (no section, or not JSON).
// Walks the sections without compiling anything.
export function readManifest(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
  let i = 8;
  const u32 = () => {
    let n = 0, shift = 0, b;
    do { if (i >= bytes.length) throw new Error('eof'); b = bytes[i++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80 && shift < 35);
    return n;
  };
  try {
    while (i < bytes.length) {
      const id = bytes[i++], size = u32(), end = i + size;
      if (end > bytes.length) return null;
      if (id === 0) {
        const n = u32();
        const name = new TextDecoder().decode(bytes.subarray(i, i + n));
        if (name === MANIFEST_SECTION) {
          const body = bytes.subarray(i + n, end);
          return body.length <= MAX_BYTES ? cleanManifest(JSON.parse(new TextDecoder().decode(body))) : null;
        }
      }
      i = end;
    }
  } catch { /* not a manifest we can read */ }
  return null;
}
