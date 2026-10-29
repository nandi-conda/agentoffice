// The office API, generated from what every entity kind declares (its
// `static api`, see entities/schema.js), the World, the wrangler bindings
// and the WASM plugins' manifests. One description feeds:
//
//   - the API pages of the MkDocs site (docs/api, `just docs`; checked by the tests)
//   - /api/schema (the same description as JSON, live)
//   - the MCP tools generated from it (server/mcp.js): one per public method
//
// Runtime-neutral: no node:* imports, so the Worker can serve /api/schema.

import { KINDS, MIRRORED } from './entities/kinds.js';
import { BUILTIN_API, describeKind, inputSchema, paramList } from './entities/schema.js';
import { BINDINGS, CLASSES } from './entities/bindings.js';
import { WORLD, INVENTORY, MOD } from './office.js';
import { CAPS, ROLES } from '../public/js/roles.js';

// Every address the office knows of, by kind ('desk' → ['desk-1', …]).
function instancesOf(kind) {
  const names = MIRRORED.filter((a) => a.startsWith(`${kind}:`)).map((a) => a.slice(kind.length + 1));
  return names.length ? names : null;
}

// Durable Object bindings from wrangler.toml (the [[durable_objects.bindings]]
// tables), plus the other bindings by name ([ai], [[worker_loaders]], [assets]).
export function parseWrangler(text) {
  const out = { durableObjects: [], other: [] };
  const OTHER = { '[ai]': 'Workers AI', '[[worker_loaders]]': 'Worker Loader', '[assets]': 'static assets' };
  let cur = null;
  for (const line of String(text).split('\n').map((l) => l.trim())) {
    if (line.startsWith('[')) {
      cur = line === '[[durable_objects.bindings]]' ? {} : OTHER[line] ? { kind: OTHER[line] } : null;
      if (cur) (cur.kind ? out.other : out.durableObjects).push(cur);
      continue;
    }
    const m = cur && line.match(/^(\w+)\s*=\s*"([^"]*)"/);
    if (m) cur[m[1]] = m[2];
  }
  return out;
}

// uploads: [{ name, doc, prompt, api, file, source, objects }], the manifests
// of the WASM plugins in public/plugins (public/js/manifest.js): the office's
// own objects (objects = their ids on the map) and the example uploads.
export function describeApi({ kinds = KINDS, wrangler = null, uploads = [] } = {}) {
  const entities = Object.entries(kinds).map(([kind, Kind]) => {
    const d = describeKind(kind, Kind);
    const binding = BINDINGS[kind] || null;
    return { ...d, class: Kind.name, binding, doClass: binding ? CLASSES[binding] || null : null, instances: instancesOf(kind) };
  });
  // Not a Durable Object of its own: the World serves it, always for the caller.
  entities.push({ kind: 'inventory', doc: INVENTORY.doc, api: INVENTORY.api, events: {}, class: 'Office', binding: BINDINGS.world, doClass: CLASSES[BINDINGS.world], instances: ['me'] });
  entities.push({ kind: 'mod', doc: MOD.doc, api: MOD.api, events: {}, class: 'Office', binding: BINDINGS.world, doClass: CLASSES[BINDINGS.world], instances: ['main'] });
  return {
    world: { kind: 'world', address: 'world:main', binding: BINDINGS.world, doClass: CLASSES[BINDINGS.world], ...WORLD },
    entities,
    uploads,
    bindings: wrangler,
  };
}

// ---- MCP tools ----------------------------------------------------------------

