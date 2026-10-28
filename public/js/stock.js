// Stock rpg.actor characters for people without a sprite of their own
// (guests, agents, freeq nicks, or anyone whose sheet fails to load).
//
// They are built from the rpg.actor Sprite Generator's own layer art, picked
// deterministically from the person's DID or name, and composited the way the
// generator does it: each layer has a grey base PNG and a `_c` colour map
// whose sentinel and channel colours say what to recolour. The recolour maths
// mirrors rpg.actor's js/generator-bake.js.
//
// Generator art © isilme (@isilme.reverie.house), CC BY 4.0 — see README.
// The layer PNGs come through our own /api/stock/ proxy, so the browser can
// read their pixels without CORS trouble.

export const STOCK_BASE = '/api/stock/';
// Straight from rpg.actor, used when our proxy can't fetch a part. Only
// usable when rpg.actor allows cross-origin reads; otherwise it fails too.
export const STOCK_DIRECT = 'https://rpg.actor/assets/generator/';
export const W = 144, H = 192;

// --- recolour (after rpg.actor's generator-bake.js) ----------------------

const MARKER_TOL = 12, SUBTRACT_TOL = 8;
const SKIN_MARK = [249, 193, 157], HAIR_MARK = [252, 203, 10];
const EYE_MARKS = [[44, 128, 203], [19, 128, 248]];

const near = (r, g, b, m) => Math.abs(r - m[0]) <= MARKER_TOL && Math.abs(g - m[1]) <= MARKER_TOL && Math.abs(b - m[2]) <= MARKER_TOL;
const lumOf = (r, g, b) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);
const isSubtract = (r, g, b) => r <= SUBTRACT_TOL && g <= SUBTRACT_TOL && b <= SUBTRACT_TOL;

