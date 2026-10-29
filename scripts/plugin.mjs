// WASM plugins made with the agentoffice-plugin crate (crates/, docs/uploads.md).
//
//   node scripts/plugin.mjs new <name>      start plugins/wasm-<name> from a template
//   node scripts/plugin.mjs check [name…]   check built plugins the way the office does on
//                                           upload, then open each once in the Node sandbox
//
// The justfile wraps these: `just plugin-new`, `just plugin-build`.

import { mkdir, readFile, readdir, writeFile, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkUpload, toBase64 } from '../server/sandbox.js';
import { NodeSandbox } from '../server/sandbox-node.js';
import { sanitize } from '../server/plugins.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = (p) => access(p).then(() => true, () => false);
const TARGET = path.join(root, 'target/wasm32-unknown-unknown/release');

// Every plugins/wasm-* crate: { dir, pkg, wasm }.
async function plugins() {
  const out = [];
  for (const dir of (await readdir(path.join(root, 'plugins'))).filter((d) => d.startsWith('wasm-')).sort()) {
    const toml = await readFile(path.join(root, 'plugins', dir, 'Cargo.toml'), 'utf8').catch(() => null);
    const pkg = toml?.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (pkg) out.push({ dir: `plugins/${dir}`, pkg, wasm: path.join(TARGET, `${pkg.replace(/-/g, '_')}.wasm`) });
  }
  return out;
}

async function check(names) {
  const all = await plugins();
  const picked = names.length ? names.map((n) => all.find((p) => p.pkg === n || p.dir === `plugins/wasm-${n}`) || { pkg: n, missing: true }) : all;
  let failed = 0;
  for (const p of picked) {
    if (p.missing) { console.error(`✗ ${p.pkg}: no plugins/wasm-${p.pkg} (just plugin-new ${p.pkg})`); failed++; continue; }
    const rel = path.relative(root, p.wasm);
    let bytes;
    try { bytes = new Uint8Array(await readFile(p.wasm)); } catch { console.error(`✗ ${p.pkg}: ${rel} isn't built (just plugin-build ${p.pkg})`); failed++; continue; }
    try {
      const info = checkUpload('wasm', bytes);
      const m = info.manifest;
      console.log(`✓ ${p.pkg}: ${rel}, ${(info.size / 1024).toFixed(1)} KB of ${512} KB`);
      if (m) {
        console.log(`  ${m.emoji || '🧩'} ${m.name}${m.prompt ? ` · "${m.prompt}"` : ''}${m.look ? ` · looks like ${m.look}` : ''}${m.glow ? ` · ${m.glow}` : ''}`);
        if (m.doc) console.log(`  ${m.doc}`);
        for (const [a, spec] of Object.entries(m.api)) console.log(`  action ${a}${spec.params?.input ? ' (+ input)' : ''}: ${spec.doc}`);
      } else console.log('  no manifest (use #[plugin] to embed one): the upload form starts blank');
      // Someone walks up: the same sandbox `just start` runs uploads in.
      const req = { object: { id: 'u-check', kind: 'upload', name: m?.name || p.pkg, zone: 'lobby' }, actor: { id: 'ada', did: null, handle: null, name: 'Ada', kind: 'human' }, action: 'use', input: null, state: null, nearby: [], now: Date.now(), inventory: [] };
      const r = sanitize(await new NodeSandbox({ timeoutMs: 2000 }).run({ id: 'u-check', version: 'check', lang: 'wasm', code: toBase64(bytes) }, req));
      console.log(`  on "use": ${r.ui ? `panel "${r.ui.title}"` : 'no panel'}${r.say ? `, says "${r.say}"` : ''}${r.display?.label ? `, shows "${r.display.label}"` : ''}`);
      // Keep the copy the web UI's "try the example" uploads in step.
      const pub = path.join(root, 'public/plugins', path.basename(p.wasm));
      if (await exists(pub)) { await copyFile(p.wasm, pub); console.log(`  copied to ${path.relative(root, pub)}`); }
    } catch (e) {
      console.error(`✗ ${p.pkg}: ${e.message}`);
      failed++;
    }
  }
  if (!picked.length) console.log('no plugins yet: just plugin-new <name>');
  else if (!failed) console.log('\nUpload a .wasm from the 🧩 panel in the office (U), or with the gallery_upload MCP tool.');
  process.exitCode = failed ? 1 : 0;
}

const title = (n) => n.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function template(name) {
  const fn = name.replace(/-/g, '_');
  const kind = name.replace(/_/g, '-');
  return {
    'Cargo.toml': `[package]
name = "${name}"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
agentoffice-plugin = { path = "../../crates/agentoffice-plugin" }
serde = { version = "1", features = ["derive"] }
`,
    'src/lib.rs': `//! ${title(name)}: an Agent Office object. \`just plugin-test ${name}\` runs the
//! tests below, \`just plugin-build ${name}\` builds the .wasm to upload.
//! The crate's docs: crates/agentoffice-plugin, docs/uploads.md.

use agentoffice_plugin::prelude::*;

/// What the object remembers between uses (≤ 32 KB as JSON).
#[derive(Serialize, Deserialize, Default)]
struct State {
    presses: u32,
}

/// A button that counts presses and hands out a sticker every 10th one.
#[plugin(
    name = "${title(name)}",
    prompt = "Press the button",
    emoji = "🔘",
    glow = "#a78bfa",
    look = "plinth",
    action("press", "Press the button"),
)]
fn ${fn}(mut req: Request<State>) -> Response<State> {
    let mut res = Response::new();
    if req.is("press") {
        req.state.presses += 1;
        res = res.say(format!("🔘 {} pressed the button", req.actor.name));
        if req.state.presses % 10 == 0 {
            res = res.give(Give::new("${kind}:sticker").name("Button sticker").emoji("🔘"));
        }
    }
    let n = req.state.presses;
    res.display(Display::label(format!("{n} presses")))
        .ui(Ui::new("🔘 ${title(name)}")
            .text(format!("Pressed **{n}** times. Every 10th press gets a sticker."))
            .primary("Press", "press"))
        .state(req.state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn counts_presses_and_hands_out_stickers() {
        let mut office = TestOffice::new(${fn}).with_manifest(MANIFEST);
        assert_eq!(office.use_as("Ada").ui.unwrap().buttons[0].action, "press");
        for _ in 0..10 {
            office.act("Ada", "press");
        }
        assert_eq!(office.state().presses, 10);
        assert_eq!(office.inventory("Ada")[0].kind, "${kind}:sticker");
        office.assert_clean();
    }
}
`,
  };
}

async function create(name) {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(name || '')) throw new Error('name it in lower case, like dice or tip-jar');
  const dir = path.join(root, 'plugins', `wasm-${name}`);
  if (await exists(dir)) throw new Error(`plugins/wasm-${name} already exists`);
  for (const [f, text] of Object.entries(template(name))) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await writeFile(path.join(dir, f), text);
  }
  console.log(`Made plugins/wasm-${name}. Next:
  just plugin-test ${name}     run its tests
  just plugin-build ${name}    build target/wasm32-unknown-unknown/release/${name.replace(/-/g, '_')}.wasm to upload`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'new') await create(args[0]);
  else if (cmd === 'check') await check(args.filter(Boolean));
  else { console.error('usage: node scripts/plugin.mjs new <name> | check [name…]'); process.exitCode = 2; }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
