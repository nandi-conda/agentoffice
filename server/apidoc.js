// The office API, generated from what every entity kind declares (its
// `static api`, see entities/schema.js), the World, the wrangler bindings
// and the plugin Workers bound to items. One description feeds:
//
//   - docs/API.md and public/docs.html (`just docs`, checked by the tests)
//   - /api/schema (the same description as JSON, live)
//   - the MCP tools generated from it (server/mcp.js): one per public method
//
// Runtime-neutral: no node:* imports, so the Worker can serve /api/schema.

import { KINDS, MIRRORED } from './entities/kinds.js';
import { BUILTIN_API, describeKind, inputSchema, paramList } from './entities/schema.js';
import { BINDINGS, CLASSES } from './entities/bindings.js';
import { WORLD } from './office.js';

// Every address the office knows of, by kind ('desk' → ['desk-1', …]).
function instancesOf(kind) {
  const names = MIRRORED.filter((a) => a.startsWith(`${kind}:`)).map((a) => a.slice(kind.length + 1));
  return names.length ? names : null;
}

// Durable Object and service bindings from wrangler.toml (just the
// [[durable_objects.bindings]] and [[services]] tables).
export function parseWrangler(text) {
  const out = { durableObjects: [], services: [] };
  let cur = null;
  for (const line of String(text).split('\n').map((l) => l.trim())) {
    if (line.startsWith('[')) {
      cur = line === '[[durable_objects.bindings]]' ? {} : line === '[[services]]' ? {} : null;
      if (cur) (line === '[[services]]' ? out.services : out.durableObjects).push(cur);
      continue;
    }
    const m = cur && line.match(/^(\w+)\s*=\s*"([^"]*)"/);
    if (m) cur[m[1]] = m[2];
  }
  return out;
}

