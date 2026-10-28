// Generate the MkDocs site's pages: the guide from README.md (one page per
// `##` section) and the API reference from the entities' `static api`, the
// World, wrangler.toml and the plugin Workers (server/apidoc.js), plus
// mkdocs.yml with the nav. `just docs` then builds the site into
// public/docs (served at /docs). `node scripts/docs.mjs --check` fails if a
// generated file is stale.

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { describeApi, parseWrangler, renderPages } from '../server/apidoc.js';
import { PLUGIN_OBJECTS } from '../public/js/map.js';
import { bindingName } from '../server/plugins.js';

// Plugin Workers import cloudflare:workers, which only exists on Workers; a
// stand-in base class is all it takes to read their static descriptions.
registerHooks({
  resolve: (spec, ctx, next) => (spec === 'cloudflare:workers' ? { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true } : next(spec, ctx)),
});

// Each [[services]] binding: the plugin Worker it points at (found by name
// under plugins/*/wrangler.toml), its entrypoint's static description, and
// the objects on the map that use it.
async function pluginDocs(services) {
  const workers = {};
  for (const dir of await readdir(path.join(root, 'plugins')).catch(() => [])) {
    const text = await readFile(path.join(root, 'plugins', dir, 'wrangler.toml'), 'utf8').catch(() => null);
    const name = text?.match(/^name\s*=\s*"([^"]+)"/m)?.[1], main = text?.match(/^main\s*=\s*"([^"]+)"/m)?.[1];
    if (name && main) workers[name] = { dir: `plugins/${dir}`, main: path.join(root, 'plugins', dir, main) };
  }
  const out = [];
  for (const s of services) {
    const w = workers[s.service];
    if (!w) continue;
    const mod = await import(pathToFileURL(w.main).href);
    const E = mod[s.entrypoint || 'default'];
    if (!E) throw new Error(`${s.service} has no entrypoint ${s.entrypoint}`);
    const objects = PLUGIN_OBJECTS.filter((f) => bindingName(f.plugin) === s.binding).map((f) => f.id);
    out.push({ name: E.title || s.entrypoint, doc: E.doc || '', prompt: E.prompt || null, api: E.api || {}, binding: s.binding, service: s.service, entrypoint: s.entrypoint, source: w.dir, objects });
  }
  return out;
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/nandi-conda/agentoffice';
const GENERATED = ['docs/index.md', 'docs/guide', 'docs/api', 'mkdocs.yml'];

// GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes.
const slug = (h) => h.toLowerCase().replace(/[^\w\- ]+/g, '').trim().replace(/ /g, '-');

// README.md → docs/index.md (the intro) + docs/guide/<section>.md, with
// links fixed up for where each page now lives.
export function readmePages(readme) {
  const lines = readme.split('\n');
  const parts = [{ title: null, lines: [] }];
  let fence = false;
  for (const line of lines) {
    if (line.startsWith('```')) fence = !fence;
    if (!fence && line.startsWith('## ')) parts.push({ title: line.slice(3).trim(), lines: [] });
    else parts.at(-1).lines.push(line);
  }
  const [intro, ...secs] = parts;
  for (const s of secs) s.file = `guide/${slug(s.title)}.md`;
  // Which page each heading anchor ends up on.
  const where = new Map();
  for (const s of secs) {
    where.set(slug(s.title), s.file);
    for (const l of s.lines) if (/^#{3,} /.test(l)) where.set(slug(l.replace(/^#+ /, '')), s.file);
  }
  const fix = (text, from) => {
    const rel = (to) => path.posix.relative(path.posix.dirname(from), to) || path.posix.basename(to);
    return text.replace(/\]\(([^)\s]+)\)/g, (m, url) => {
      if (/^[a-z]+:/i.test(url) || url.startsWith('/')) return m;
      if (url.startsWith('#')) {
        const page = where.get(url.slice(1));
        return page ? `](${page === from ? '' : rel(page)}${url})` : m;
      }
      if (url.startsWith('docs/')) return `](${rel(url.slice(5))})`;
      return `](${REPO}/blob/main/${url})`;
    });
  };
  const demote = (ls) => {
    let f = false;
    return ls.map((l) => { if (l.startsWith('```')) f = !f; return !f && /^#{3,} /.test(l) ? l.slice(1) : l; });
  };
  const pages = {}, nav = [{ Home: 'index.md' }];
  const [h1, ...rest] = intro.lines;
  pages['index.md'] = [h1, ...rest, '', '## Contents', '', ...secs.map((s) => `- [${s.title}](${s.file})`), '- [API reference](api/index.md)', ''];
  pages['index.md'] = fix(pages['index.md'].join('\n'), 'index.md');
  for (const s of secs) {
    pages[s.file] = fix([`# ${s.title}`, ...demote(s.lines)].join('\n'), s.file);
    nav.push({ [s.title]: s.file });
  }
  for (const k of Object.keys(pages)) pages[k] = `${pages[k].replace(/\n{3,}/g, '\n\n').trim()}\n`;
  return { pages, nav };
}

const yamlNav = (items, indent = '  ') => items.map((it) => {
  const [k, v] = Object.entries(it)[0];
  return Array.isArray(v) ? `${indent}- ${JSON.stringify(k)}:\n${yamlNav(v, `${indent}    `)}` : `${indent}- ${JSON.stringify(k)}: ${v}`;
}).join('\n');

export async function build() {
  const wrangler = parseWrangler(await readFile(path.join(root, 'wrangler.toml'), 'utf8'));
  const guide = readmePages(await readFile(path.join(root, 'README.md'), 'utf8'));
  const api = renderPages(describeApi({ wrangler, plugins: await pluginDocs(wrangler.services) }));
  const files = {};
  for (const [k, v] of Object.entries({ ...guide.pages, ...api.pages })) files[`docs/${k}`] = v;
  files['mkdocs.yml'] = `# Generated by scripts/docs.mjs (\`just docs\`); edit README.md or the entities' static api instead.
site_name: Agent Office
site_description: A virtual coworking office where people and AI agents work side by side
site_url: https://agentoffice.nandithebull.workers.dev/docs/
repo_url: ${REPO}
edit_uri: ''
docs_dir: docs
site_dir: public/docs
theme:
  name: material
  features: [navigation.sections, navigation.top, search.highlight, content.code.copy]
  palette:
    - media: "(prefers-color-scheme: light)"
      scheme: default
      primary: brown
      accent: amber
      toggle: { icon: material/weather-night, name: Dark mode }
    - media: "(prefers-color-scheme: dark)"
      scheme: slate
      primary: brown
      accent: amber
      toggle: { icon: material/weather-sunny, name: Light mode }
markdown_extensions: [admonition, attr_list, tables, toc: { permalink: true }]
nav:
${yamlNav([...guide.nav, { 'Writing a plugin': 'plugins.md' }, { 'API reference': api.nav }])}
`;
  return files;
}

// Every generated file on disk now, so stale pages (a removed entity or
// README section) get noticed and cleaned up.
async function existing() {
  const out = [];
  for (const g of GENERATED) {
    const full = path.join(root, g);
    if (g.endsWith('.md') || g.endsWith('.yml')) { out.push(g); continue; }
    for (const f of await readdir(full).catch(() => [])) out.push(`${g}/${f}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const files = await build();
  let stale = 0;
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, file);
    if ((await readFile(full, 'utf8').catch(() => '')) === text) continue;
    if (check) { console.error(`${file} is out of date: run \`just docs\``); stale++; continue; }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
    console.log(`wrote ${file}`);
  }
  for (const file of await existing()) {
    if (file in files) continue;
    if (check) { console.error(`${file} is no longer generated: run \`just docs\``); stale++; }
    else { await rm(path.join(root, file)); console.log(`removed ${file}`); }
  }
  process.exit(stale ? 1 : 0);
}
