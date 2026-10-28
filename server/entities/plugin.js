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

export class PluginObject extends Entity {
  static rpc = ['interact'];
  static doc = 'An interactive object (jukebox, vending machine, 8-ball, kiosk…) whose behaviour comes from a plugin Worker over a service binding, with a built-in fallback.';
  static api = {
    view: { doc: 'What everyone sees on the object and how its plugin was last reached.', returns: obj({ display: { type: ['object', 'null'], description: '{ label, glow, until } or null' }, via: { type: ['string', 'null'], description: 'binding, builtin, offline, or null before first use' } }) },
    interact: {
      doc: 'Use the object. `action` is "use" to open it, or an action id from the panel it answered with; `input` is typed text for actions that take it. The panel goes back to the caller as an objui message; what it says goes to everyone.',
      who: true,
      params: { req: obj({ action: opt(str('Action id', 64, { pattern: '^[\\w:.-]{1,64}$' })), input: opt({ type: ['string', 'null'], maxLength: 500, description: 'Typed text' }) }, 'What to do') },
      returns: { type: ['object', 'null'], description: '{ ui, say, toast, display, via }: what the plugin answered; null when called again within 400 ms' },
      mutates: true,
    },
  };

  constructor(host) {
    super(host);
    this.lastUse = new Map(); // actor id -> time, against button mashing
  }

  get object() { return PLUGIN_OBJECTS.find((f) => f.id === this.name); }
  get plugins() { return this.services.plugins || (builtins ||= new PluginHost()); }

  // What everyone sees (a label, a glow), and how the plugin was last reached.
  view() { return { display: this.state.display || null, via: this.state.via || null }; }

  // who: the World's view of the person ({ id, key, name, handle, did, kind, zone }).
  async interact(who, { action = 'use', input = null } = {}) {
    const f = this.object;
    if (!f) throw new Error(`no object ${this.name}`);
    const now = this.now();
    if (now - (this.lastUse.get(who.id) || 0) < COOLDOWN_MS) return null;
    this.lastUse.set(who.id, now);

    const spot = { x: f.x + f.w / 2, y: f.y + f.h + 0.5 };
    const zone = zoneAt(spot.x, spot.y)?.id || null;
    let nearby = [];
    try {
      nearby = (await this.world.presence()).filter((q) => q.zone === zone).map((q) => ({ id: q.id, name: q.name, handle: q.handle || null }));
    } catch { /* the plugin just won't know who's around */ }

    const { result, state, via } = await this.plugins.interact({
      object: { id: f.id, plugin: f.plugin, name: f.name, zone },
      actor: who, action, input, state: this.state.data ?? null, nearby,
    });
    this.state.data = state;
    const reached = via !== this.state.via;
    this.state.via = via;
    const effects = [{ op: 'send', to: who.id, msg: { t: 'objui', id: f.id, ui: result.ui, toast: result.toast, via } }];
    if (result.say) effects.push({ op: 'broadcast', msg: { t: 'obj', id: f.id, say: result.say, x: spot.x, y: spot.y } });
    const display = result.display && JSON.stringify(result.display) !== JSON.stringify(this.state.display ?? null) ? result.display : null;
    if (display) this.state.display = display;
    await this.save();
    await this.emit(...effects);
    if (display || reached) await this.mirror(this.view());
    return { ...result, via };
  }
}
