// An example plugin Worker for Agent Office: four interactive objects, each a
// named WorkerEntrypoint. The office binds to one entrypoint per object kind
// with a service binding (see the [[services]] blocks in the office's
// wrangler.toml) and calls `interact()` over RPC whenever someone uses it.
// The logic lives in objects.js, which the office also bundles as a fallback.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { jukebox, vending, eightball, kiosk } from './objects.js';

// The RPC surface every plugin object shares, described the way the office
// documents its entities (docs/API.md, MCP tools).
const API = {
  describe: { doc: 'What this object is.', params: {}, returns: { type: 'object' }, mutates: false, internal: true },
  interact: {
    doc: 'Someone used the object. Returns { state, say, ui, display, toast }; the office stores `state` and passes it back next time.',
    params: { req: { type: 'object', properties: { object: { type: 'object' }, actor: { type: 'object' }, action: { type: 'string' }, input: { type: ['string', 'null'] }, state: {}, nearby: { type: 'array' }, now: { type: 'number' } }, required: ['object', 'actor', 'action'] } },
    returns: { type: 'object' },
    mutates: true,
  },
};

class OfficeObject extends WorkerEntrypoint {
  static api = API;
  describe() { const c = this.constructor; return { name: c.title, doc: c.doc, prompt: c.prompt, api: API }; }
  interact(req) { return this.constructor.handler(req, this.env); }
}

export class Jukebox extends OfficeObject {
  static title = 'Jukebox'; static prompt = 'Pick a song'; static handler = jukebox;
  static doc = 'Pick songs from a small catalogue; they queue and play one after another, and the jukebox shows what\'s on.';
}
export class Vending extends OfficeObject {
  static title = 'Vending machine'; static prompt = 'Get a snack'; static handler = vending;
  static doc = 'Free snacks with limited stock that restocks itself half an hour after selling out.';
}
export class EightBall extends OfficeObject {
  static title = 'Magic 8-ball'; static prompt = 'Ask the 8-ball'; static handler = eightball;
  static doc = 'Ask a yes-or-no question; everyone nearby hears the answer.';
}
export class Kiosk extends OfficeObject {
  static title = 'Help kiosk'; static prompt = 'Ask the help kiosk'; static handler = kiosk;
  static doc = 'Answers questions about the office, with Workers AI when bound and a canned help desk otherwise.';
}

// Plugins have no public face; a plain request just says what's here.
export default {
  fetch() {
    return Response.json({ plugin: 'agentoffice-objects', entrypoints: ['Jukebox', 'Vending', 'EightBall', 'Kiosk'] });
  },
};