export function hexToRgb(hex) {
  const s = String(hex || '').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

// Dual ramp: dark half scales toward black, light half toward white.
export function modulate(hex, lum) {
  const c = hexToRgb(hex);
  if (!c) return null;
  const t = lum / 255;
  if (t <= 0.5) return c.map((v) => Math.round(v * t * 2));
  const f = (t - 0.5) * 2;
  return c.map((v) => Math.round(v + (255 - v) * f));
}

function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Skin keeps rich shadows and warm highlights (generator's custom-skin mode).
function modulateSkin(hsv, lum) {
  const t = lum / 255;
  let { s, v } = hsv;
  if (t <= 0.5) { const f = t / 0.5; v *= 0.1 + 0.9 * f; s = Math.min(1, s * (1 + 0.3 * (1 - f))); }
  else { const f = (t - 0.5) / 0.5; v = Math.min(1, v + (1 - v) * f * 0.8); s *= 1 - f * 0.5; }
  return hsvToRgb(hsv.h, s, v);
}

// Map bytes are channel weights: B = main, G = sub1, R = sub2.
function blend(mR, mG, mB, lum, colors) {
  let total = 0, r = 0, g = 0, b = 0;
  for (const [w, hex] of [[mB, colors.main], [mG, colors.sub1], [mR, colors.sub2]]) {
    if (!(w > 0) || !hex) continue;
    const c = modulate(hex, lum);
    if (!c) continue;
    r += c[0] * w; g += c[1] * w; b += c[2] * w; total += w;
  }
  return total ? [Math.round(r / total), Math.round(g / total), Math.round(b / total)] : null;
}

// Recolours one layer's RGBA bytes through its colour map. Black map pixels
// erase; skin, eye and hair sentinels take the character's colours; anything
// else is a colourway blend.
export function recolor(base, map, { skin, eyes, hair, colors = {} } = {}) {
  const out = new Uint8ClampedArray(base);
  if (!map) return out;
  const skinHsv = skin && hexToRgb(skin) ? rgbToHsv(hexToRgb(skin)) : null;
  for (let i = 0; i < base.length; i += 4) {
    if (map[i + 3] === 0 || base[i + 3] === 0) continue;
    const mR = map[i], mG = map[i + 1], mB = map[i + 2];
    if (isSubtract(mR, mG, mB)) { out[i + 3] = 0; continue; }
    const lum = lumOf(base[i], base[i + 1], base[i + 2]);
    let c;
    if (near(mR, mG, mB, SKIN_MARK)) c = skinHsv && modulateSkin(skinHsv, lum);
    else if (EYE_MARKS.some((m) => near(mR, mG, mB, m))) c = eyes && modulate(eyes, lum);
    else if (near(mR, mG, mB, HAIR_MARK)) c = hair && modulate(hair, lum);
    else c = blend(mR, mG, mB, lum, colors);
    if (c) { out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; }
  }
  return out;
}

// Stacks recoloured layers back to front. A layer's black map pixels punch
// through everything drawn before it, as in the generator.
export function composite(layers, len = W * H * 4) {
  const out = new Uint8ClampedArray(len);
  for (const { base, map, ctx } of layers) {
    if (map) for (let i = 0; i < len; i += 4) if (map[i + 3] && isSubtract(map[i], map[i + 1], map[i + 2])) out[i + 3] = 0;
    const px = recolor(base, map, ctx);
    for (let i = 0; i < len; i += 4) {
      const a = px[i + 3] / 255;
      if (!a) continue;
      const ba = out[i + 3] / 255, oa = a + ba * (1 - a);
      for (let k = 0; k < 3; k++) out[i + k] = Math.round((px[i + k] * a + out[i + k] * ba * (1 - a)) / oa);
      out[i + 3] = Math.round(oa * 255);
    }
  }
  return out;
}

// --- stock looks ---------------------------------------------------------

const SKIN = ['#f9c19d', '#efb48c', '#d99f76', '#bb8158', '#94603d', '#6e4429', '#4f3020'];
const HAIR = ['#2b1d16', '#4a2f1f', '#7a4b2a', '#b5763a', '#e2c47a', '#d8d4cc', '#8c2f2f', '#3a3a48', '#5a7bb5', '#b0508a'];
const EYES = ['#3f2a1c', '#5b4030', '#3f7cac', '#4f8a5b', '#6b6b6b'];
const SHIRT = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b', '#f97316', '#e5e7eb'];
const PANTS = ['#1f2937', '#374151', '#1e3a8a', '#3f3f46', '#78350f', '#14532d', '#6b7280'];
const SHOES = ['#1f2937', '#3b2a20', '#6b4a2e', '#111827'];

const HAIRSTYLES = ['001_basic_short', '002_basic_medium', '003_basic_long', '004_straight_short', '006_straight_long',
  '1000_simple_ponytail', '1001_updo_bun', '1002_buzz_cut', '1011_tight_curls', '1010_slicked_back', '1016_shaggy_mess',
  '1014_bowl_cut', '1023_short_braids', '1021_bantu_knots', '1007_big_curls', '1017_bouncy_waves'];
const BANGS = ['002_front_hang', '001_center_part', '005_side_part'];
const BEARDS = ['003_short_beard', '001_short_goatee', '007_curly_moustache'];
// Tops, with the generator's feminine-body variants where it has one.
const TOPS = {
  '001_basic_shirt': '001_basic_shirt__bta_fem', '006_untucked_shirt': '006_untucked_shirt__bta_fem',
  '003_basic_T-shirt': '003_basic_T-shirt__bta_fem', '004_ringed_T-shirt': '004_ringed_T-shirt__bta_fem',
  '008_striped_shirt': '008_striped_shirt__bta_fem', '012_button_down': '012_button_down__bta_fem',
  '011_full_jacket': '011_full_jacket__bta_fem', '023_cozy_sweater': null, '021_traveller_vest': null,
};
const BOTTOMS = ['001_simple_pants', '001_simple_pants', '002_simple_shorts', '003_simple_skirt'];
const FEET = ['001_simple_boots', '003_simple_flats', '006_dress_shoes'];
const EYE_SHAPES = { male: ['masculine_gaze', '004_cheerful_squint', '005_focused_resolve'], female: ['feminine_lashes', '021_innocent_look', '004_cheerful_squint'] };
const NOSES = ['narrow_nose', 'wide_nose', '002_small_nose'];
const MOUTHS = ['001_neutral_mouth', 'simple_smile', 'simple_smile'];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296; };
}

