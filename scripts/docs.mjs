// Generate the API docs from the entities' `static api`, the World,
// wrangler.toml and the plugin Workers: docs/API.md and public/docs.html
// (served at /docs). `node scripts/docs.mjs --check` fails if they're stale.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeApi, parseWrangler, renderMarkdown, renderHtml } from '../server/apidoc.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function build() {
  const wrangler = parseWrangler(await readFile(path.join(root, 'wrangler.toml'), 'utf8'));
  const api = describeApi({ wrangler });
  return { 'docs/API.md': renderMarkdown(api), 'public/docs.html': renderHtml(api) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [file, text] of Object.entries(await build())) {
    const full = path.join(root, file);
    const old = await readFile(full, 'utf8').catch(() => '');
    if (old === text) continue;
    if (check) { console.error(`${file} is out of date: run \`just docs\``); stale++; }
    else { await writeFile(full, text); console.log(`wrote ${file}`); }
  }
  process.exit(stale ? 1 : 0);
}