// One tool per public entity method. `input` is a JSON Schema object; `call`
// turns a tool's arguments into the address and positional params for
// Office.call. A method whose only param is an object takes that object's
// fields directly, so tools read { room, op, title } and not { m: {…} }.
export function generatedTools(api) {
  const tools = [];
  for (const e of api.entities) {
    for (const [method, spec] of Object.entries(e.api)) {
      if (spec.internal) continue;
      const params = paramList(spec);
      const flat = params.length === 1 && params[0][1].type === 'object' && params[0][1].properties;
      const input = flat ? structuredClone({ ...params[0][1], description: undefined }) : inputSchema(spec);
      delete input.description;
      if (flat && params[0][1].optional) input.required = [];
      // Which entity: a fixed one, one of a known set, or any name.
      // A `self` entity is always the caller's own (the World names it).
      const many = !spec.self && (!e.instances || e.instances.length > 1);
      if (many) {
        if ('name' in input.properties) throw new Error(`${e.kind}.${method}: param "name" clashes with the entity name`);
        input.properties = {
          name: e.instances
            ? { type: 'string', enum: e.instances, description: spec.inZone ? `Which ${e.kind} (default: the one in your zone)` : `Which ${e.kind}` }
            : { type: 'string', maxLength: 253, description: `The ${e.kind} name (address ${e.kind}:<name>)` },
          ...input.properties,
        };
        if (!spec.inZone) input.required = ['name', ...(input.required || [])];
      }
      tools.push({
        name: `${e.kind}_${method}`,
        kind: e.kind, method,
        description: `${spec.doc}${spec.inZone ? ' You must be standing in its zone.' : ''}${spec.atDesk ? ' You must be at a desk: take_desk first.' : ''}${spec.near ? ` You must be within ${spec.near} tiles of it: walk_to it first.` : ''} (Entity ${e.kind}${e.instances?.length === 1 ? `:${e.instances[0]}` : ''}, method ${method}.)`,
        input,
        readOnly: !spec.mutates && !spec.who && !spec.inZone && !spec.near && !spec.self && !spec.role,
        // The least role that may use it (public/js/roles.js): the MCP hub
        // only lists a tool to callers who have it.
        role: spec.role || (!spec.mutates && !spec.who && !spec.inZone && !spec.near && !spec.self ? 'observer' : 'guest'),
        needsZone: !!spec.inZone && many,
        address: (args, zone) => `${e.kind}:${spec.self ? 'self' : many ? (args.name || zone) : e.instances[0]}`,
        args: (args) => (flat ? [Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'name' || !many))] : params.map(([k]) => args[k])),
      });
    }
  }
  return tools;
}

// ---- rendering --------------------------------------------------------------------

// A JSON Schema in a few words: "string ≤ 80", "integer 1–10000", "{ op, id? }".
export function typeOf(s = {}) {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type;
  if (t === 'string') return `string${s.maxLength ? ` ≤ ${s.maxLength}` : ''}${s.pattern ? ` /${s.pattern}/` : ''}`;
  if (t === 'integer' || t === 'number') {
    const lo = s.minimum, hi = s.maximum;
    return `${t}${lo !== undefined && hi !== undefined ? ` ${lo}–${hi}` : lo !== undefined ? ` ≥ ${lo}` : hi !== undefined ? ` ≤ ${hi}` : ''}`;
  }
  if (t === 'array') return `${typeOf(s.items)}[]${s.maxItems ? ` (≤ ${s.maxItems})` : ''}`;
  if (t === 'object' && s.properties && Object.keys(s.properties).length) {
    const req = new Set(s.required || []);
    return `{ ${Object.keys(s.properties).map((k) => (req.has(k) ? k : `${k}?`)).join(', ')} }`;
  }
  return t || 'any';
}

const signature = (method, spec) => {
  const ps = [...(spec.who ? ['who'] : []), ...paramList(spec).map(([k, s]) => (s.optional ? `${k}?` : k)), ...(spec.ctx ? ['ctx'] : [])];
  return `${method}(${ps.join(', ')})`;
};

const flags = (spec) => [
  spec.mutates ? 'mutates' : 'read-only',
  spec.who && 'caller filled in by the World',
  spec.ctx && 'ctx { all, presence } filled in by the World',
  spec.inZone && 'caller must be in its zone',
  spec.near && `caller must be within ${spec.near} tiles`,
  spec.self && 'always the caller\'s own (the World picks the address)',
  spec.atDesk && 'caller must be at a desk',
  spec.role && `role ≥ ${spec.role}`,
  spec.cap && `${CAPS[spec.cap] || 'moderator'}s may for anyone (${spec.cap})`,
  spec.internal && 'internal (entity to entity)',
].filter(Boolean);

