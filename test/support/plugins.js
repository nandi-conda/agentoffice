// The office's WASM objects for tests: the bundled modules in public/plugins,
// run in worker threads like the Node server runs them. `ai` stands in for
// Workers AI.
import { readFile } from 'node:fs/promises';
import { PluginHost } from '../../server/plugins.js';
import { NodeSandbox } from '../../server/sandbox-node.js';
import { bundledWasm } from '../../server/sandbox.js';

export const wasmFile = (f) => readFile(new URL(`../../public/plugins/${f}`, import.meta.url));

export function wasmPlugins({ ai = null, timeoutMs = 4000 } = {}) {
  return new PluginHost({ sandbox: new NodeSandbox({ timeoutMs }), wasm: bundledWasm(wasmFile), ai, timeoutMs });
}

// A sandbox that runs a JS function instead of WASM, to test the office's side.
export function fakeSandbox(fn) {
  return { langs: ['wasm'], via: 'fake', run: async (upload, req) => fn(req, upload) };
}

// Polls until check() returns something truthy: WASM calls go through a thread.
export async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out');
}

// A host whose objects all run fn(req) (state, ask and all), no WASM involved.
export function fakePlugins(fn, opts = {}) {
  return new PluginHost({ sandbox: fakeSandbox(fn), wasm: async () => ({ code: '', version: 'fake' }), ...opts });
}
