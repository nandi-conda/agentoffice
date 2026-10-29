// Interactive objects on the map (jukebox, vending machine, 8-ball, kiosk,
// the Office Rally…): one entity per object, address `plugin:<object id>`.
// The entity owns the object's memory; the behaviour is a WASM module in
// public/plugins, run in the sandbox by the PluginHost in this.services.
// See server/plugins.js and docs/plugins.md.

import { Entity } from './runtime.js';
import { str, obj, opt } from './schema.js';
import { PLUGIN_OBJECTS, zoneAt } from '../../public/js/map.js';
import { PluginHost } from '../plugins.js';

const COOLDOWN_MS = 400;
let offline = null; // a host with no sandbox, when the runtime didn't pass one
// Who a plugin sees on a wake-up call: the office, not a person.
const SYSTEM = { id: 'system', key: 'system', name: 'the office', handle: null, did: null, kind: 'system', zone: null };

export class PluginObject extends Entity {
  static rpc = ['interact'];
  static doc = 'An interactive object on the map (jukebox, vending machine, 8-ball, kiosk, the Office Rally…). Its behaviour is a WASM module the office ships in public/plugins, run in the uploads sandbox.';
  static api = {
    view: { doc: 'What everyone sees on the object and how its plugin was last reached.', returns: obj({ display: { type: ['object', 'null'], description: '{ label, glow, until } or null' }, via: { type: ['string', 'null'], description: 'the sandbox that ran it (dynamic-worker, worker-thread), offline, or null before first use' } }) },
    interact: {
      doc: 'Use the object. `action` is "use" to open it, or an action id from the panel it answered with; `input` is typed text for actions that take it. The panel goes back to the caller as an objui message; what it says goes to everyone.',
      who: true,
      params: { req: obj({ action: opt(str('Action id', 64, { pattern: '^[\\w:.-]{1,64}$' })), input: opt({ type: ['string', 'null'], maxLength: 500, description: 'Typed text' }) }, 'What to do') },
      returns: { type: ['object', 'null'], description: '{ ui, say, toast, display, give, take, watch, via }: what the plugin answered (give: items it handed you, take: things of yours it used up, watch: the zones it now follows); null when called again within 400 ms' },
      mutates: true,
      near: 3,
    },
  };

  static events = { subscribes: { 'zone:<id>': 'enter / exit, for the zones its plugin asked to watch (answer `watch`): calls the plugin with action `enter:<zone>` / `exit:<zone>` as that person' } };

  constructor(host) {
    super(host);
    this.lastUse = new Map(); // actor id -> time, against button mashing
    // One plugin call at a time: a Durable Object lets other calls in while
    // this one waits on the plugin, and two turns at once would each start
    // from the same state and the second would undo the first.
    this.queue = Promise.resolve();
  }

  get object() { return PLUGIN_OBJECTS.find((f) => f.id === this.name); }
  get plugins() { return this.services.plugins || (offline ||= new PluginHost()); }

  // The object as the PluginHost gets it: `wasm` names its module in
  // public/plugins (uploads override this with their own code).
  async pluginObject(f, zone) {
    return { id: f.id, plugin: f.plugin, name: f.name, zone, wasm: f.wasm };
  }

  // What everyone sees (a label, a glow), and how the plugin was last reached.
  view() { return { display: this.state.display || null, via: this.state.via || null }; }

  // who: the World's view of the person ({ id, key, name, handle, did, kind, zone }).
  async interact(who, { action = 'use', input = null } = {}) {
    if (!this.object) throw new Error(`no object ${this.name}`);
    const now = this.now();
    if (now - (this.lastUse.get(who.id) || 0) < COOLDOWN_MS) return null;
    this.lastUse.set(who.id, now);
    return this.run(who, action, input);
  }

  // The plugin asked to be woken (result.wakeAt): call it with action 'tick'
  // as the office itself, e.g. so a jukebox moves on to the next song.
  async alarm() {
    if (!this.object) return;
    this.state.wakeAt = null;
    await this.run(SYSTEM, 'tick', null);
  }