// The rows under a method: each param, nested object fields one level down.
function paramRows(spec) {
  const rows = [];
  for (const [k, s] of paramList(spec)) {
    rows.push({ name: k, type: typeOf(s), doc: s.description || '', optional: !!s.optional, depth: 0 });
    if (s.type === 'object' && s.properties) {
      const req = new Set(s.required || []);
      for (const [f, fs] of Object.entries(s.properties)) rows.push({ name: `${k}.${f}`, type: typeOf(fs), doc: fs.description || '', optional: !req.has(f), depth: 1 });
    }
  }
  return rows;
}

// A plugin's or upload's actions, as methods.
const pluginMethods = (api) => Object.entries(api || {}).map(([m, spec]) => ({ name: m, sig: `${m}(${paramList(spec).map(([k]) => k).join(', ')})`, doc: spec.doc || '', flags: flags(spec), rows: paramRows(spec), returns: spec.returns ? typeOf(spec.returns) : null, tool: null }));

function sections(api) {
  const tools = new Map(generatedTools(api).map((t) => [`${t.kind}.${t.method}`, t]));
  // The internal built-ins every entity answers get one section of their own.
  const shared = (m, spec) => spec === BUILTIN_API[m] && spec.internal;
  const entity = (e) => ({
    id: e.kind,
    title: e.kind === 'world' ? 'world (the World)' : `${e.kind} (${e.class})`,
    doc: e.doc,
    where: [
      e.address ? `address \`${e.address}\`` : `address \`${e.kind}:<name>\``,
      e.binding && `Durable Object binding \`${e.binding}\` (class \`${e.doClass}\`)`,
      e.instances && `${e.instances.length === 1 ? 'one' : e.instances.length}: ${e.instances.map((n) => `\`${n}\``).join(', ')}`,
    ].filter(Boolean),
    methods: Object.entries(e.api).filter(([m, spec]) => e.builtins || !shared(m, spec)).map(([m, spec]) => ({ name: m, sig: signature(m, spec), doc: spec.doc || '', flags: flags(spec), rows: paramRows(spec), returns: spec.returns ? typeOf(spec.returns) : null, tool: tools.get(`${e.kind}.${m}`)?.name || null })),
    events: Object.entries(e.events || {}).flatMap(([dir, list]) => Object.entries(list).map(([topic, doc]) => ({ dir, topic, doc }))),
  });
  const builtins = {
    kind: 'entity', address: '<kind>:<name>', builtins: true, events: {},
    doc: 'Every entity answers these besides its own methods (server/entities/runtime.js). Entities talk by direct RPC (this.ref(address).method()), messages (this.tell(address, type, data) → receive → onMessage) and pub/sub (this.subscribe(topic), this.publish(topic, ev) → notify → onEvent). Calls are structured-cloned on Node and on Workers alike.',
    api: Object.fromEntries(Object.entries(BUILTIN_API).filter(([m, spec]) => shared(m, spec))),
  };
  return [entity(api.world), { ...entity(builtins), id: 'entity', title: 'Every entity (built-ins)' }, ...api.entities.map(entity), ...(api.uploads || []).map((u) => ({
    id: `upload-${u.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    title: `${u.objects?.length ? "wasm" : "upload"}: ${u.name}`,
    doc: `${u.doc}${u.prompt ? ` People see it as “${u.prompt}”.` : ''}`,
    where: u.objects?.length ? [
      `a WASM plugin the office ships: \`${u.file}\`, built from \`${u.source}\` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox`,
      `on the map as ${u.objects.map((o) => `\`plugin:${o}\``).join(', ')}: use it with the MCP tool \`plugin_interact\` (name ${u.objects.map((o) => `\`${o}\``).join(', ')}, action = one of these)`,
    ] : [
      `an example upload: \`${u.file}\`, built from \`${u.source}\` with the agentoffice-plugin crate, whose manifest these actions come from`,
      'put it on the map from the 🧩 panel ("try the example") or with `gallery_upload`, then use it with the MCP tool `uobj_interact` (name = its `u-…` id from `gallery_view`, action = one of these, input = the typed text)',
    ],
    methods: pluginMethods(u.api).map((m) => ({ ...m, flags: [u.objects?.length ? 'an action: plugin_interact { action }' : 'an action: uobj_interact { action, input }'] })),
    events: [],
  }))];
}

