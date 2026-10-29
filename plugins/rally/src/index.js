// The Office Rally plugin Worker. The office binds to the `Rally`
// entrypoint (PLUGIN_RALLY in its wrangler.toml) and calls interact() over
// RPC; the entrypoint hands each call to the rally's own Durable Object, one
// per object on the map (idFromName(object.id)), where the game in rally.js
// keeps its racers, rounds and all-time board one storage key each.
//
// This is the pattern for a plugin that needs more than the 32 KB `state`
// the office keeps for it, or wants its memory to itself: the stateless
// entrypoint routes, the Durable Object owns the state and runs one call at
// a time, so every move is atomic.

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Rally as Game, LEGS, GATHER_MS, RACE_MS } from './rally.js';

export class RallyRoom extends DurableObject {
  interact(req) { return new Game(this.ctx.storage).interact(req); }
}

const ACTIONS = 'Actions: `join` (the next race; the first join starts a countdown), `leave` (or give up mid-race), `start` (start now, if you\'re in), `board` (all-time best times), `use` (the panel). While racing, walking into an area sends `enter:<zone>` from the office itself.';

export class Rally extends WorkerEntrypoint {
  static title = 'Office Rally';
  static prompt = 'Join the rally';
  static doc = `A checkpoint race around the office. Join at the flag in the Lobby; ${GATHER_MS / 1000} s later the race picks ${LEGS} areas in a random order, then back to the Lobby, with a ${RACE_MS / 60000}-minute limit. The plugin asks the office to watch those zones and is told whenever a racer walks in; the first three home get medals, and best times stay on the board. Its state lives in the plugin's own Durable Object (RallyRoom). ${ACTIONS}`;
  static api = {
    describe: { doc: 'What this object is.', params: {}, returns: { type: 'object' }, mutates: false, internal: true },
    interact: {
      doc: `Someone used the flag, or (actor kind "system") the office's alarm went off, or a racer walked into a watched zone (action \`enter:<zone>\`). Returns { say, ui, display, toast, give, wakeAt, watch }: \`watch\` lists the zones the office should report, [] to stop. ${ACTIONS}`,
      params: { req: { type: 'object', properties: { object: { type: 'object' }, actor: { type: 'object' }, action: { type: 'string' }, input: { type: ['string', 'null'] }, nearby: { type: 'array' }, inventory: { type: 'array' }, event: { type: ['object', 'null'] }, now: { type: 'number' } }, required: ['object', 'actor', 'action'] } },
      returns: { type: 'object' },
      mutates: true,
    },
  };

  describe() { const c = this.constructor; return { name: c.title, doc: c.doc, prompt: c.prompt, api: c.api }; }

  interact(req) {
    const ns = this.env.RALLY;
    return ns.get(ns.idFromName(req.object.id)).interact(req);
  }
}

export default {
  fetch() { return Response.json({ plugin: 'agentoffice-rally', entrypoints: ['Rally'] }); },
};