  // Someone walked into or out of a zone the plugin asked to watch: call it
  // as that person with action `enter:<zone>` / `exit:<zone>`. It can answer
  // with a toast for them, say something, change its display, or hand them
  // things, but no panel opens.
  async onEvent(topic, ev) {
    const zone = topic.startsWith('zone:') ? topic.slice(5) : null;
    if (!this.object || !zone || !(this.state.watch || []).includes(zone)) return;
    if (!['enter', 'exit'].includes(ev?.type) || !ev.who?.id || ev.who.kind === 'freeq') return;
    await this.run(ev.who, `${ev.type}:${zone}`, null, { type: ev.type, zone });
  }

  // The zones it hears about: subscribe to the new ones, drop the rest.
  async watch(zones) {
    const was = this.state.watch || [];
    for (const z of zones.filter((z) => !was.includes(z))) await this.subscribe(`zone:${z}`);
    for (const z of was.filter((z) => !zones.includes(z))) await this.unsubscribe(`zone:${z}`);
    this.state.watch = zones;
  }

  run(who, action, input, event = null) {
    const turn = this.queue.then(() => this.turn(who, action, input, event));
    this.queue = turn.catch(() => {});
    return turn;
  }

  async turn(who, action, input, event) {
    const f = this.object;
    const spot = { x: f.x + f.w / 2, y: f.y + f.h + 0.5 };
    const zone = zoneAt(spot.x, spot.y)?.id || null;
    let nearby = [];
    try {
      nearby = (await this.world.presence()).filter((q) => q.zone === zone).map((q) => ({ id: q.id, name: q.name, handle: q.handle || null }));
    } catch { /* the plugin just won't know who's around */ }

    // What they carry goes to the plugin, which can hand things out or use them up.
    let inventory = [];
    try { if (who.kind !== 'system') inventory = await this.world.inventoryOf(who.id); } catch { /* it just won't see their things */ }

    let { result, state, via } = await this.plugins.interact({
      object: await this.pluginObject(f, zone),
      actor: who, action, input, state: this.state.data ?? null, nearby, now: this.now(), inventory, event,
    });
    // Objects people uploaded can hand things out but never take anyone's things.
    if (f.plugin === 'upload' && result.take?.length) result = { ...result, take: [] };
    if ((result.give?.length || result.take?.length) && who.kind !== 'system') {
      const r = await this.world.invApply(who.id, { give: result.give, take: result.take, from: f.name }).catch((e) => ({ error: e.message }));
      // It didn't go through (hands full, or they don't have what it wanted):
      // nothing happened, so the object forgets this turn too.
      if (r.error) { state = this.state.data ?? null; result = { ...result, say: null, display: null, wakeAt: null, watch: null, toast: `${f.name}: ${r.error}` }; }
    }
    this.state.data = state;
    const reached = via !== this.state.via;
    this.state.via = via;
    const effects = [];
    // A zone event only toasts (no `ui` key: the client leaves any open panel be).
    if (event) { if (result.toast) effects.push({ op: 'send', to: who.id, msg: { t: 'objui', id: f.id, toast: result.toast, via } }); }
    else if (who !== SYSTEM) effects.push({ op: 'send', to: who.id, msg: { t: 'objui', id: f.id, ui: result.ui, toast: result.toast, via } });
    if (result.say) effects.push({ op: 'broadcast', msg: { t: 'obj', id: f.id, say: result.say, x: spot.x, y: spot.y } });
    const display = result.display && JSON.stringify(result.display) !== JSON.stringify(this.state.display ?? null) ? result.display : null;
    if (display) this.state.display = display;
    if (result.wakeAt && result.wakeAt !== this.state.wakeAt) {
      this.state.wakeAt = result.wakeAt;
      await this.setAlarm(Math.max(result.wakeAt, this.now() + 1000));
    }
    if (result.watch) await this.watch(result.watch);
    await this.save();
    if (effects.length) await this.emit(...effects);
    if (display || reached) await this.mirror(this.view());
    return { ...result, via };
  }
}