const INTRO = 'Generated from the `static api` each entity declares (`server/entities`), the World, `wrangler.toml` and the WASM plugins\' manifests, so don\'t edit these pages by hand: run `just docs`. The same description is served live as JSON at [`/api/schema`](/api/schema), and every method that is not internal is also an MCP tool at `/mcp`: read-only ones are open to everyone, the rest need you signed in and in the office, and some need a server role (see below). An MCP session only lists the tools its role may use.';

const ACCESS = { observer: 'open', guest: 'signed in, in the office' };

const cell = (s) => String(s).replace(/\|/g, '\\|');

function methodMd(m) {
  const out = [`## \`${m.sig}\``, '', `${m.flags.map((f) => `\`${f}\``).join(' · ')}${m.tool ? ` · MCP tool **\`${m.tool}\`**` : ''}`, '', m.doc, ''];
  if (m.rows.length) {
    out.push('| Param | Type | |', '| --- | --- | --- |');
    for (const r of m.rows) out.push(`| ${r.depth ? '&nbsp;&nbsp;&nbsp;' : ''}\`${r.name}\`${r.optional ? ' *(optional)*' : ''} | \`${cell(r.type)}\` | ${cell(r.doc)} |`);
    out.push('');
  }
  if (m.returns) out.push(`Returns \`${m.returns}\``, '');
  return out;
}

// The API as MkDocs pages: { 'api/index.md': …, 'api/desk.md': … } plus
// the nav entries for mkdocs.yml, in order.
export function renderPages(api) {
  const secs = sections(api);
  const pages = {}, nav = [{ Overview: 'api/index.md' }];
  const index = ['# API', '', INTRO, '', '| Page | What it is |', '| --- | --- |'];
  for (const s of secs) index.push(`| [${s.title}](${s.id}.md) | ${cell(s.doc.split(/(?<=\.)\s/)[0])} |`);
  index.push('');
  if (api.bindings) {
    index.push('## Bindings', '', 'From `wrangler.toml`.', '', '| Binding | Kind | Class |', '| --- | --- | --- |');
    for (const b of api.bindings.durableObjects) index.push(`| \`${b.name}\` | Durable Object | \`${b.class_name}\` |`);
    for (const b of api.bindings.other || []) if (b.binding) index.push(`| \`${b.binding}\` | ${b.kind} | |`);
    index.push('');
  }
  const tools = generatedTools(api);
  index.push('## Roles', '', 'Everyone has one server role (`public/js/roles.js`). Signed-in people are members and signed-in agents are agents unless granted something else; people in the office without signing in are guests, and MCP sessions that haven\'t signed in are observers. Owners and admins start from the `OWNER_DIDS` and `ADMIN_DIDS` env vars (without `OWNER_DIDS`, the first `ADMIN_DIDS` entry is the owner); MCP sessions with the operator token (`MCP_TOKEN`) are owners. Admins grant the rest with `mod_grant` or the admin panel.', '', '| Role | |', '| --- | --- |');
  for (const [r, v] of Object.entries(ROLES)) index.push(`| \`${r}\` ${v.badge} | ${cell(v.doc)} |`);
  index.push('', '| Capability | Needs |', '| --- | --- |');
  for (const [c, r] of Object.entries(CAPS)) index.push(`| \`${c}\` | ${r} |`);
  index.push('');
  index.push('## MCP tools', '', `${tools.length} tools are generated from these methods, next to the hand-written ones (join_office, look, walk_to…).`, '', '| Tool | Access | |', '| --- | --- | --- |');
  for (const t of tools) index.push(`| \`${t.name}\` | ${ACCESS[t.role] || `${t.role} and up, in the office`} | [${t.kind}.${t.method}](${t.kind}.md) |`);
  pages['api/index.md'] = index;
  for (const s of secs) {
    const out = [`# ${s.title}`, '', s.doc, '', ...s.where.map((w) => `- ${w}`), ''];
    for (const m of s.methods) out.push(...methodMd(m));
    if (s.events.length) {
      out.push('## Events', '');
      for (const ev of s.events) out.push(`- ${ev.dir} \`${ev.topic}\`: ${ev.doc}`);
      out.push('');
    }
    pages[`api/${s.id}.md`] = out;
    nav.push({ [s.title]: `api/${s.id}.md` });
  }
  for (const k of Object.keys(pages)) pages[k] = `${pages[k].join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  return { pages, nav };
}