// The layer recipe for one identity: back-to-front generator layers with the
// asset path (under the generator's asset root) and recolour context.
export function stockRecipe(seedText, kind = 'human') {
  const r = rng(hash(String(seedText || 'guest')));
  const pick = (a) => a[(r() * a.length) | 0];
  const body = r() < 0.5 ? 'male' : 'female';
  const skin = pick(SKIN), hair = pick(HAIR), eyes = pick(EYES);
  const shirt = pick(SHIRT), shirt2 = pick(SHIRT), pants = pick(PANTS), shoes = pick(SHOES);
  const look = { skin, eyes, hair };
  const L = (id, path, colors = {}) => ({ id, path: `${path}.png`, map: `${path}_c.png`, ctx: { ...look, colors } });

  const top = pick(Object.keys(TOPS));
  const layers = [
    L('body', `body/body_${body}_faceless`),
    L('feet', `clothing/feet/${pick(FEET)}`, { main: shoes, sub1: shade(shoes, 30), sub2: shade(shoes, -20) }),
    L('bottoms', `clothing/bottoms/${pick(BOTTOMS)}`, { main: pants }),
    L('tops', `clothing/tops/${(body === 'female' && TOPS[top]) || top}`, { main: shirt, sub1: shirt2 }),
  ];
  if (kind === 'agent') layers.push(L('necklaces', 'accessories/necklaces/003_lanyard_keycard', { main: '#22d3ee', sub1: '#f8fafc' }));
  layers.push(
    L('eyes', `face/eyes/${pick(EYE_SHAPES[body])}`, { main: eyes, sub1: '#2b1d16', sub2: '#2b1d16' }),
    L('nose', `face/nose/${pick(NOSES)}`, { main: shade(skin, -30) }),
    L('mouth', `face/mouth/${pick(MOUTHS)}`, { main: '#9b4a4a' }),
    L('hair', `hairstyle/hair/${pick(HAIRSTYLES)}`, { main: hair }),
  );
  if (r() < 0.4) layers.push(L('bangs', `hairstyle/bangs/${pick(BANGS)}`, { main: hair }));
  if (body === 'male' && r() < 0.3) layers.push(L('beard', `hairstyle/beard/${pick(BEARDS)}`, { main: hair }));
  if (kind === 'agent' || r() < 0.15) {
    layers.push(L('glasses', `accessories/glasses/${kind === 'agent' ? '005_safety_goggles' : '001_basic_glasses'}`,
      kind === 'agent' ? { main: '#64748b', sub1: '#22d3ee', sub2: '#0f172a' } : { main: '#1f2937', sub1: '#cbd5e1' }));
  }
  return { body, layers };
}

function shade(hex, amt) {
  const c = hexToRgb(hex) || [128, 128, 128];
  return '#' + c.map((v) => Math.max(0, Math.min(255, v + amt)).toString(16).padStart(2, '0')).join('');
}

// --- browser side --------------------------------------------------------

const pixelCache = new Map();

function readImage(url, cors) {
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (img.width !== W || img.height !== H) return resolve(null);
      try {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        resolve(g.getImageData(0, 0, W, H).data);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function pixels(path) {
  if (!pixelCache.has(path)) {
    pixelCache.set(path, readImage(STOCK_BASE + path).then((d) => d || readImage(STOCK_DIRECT + path, true)));
  }
  return pixelCache.get(path);
}

const sheetCache = new Map();

// Resolves to a 144x192 canvas in the rpg.actor sheet layout, or null when
// the generator art can't be reached (callers then use the drawn fallback).
export function stockSheet(seedText, kind) {
  const key = `${kind}|${seedText}`;
  if (!sheetCache.has(key)) sheetCache.set(key, buildSheet(seedText, kind));
  return sheetCache.get(key);
}

async function buildSheet(seedText, kind) {
  const { body, layers } = stockRecipe(seedText, kind);
  const load = async (l) => ({ ...l, base: await pixels(l.path), map: await pixels(l.map) });
  // The body goes first: without it there's no stock art to build on. The
  // faceless body may share the regular body's colour map, and older asset
  // sets only have the body with a painted-on face.
  const first = await load(layers[0]);
  let faced = false;
  if (first.base && !first.map) first.map = await pixels(`body/body_${body}_c.png`);
  if (!first.base) {
    first.base = await pixels(`body/body_${body}.png`);
    first.map = await pixels(`body/body_${body}_c.png`);
    if (!first.base) {
      const why = await fetch(STOCK_BASE + layers[0].path)
        .then(async (r) => (r.ok ? `${r.status}, but not a 144x192 image` : `${r.status} ${await r.text()}`))
        .catch((e) => e.message);
      console.warn(`[stock] no rpg.actor body art (${layers[0].path}: ${why}); using the drawn fallback character`);
      return null;
    }
    faced = true;
  }
  const rest = layers.slice(1).filter((l) => !(faced && ['eyes', 'nose', 'mouth'].includes(l.id)));
  const loaded = [first, ...await Promise.all(rest.map(load))];
  const data = composite(loaded.filter((l) => l.base));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(data, W, H), 0, 0);
  return c;
}
