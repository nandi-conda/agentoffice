// The Node server's sandbox for uploaded WASM plugins (see sandbox.js): each
// call runs in a fresh worker thread that is killed when it overruns. WASM
// can only reach what runWasm imports into it, so the thread is there for the
// time limit (an endless loop can't hang the office). JS uploads need the
// Cloudflare sandbox: node:vm isn't a security boundary.

import { Worker } from 'node:worker_threads';
import { runWasm, fromBase64, logLines } from './sandbox.js';

const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const runWasm = ${runWasm.toString()};
let logs = null;
runWasm(workerData.bytes, workerData.req, (l) => { logs = l; }).then(
  (ok) => parentPort.postMessage({ ok, logs }),
  (e) => parentPort.postMessage({ error: String(e && e.message || e) }),
);
`;

export class NodeSandbox {
  constructor({ timeoutMs = 1000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.langs = ['wasm'];
    this.via = 'worker-thread';
    this.bytes = new Map(); // `${id}@${version}` -> decoded code
  }

  run(upload, req) {
    const key = `${upload.id}@${upload.version}`;
    let bytes = this.bytes.get(key);
    if (!bytes) {
      bytes = fromBase64(upload.code);
      this.bytes.set(key, bytes);
      if (this.bytes.size > 50) this.bytes.delete(this.bytes.keys().next().value);
    }
    return new Promise((resolve, reject) => {
      const w = new Worker(SOURCE, { eval: true, workerData: { bytes, req }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
      const done = (f, v) => { clearTimeout(t); w.terminate(); f(v); };
      const t = setTimeout(() => done(reject, new Error(`no answer within ${this.timeoutMs} ms`)), this.timeoutMs);
      w.once('message', (m) => { if (m.error) return done(reject, new Error(m.error)); logLines(upload, m.logs); done(resolve, m.ok); });
      w.once('error', (e) => done(reject, e));
      w.once('exit', (code) => done(reject, new Error(`the plugin stopped (exit ${code})`)));
    });
  }
}
