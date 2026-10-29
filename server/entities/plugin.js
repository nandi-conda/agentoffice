// Interactive objects run by plugin Workers (jukebox, vending machine,
// 8-ball, kiosk…): one entity per object on the map, address
// `plugin:<object id>`. The entity owns the object's memory; the behaviour
// comes from the plugin, reached through the PluginHost in this.services
// (a service binding on Cloudflare, the built-in copy otherwise). See
// server/plugins.js and docs/plugins.md.

import { Entity } from './runtime.js';
import { str, obj, opt } from './schema.js';
import { PLUGIN_OBJECTS, zoneAt } from '../../public/js/map.js';
import { PluginHost } from '../plugins.js';

const COOLDOWN_MS = 400;
let builtins = null; // a host with no bindings, when the runtime didn't pass one
// Who a plugin sees on a wake-up call: the office, not a person.
const SYSTEM = { id: 'system', key: 'system', name: 'the office', handle: null, did: null, kind: 'system', zone: null };

export class PluginObject extends Entity {
  static rpc = ['interact'];
  static doc = 'An interactive object (jukebox, vending machine, 8-ball, kiosk…) whose behaviour comes from a plugin Worker over a service binding, with a built-in fallback.';
  static api = {
    view: { doc: 'What everyone sees on the object and how its plugin was last reached.', returns: obj({ display: { type: ['object', 'null'], description: '{ label, glow, until } or null' }, via: { type: ['string', 'null'], description: 'binding, builtin, offline, or null before first use' } }) },
    interact: {
      doc: 'Use the object. `action` is "use" to open it, or an action id from the panel it answered with; `input` is typed text for actions that take it. The panel goes back to the caller as an objui message; what it says goes to everyone.',
      who: true,
      params: { req: obj({ action: opt(str('Action id', 64, { pattern: '^[\\w:.-]{1,64}$' })), input: opt({ type: ['string', 'null'], maxLength: 500, description: 'Typed text' }) }, 'What to do') },
      returns: { type: ['object', 'null'], description: '{ ui, say, toast, display, give, take, via }: what the plugin answered (give: items it handed you, take: things of yours it used up); null when called again within 400 ms' },
      mutates: true,
      near: 3,
    },
  };

  constructor(host) {
    super(host);
    this.lastUse = new Map(); // actor id -> time, against button mashing
  }

  get object() { return PLUGIN_OBJECTS.find((f) => f.id === this.name); }
  get plugins() { return this.services.plugins || (builtins ||= new PluginHost()); }

  // The object as the PluginHost gets it (uploads add their code).
  async pluginObject(f, zone) { return { id: f.id, plugin: f.plugin, name: f.name, zone }; }

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

  async run(who, action, input) {
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
      actor: who, action, input, state: this.state.data ?? null, nearby, now: this.now(), inventory,
    });
    // Objects people uploaded can hand things out but never take anyone's things.
    if (f.plugin === 'upload' && result.take?.length) result = { ...result, take: [] };
    if ((result.give?.length || result.take?.length) && who.kind !== 'system') {
      const r = await this.world.invApply(who.id, { give: result.give, take: result.take, from: f.name }).catch((e) => ({ error: e.message }));
      // It didn't go through (hands full, or they don't have what it wanted):
      // nothing happened, so the object forgets this turn too.
      if (r.error) { state = this.state.data ?? null; result = { ...result, say: null, display: null, wakeAt: null, toast: `${f.name}: ${r.error}` }; }
    }
    this.state.data = state;
    const reached = via !== this.state.via;
    this.state.via = via;
    const effects = [];
    if (who !== SYSTEM) effects.push({ op: 'send', to: who.id, msg: { t: 'objui', id: f.id, ui: result.ui, toast: result.toast, via } });
    if (result.say) effects.push({ op: 'broadcast', msg: { t: 'obj', id: f.id, say: result.say, x: spot.x, y: spot.y } });
    const display = result.display && JSON.stringify(result.display) !== JSON.stringify(this.state.display ?? null) ? result.display : null;
    if (display) this.state.display = display;
    if (result.wakeAt && result.wakeAt !== this.state.wakeAt) {
      this.state.wakeAt = result.wakeAt;
      await this.setAlarm(Math.max(result.wakeAt, this.now() + 1000));
    }
    await this.save();
    if (effects.length) await this.emit(...effects);
    if (display || reached) await this.mirror(this.view());
    return { ...result, via };
  }
}
