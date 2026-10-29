// Entities: every stateful thing in the office is an Entity with its own
// storage, alarm and inbox: each actor (a signed-in person or an agent),
// each bookable room, each desk, each pomodoro timer, the whiteboard, the
// notice board, the arcade, the coffee machine, and the pub/sub topics they
// talk over. On Cloudflare each one is its own Durable Object
// (worker/entities.js); on Node they all live in this process
// (LocalRuntime). Either way they share one messaging layer:
//
//   direct RPC   this.ref('room:board').book(...)       (methods in `static api`, see schema.js)
//   messages     this.tell('actor:did:plc:x', 'note', d) → onMessage({ type, data, from })
//   pub/sub      this.subscribe('zone:board')            → onEvent(topic, ev, from)
//                this.publish('desks', ev)
//
// The World (the office Durable Object that holds the sockets, server/office.js)
// is the address 'world:main'. Entities reach the people in the office by
// handing it effects with this.emit(...): see Office.apply().
//
// Addresses are 'kind:name'; the name may itself contain colons (DIDs).
// Everything crossing between entities is structured-cloned, here as on
// Workers, so code that works on Node can't lean on shared objects.

import { log } from '../logs.js';

export const parse = (address) => {
  const i = String(address).indexOf(':');
  if (i < 1) throw new Error(`bad entity address ${address}`);
  return { kind: address.slice(0, i), name: address.slice(i + 1) };
};

// Methods every entity answers, besides its own `static rpc` list.
const BUILTIN = ['receive', 'notify', 'view', 'inspect', 'seed'];

// A stub for an address: any property is an async method that goes through
// `invoke(method, args)`. Not thenable, so it can be returned from async code.
export function makeRef(address, invoke) {
  return new Proxy({}, {
    get(_, m) {
      if (m === 'then' || typeof m === 'symbol') return undefined;
      if (m === 'address') return address;
      return (...args) => invoke(m, args);
    },
  });
}

export class Entity {
  static rpc = []; // extra methods without a description; prefer `static api`
  static api = {};

  // host: { address, kind, name, storage, now, setAlarm, ref, services }
  constructor(host) {
    this.host = host;
    this.state = {};
  }

  get address() { return this.host.address; }
  get name() { return this.host.name; }
  get services() { return this.host.services || {}; }
  now() { return this.host.now(); }
  ref(address) { return this.host.ref(address); }
  get world() { return this.host.ref('world:main'); }

  async save() { await this.host.storage.put('state', this.state); }
  setAlarm(t) { return this.host.setAlarm(t); }

  // ---- talking to the World and to each other ---------------------------
  emit(...effects) { return this.world.apply(effects.map((e) => ({ from: this.address, ...e }))); }
  // What this entity shows the office; the World keeps a copy (see view()).
  mirror(value, extra = {}) { return this.emit({ op: 'mirror', value, ...extra }); }
  // A server log line, tagged with this entity's address (server/logs.js).
  log(level, msg, data) { log(level, this.address, msg, data); }
  tell(to, type, data) { return this.ref(to).receive({ type, data, from: this.address }); }
  publish(topic, ev) { return this.ref(`topic:${topic}`).publish(ev, this.address); }
  async subscribe(topic) {
    await this.ref(`topic:${topic}`).subscribe(this.address);
    const subs = new Set(this.state.subs || []);
    subs.add(topic);
    this.state.subs = [...subs];
  }
  async unsubscribe(topic) {
    await this.ref(`topic:${topic}`).unsubscribe(this.address);
    this.state.subs = (this.state.subs || []).filter((t) => t !== topic);
  }

  // ---- built-in RPC -------------------------------------------------------
  receive(m) { return this.onMessage(m); }
  notify(topic, ev, from) { return this.onEvent(topic, ev, from); }
  inspect() { return { address: this.address, state: this.state }; }
  // Legacy data from before entities (the old single office state); only
  // taken by an entity that has nothing yet.
  seed() {}

  // ---- hooks --------------------------------------------------------------
  async setup() {} // once, the first time the entity exists
  view() { return null } // what the World mirrors (pulled when the World starts)
  async onMessage() {}
  async onEvent() {}
  async alarm() {}
}