// plugins: [{ object, binding, name, doc, api, prompt }], what each plugin
// Worker's describe() returns plus the item it is bound to.
export function describeApi({ kinds = KINDS, wrangler = null, plugins = [] } = {}) {
  const entities = Object.entries(kinds).map(([kind, Kind]) => {
    const d = describeKind(kind, Kind);
    const binding = BINDINGS[kind] || null;
    return { ...d, class: Kind.name, binding, doClass: binding ? CLASSES[binding] || null : null, instances: instancesOf(kind) };
  });
  return {
    world: { kind: 'world', address: 'world:main', binding: BINDINGS.world, doClass: CLASSES[BINDINGS.world], ...WORLD },
    entities,
    plugins,
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
      const many = !e.instances || e.instances.length > 1;
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
        description: `${spec.doc}${spec.inZone ? ' You must be standing in its zone.' : ''} (Entity ${e.kind}${e.instances?.length === 1 ? `:${e.instances[0]}` : ''}, method ${method}.)`,
        input,
        readOnly: !spec.mutates && !spec.who && !spec.inZone,
        needsZone: !!spec.inZone && many,
        address: (args, zone) => `${e.kind}:${many ? (args.name || zone) : e.instances[0]}`,
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
  return [entity(api.world), { ...entity(builtins), id: 'entity', title: 'Every entity (built-ins)' }, ...api.entities.map(entity), ...api.plugins.map((p) => ({
    id: `plugin-${p.object || p.name}`,
    title: `plugin ${p.name}${p.object ? ` on ${p.object}` : ''}`,
    doc: p.doc || '',
    where: [p.binding && `service binding \`${p.binding}\` (WorkerEntrypoint)`, p.object && `item \`${p.object}\``].filter(Boolean),
    methods: Object.entries(p.api || {}).map(([m, spec]) => ({ name: m, sig: signature(m, spec), doc: spec.doc || '', flags: flags(spec), rows: paramRows(spec), returns: spec.returns ? typeOf(spec.returns) : null, tool: null })),
    events: [],
  }))];
}

const INTRO = 'Generated from the `static api` each entity declares (server/entities), the World, wrangler.toml and the plugin Workers. Do not edit by hand: run `just docs`. The same description is served live as JSON at `/api/schema`, and every method that is not internal is also an MCP tool at `/mcp` (read-only ones are open to everyone; the rest need you signed in and in the office).';

export function renderMarkdown(api) {
  const out = ['# Agent Office API', '', INTRO, ''];
  const secs = sections(api);
  out.push('## Contents', '', ...secs.map((s) => `- [${s.title}](#${s.id})`), '');
  if (api.bindings) {
    out.push('## Bindings', '', '| Binding | Kind | Class / service |', '| --- | --- | --- |');
    for (const b of api.bindings.durableObjects) out.push(`| \`${b.name}\` | Durable Object | \`${b.class_name}\` |`);
    for (const b of api.bindings.services) out.push(`| \`${b.binding}\` | service | \`${b.service}\`${b.entrypoint ? ` → \`${b.entrypoint}\`` : ''} |`);
    out.push('');
  }
  for (const s of secs) {
    out.push(`<a id="${s.id}"></a>`, '', `## ${s.title}`, '', s.doc, '', ...s.where.map((w) => `- ${w}`), '');
    for (const m of s.methods) {
      out.push(`### \`${m.sig}\``, '', `${m.flags.join(' · ')}${m.tool ? ` · MCP tool \`${m.tool}\`` : ''}`, '', m.doc, '');
      if (m.rows.length) {
        out.push('| Param | Type | |', '| --- | --- | --- |');
        for (const r of m.rows) out.push(`| ${r.depth ? '&nbsp;&nbsp;' : ''}\`${r.name}\`${r.optional ? ' (optional)' : ''} | ${r.type.replace(/\|/g, '\\|')} | ${r.doc.replace(/\|/g, '\\|')} |`);
        out.push('');
      }
      if (m.returns) out.push(`Returns \`${m.returns}\``, '');
    }
    if (s.events.length) {
      out.push('**Events**', '');
      for (const ev of s.events) out.push(`- ${ev.dir} \`${ev.topic}\`: ${ev.doc}`);
      out.push('');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

export function renderHtml(api) {
  const secs = sections(api);
  const method = (m) => `
      <article class="method">
        <h3><code>${esc(m.sig)}</code></h3>
        <p class="flags">${m.flags.map((f) => `<span class="tag${f === 'mutates' ? ' mut' : ''}">${esc(f)}</span>`).join('')}${m.tool ? `<span class="tag tool">MCP <code>${esc(m.tool)}</code></span>` : ''}</p>
        <p>${code(m.doc)}</p>
        ${m.rows.length ? `<table><tbody>${m.rows.map((r) => `<tr><td class="${r.depth ? 'sub' : ''}"><code>${esc(r.name)}</code>${r.optional ? ' <i>optional</i>' : ''}</td><td><code>${esc(r.type)}</code></td><td>${esc(r.doc)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${m.returns ? `<p class="ret">Returns <code>${esc(m.returns)}</code></p>` : ''}
      </article>`;
  const bindings = api.bindings ? `
    <section id="bindings"><h2>Bindings</h2><table><thead><tr><th>Binding</th><th>Kind</th><th>Class / service</th></tr></thead><tbody>
      ${api.bindings.durableObjects.map((b) => `<tr><td><code>${esc(b.name)}</code></td><td>Durable Object</td><td><code>${esc(b.class_name)}</code></td></tr>`).join('')}
      ${api.bindings.services.map((b) => `<tr><td><code>${esc(b.binding)}</code></td><td>service</td><td><code>${esc(b.service)}${b.entrypoint ? ` → ${esc(b.entrypoint)}` : ''}</code></td></tr>`).join('')}
    </tbody></table></section>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Office API</title>
<meta name="description" content="Every entity, method, event and MCP tool in Agent Office, generated from the code.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root { --bg: #faf7f2; --fg: #2b2622; --muted: #6b625a; --card: #fff; --line: #e7e0d6; --accent: #b45309; --mut: #9a3412; --tool: #1d4ed8; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #1c1916; --fg: #eee7df; --muted: #a89e93; --card: #26221e; --line: #3a342e; --accent: #f59e0b; --mut: #fb923c; --tool: #93c5fd; color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #1c1916; --fg: #eee7df; --muted: #a89e93; --card: #26221e; --line: #3a342e; --accent: #f59e0b; --mut: #fb923c; --tool: #93c5fd; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 Inter, system-ui, sans-serif; }
.wrap { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 32px; max-width: 1100px; margin: 0 auto; padding: 32px 16px; }
nav { position: sticky; top: 24px; align-self: start; font-size: 14px; }
nav a { display: block; color: var(--muted); text-decoration: none; padding: 2px 0; }
nav a:hover { color: var(--accent); }
h1 { margin: 0 0 8px; font-size: 28px; }
h2 { margin: 40px 0 6px; font-size: 21px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { margin: 0 0 4px; font-size: 15px; }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.intro, .where { color: var(--muted); }
.where { margin: 4px 0 12px; padding-left: 18px; }
.method { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
.method p { margin: 6px 0; }
.flags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; color: var(--muted); }
.tag.mut { color: var(--mut); border-color: currentColor; }
.tag.tool { color: var(--tool); border-color: currentColor; }
table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 8px 0; display: block; overflow-x: auto; }
td, th { text-align: left; vertical-align: top; padding: 4px 10px 4px 0; border-top: 1px solid var(--line); }
td.sub { padding-left: 16px; }
.ret { color: var(--muted); }
.events li code { color: var(--accent); }
@media (max-width: 760px) { .wrap { grid-template-columns: 1fr; } nav { position: static; } }
</style>
</head>
<body>
<div class="wrap">
  <nav aria-label="Contents">
    ${api.bindings ? '<a href="#bindings">Bindings</a>' : ''}
    ${secs.map((s) => `<a href="#${esc(s.id)}">${esc(s.title)}</a>`).join('\n    ')}
  </nav>
  <main>
    <h1>Agent Office API</h1>
    <p class="intro">${code(INTRO)} <a href="/api/schema">JSON</a></p>
    ${bindings}
    ${secs.map((s) => `
    <section id="${esc(s.id)}">
      <h2>${esc(s.title)}</h2>
      <p>${code(s.doc)}</p>
      <ul class="where">${s.where.map((w) => `<li>${code(w)}</li>`).join('')}</ul>
      ${s.methods.map(method).join('')}
      ${s.events.length ? `<h3>Events</h3><ul class="events">${s.events.map((ev) => `<li>${esc(ev.dir)} <code>${esc(ev.topic)}</code>: ${esc(ev.doc)}</li>`).join('')}</ul>` : ''}
    </section>`).join('')}
  </main>
</div>
</body>
</html>
`;
}
