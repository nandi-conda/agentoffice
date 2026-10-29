// Interactive objects on the map (jukebox, vending machine, 8-ball, the
// Office Rally, the coffee machine, notice board, pomodoro…): one entity per object, address `plugin:<object id>`.
// The entity owns the object's memory; the behaviour is a WASM module in
// public/plugins, run in the sandbox by the PluginHost in this.services.
// See server/plugins.js and docs/plugins.md.

import { Entity } from './runtime.js';
import { str, obj, opt } from './schema.js';
import { PLUGIN_OBJECTS, zoneAt } from '../../public/js/map.js';
import { PluginHost } from '../plugins.js';
import { ROOMS, activeBooking, isHolder } from '../../public/js/rooms.js';

const COOLDOWN_MS = 400;
// Objects that used to be core entities start from what that entity kept
// (the map object names it: `legacy: 'coffee:main'`), reshaped from its view
// into the plugin's state.
const ADOPT = {
  coffee: (v) => ({ count: v?.count || 0 }),
  noticeboard: (v) => ({ notes: Array.isArray(v) ? v : [] }),
  pomodoro: (v) => ({ ...(v?.state || {}), count: v?.count || 0 }),
};
let offline = null; // a host with no sandbox, when the runtime didn't pass one
// Who a plugin sees on a wake-up call: the office, not a person.
const SYSTEM = { id: 'system', key: 'system', name: 'the office', handle: null, did: null, kind: 'system', zone: null };

export class PluginObject extends Entity {
  static rpc = ['interact'];
  static doc = 'An interactive object on the map (jukebox, vending machine, 8-ball, the Office Rally…). Its behaviour is a WASM module the office ships in public/plugins, run in the uploads sandbox.';
  static api = {
    view: { doc: 'What everyone sees on the object and how its plugin was last reached.', returns: obj({ display: { type: ['object', 'null'], description: '{ label, glow, until } or null' }, via: { type: ['string', 'null'], description: 'the sandbox that ran it (dynamic-worker, worker-thread), offline, or null before first use' } }) },
    interact: {
      doc: 'Use the object. `action` is "use" to open it, or an action id from the panel it answered with; `input` is typed text for actions that take it. The panel goes back to the caller as an objui message; what it says goes to everyone.',
      who: true,
      params: { req: obj({ action: opt(str('Action id', 64, { pattern: '^[\\w:.-]{1,64}$' })), input: opt({ type: ['string', 'null'], maxLength: 500, description: 'Typed text' }) }, 'What to do') },
      returns: { type: ['object', 'null'], description: '{ ui, say, toast, display, give, take, watch, unlock, via }: what the plugin answered (give: items it handed you, take: things of yours it used up, watch: the zones it now follows, unlock: { room } it let you into); null when called again within 400 ms' },
      mutates: true,
      near: 3,
    },
    wake: { doc: 'Make sure the object is showing what it should: one that used to be a core entity takes over that entity\'s state and shows it. The World calls it when it starts.', returns: { type: 'boolean', description: 'whether it took over old state' }, internal: true },
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

  // One that used to be a core entity and hasn't run since: take over that
  // entity's state, and run a tick so its display (notes, cup count) goes out.
  async wake() {
    // (An office with nothing to run plugins in has nothing to show either.)
    if (!this.object?.legacy || this.state.data !== undefined || !this.services.plugins) return false;
    await this.run(SYSTEM, 'tick', null);
    return true;
  }

  async adopt() {
    const from = this.object?.legacy;
    if (!from || this.state.data !== undefined) return;
    const shape = ADOPT[from.split(':')[0]] || ((v) => v ?? null);
    let old = null;
    try { old = await this.ref(from).view(); } catch { /* starts fresh */ }
    this.state.data = shape(old);
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

  // The bookable rooms and what's on in each now, for plugins with the unlock permission.
  async rooms(who) {
    const now = this.now();
    return Promise.all(ROOMS.map(async (r) => {
      const b = activeBooking(await this.ref(`room:${r.id}`).view().catch(() => []), r.id, now);
      return { id: r.id, name: r.name, booking: b ? { title: b.title, name: b.name, until: b.end, yours: isHolder(b, who) } : null };
    }));
  }

  run(who, action, input, event = null) {
    const turn = this.queue.then(() => this.turn(who, action, input, event));
    this.queue = turn.catch(() => {});
    return turn;
  }

  async turn(who, action, input, event) {
    const f = this.object;
    await this.adopt();
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
      rooms: () => this.rooms(who),
    });
    // Into a booked room (the host already checked the unlock permission):
    // only for someone using it, not a wake-up call or a zone event.
    if (result.unlock) {
      const r = who.kind === 'system' || event ? { error: 'only someone using it can be let in' }
        : await this.ref(`room:${result.unlock.room}`).unlock(who, f.name).catch((e) => ({ error: e.message }));
      if (r.error) result = { ...result, unlock: null, toast: `${f.name}: ${r.error}` };
    }
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
    // Out of order: keep showing the data it had (the board keeps its notes).
    if (via === 'offline' && result.display && this.state.display?.data != null) result = { ...result, display: { ...result.display, data: this.state.display.data } };
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