// Runs one entity: loads its state before the first call, sets it up once,
// and only lets allow-listed methods through.
export class EntityHost {
  constructor(Kind, host) {
    this.Kind = Kind;
    this.entity = new Kind(host);
    this.address = host.address;
    this.storage = host.storage;
    this.loading = null;
  }

  load() {
    return (this.loading ||= (async () => {
      const e = this.entity;
      e.state = (await this.storage.get('state')) || {};
      if (!e.state.setupDone) {
        await e.setup();
        e.state.setupDone = true;
        await e.save();
      }
    })());
  }

  async invoke(method, args = []) {
    if (!BUILTIN.includes(method) && !(this.Kind.rpc || []).includes(method) && !Object.hasOwn(this.Kind.api || {}, method)) {
      throw new Error(`${this.address} has no method ${method}`);
    }
    await this.load();
    try {
      return await this.entity[method](...args);
    } catch (e) {
      // Most are refusals ("not your booking"), so notice, not error.
      log('notice', this.address, `${method} failed: ${e?.message || e}`);
      throw e;
    }
  }

  async alarm() {
    await this.load();
    try {
      return await this.entity.alarm();
    } catch (e) {
      log('error', this.address, `alarm failed: ${e?.message || e}`);
      throw e;
    }
  }
}

// In-memory entity storage with the Durable Object storage shape.
export class MemoryStorage {
  constructor(data = {}, onWrite = () => {}) { this.data = data; this.onWrite = onWrite; }
  async get(k) { return this.data[k] === undefined ? undefined : structuredClone(this.data[k]); }
  async put(k, v) { this.data[k] = structuredClone(v); this.onWrite(); }
  async delete(k) { const had = k in this.data; delete this.data[k]; this.onWrite(); return had; }
  async list({ prefix = '' } = {}) {
    return new Map(Object.keys(this.data).filter((k) => k.startsWith(prefix)).sort().map((k) => [k, structuredClone(this.data[k])]));
  }
}

// Every entity in this process (Node, and the tests). `data` is
// { address: { key: value } }; onWrite fires after any change, so the Node
// server can save it to disk.
export class LocalRuntime {
  constructor({ kinds, now = () => Date.now(), services = {}, data = {}, onWrite = () => {} }) {
    Object.assign(this, { kinds, now, services, data, onWrite });
    this.hosts = new Map();
    this.timers = new Map();
    this.world = null;
  }

  // The World isn't an Entity (it owns the sockets); it registers the
  // methods entities may call on it.
  setWorld(api) { this.world = api; }

  host(address) {
    let h = this.hosts.get(address);
    if (h) return h;
    const { kind, name } = parse(address);
    const Kind = this.kinds[kind];
    if (!Kind) throw new Error(`no entity kind ${kind}`);
    const storage = new MemoryStorage((this.data[address] ||= {}), this.onWrite);
    h = new EntityHost(Kind, {
      address, kind, name, storage, services: this.services,
      now: () => this.now(),
      ref: (a) => this.ref(a),
      setAlarm: (t) => this.setAlarm(address, t),
    });
    this.hosts.set(address, h);
    return h;
  }

  ref(address) {
    return makeRef(address, async (method, args) => {
      args = structuredClone(args);
      if (address === 'world:main') {
        if (!this.world?.[method]) throw new Error(`the world has no method ${method}`);
        return structuredClone(await this.world[method](...args));
      }
      return structuredClone(await this.host(address).invoke(method, args));
    });
  }

  // Like a Durable Object alarm: one per entity, null clears it.
  setAlarm(address, t) {
    clearTimeout(this.timers.get(address));
    this.timers.delete(address);
    if (t == null) return;
    const timer = setTimeout(() => {
      this.timers.delete(address);
      this.host(address).alarm().catch(() => {}); // logged by the host
    }, Math.max(0, Math.min(t - this.now(), 2 ** 31 - 1)));
    timer.unref?.();
    this.timers.set(address, timer);
  }

  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
