// Entities on Cloudflare: every entity (server/entities) is its own Durable
// Object, named by its address. Calls between them are Durable Object RPC:
// stub.invoke(address, method, args). The World (OfficeRoom) answers the
// same invoke() for 'world:main'.

import { DurableObject } from 'cloudflare:workers';
import { EntityHost, makeRef, parse } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';
import { loadActor } from '../server/atproto.js';
import { PluginHost } from '../server/plugins.js';
import { DynamicSandbox, bundledWasm } from '../server/sandbox.js';
import { captureConsole, setLogSink, forwarder } from '../server/logs.js';
import { bootstrap as bootstrapRoles } from '../public/js/roles.js';

import { BINDINGS } from '../server/entities/bindings.js';

export { BINDINGS };

export class DORuntime {
  constructor(env) {
    this.env = env;
    // plugins: interactive objects call their plugin Worker through the
    // PLUGIN_<NAME> service bindings in env (see server/plugins.js).
    // Uploaded objects run in Dynamic Workers when the office has a Worker
    // Loader binding (LOADER, Workers Paid); without one uploads are refused.
    this.services = {
      loadActor: env.OFFLINE ? null : loadActor,
      plugins: new PluginHost({ env, sandbox: env.LOADER ? new DynamicSandbox(env.LOADER) : null }),
      // The office's own WASM objects (the rally flag), from the static assets.
      wasm: env.ASSETS ? bundledWasm(async (file) => {
        const r = await env.ASSETS.fetch(`https://assets.local/plugins/${file}`);
        if (!r.ok) throw new Error(`${r.status}`);
        return r.arrayBuffer();
      }) : null,
      // Owners and admins to start with (OWNER_DIDS, ADMIN_DIDS): public/js/roles.js.
      roles: bootstrapRoles(env),
    };
  }

  stub(address) {
    const ns = this.env[BINDINGS[parse(address).kind]];
    if (!ns) throw new Error(`no Durable Object binding for ${address}`);
    return ns.get(ns.idFromName(address === 'world:main' ? 'main' : address));
  }

  ref(address) {
    return makeRef(address, (method, args) => this.stub(address).invoke(address, method, args));
  }
}

// One entity per object. It learns its address from the first call and
// keeps it, so an alarm can wake it up without one.
class EntityDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runtime = new DORuntime(env);
    this.entity = null;
    // Logs from this object go to the World's buffer (unless the World
    // shares this isolate, in which case its buffer takes them directly).
    captureConsole();
    setLogSink({ forward: forwarder((entries) => this.runtime.ref('world:main').apply([{ op: 'log', entries }])) });
  }

  async hostFor(address) {
    if (this.entity) {
      if (address && address !== this.entity.address) throw new Error(`this object is ${this.entity.address}, not ${address}`);
      return this.entity;
    }
    if (!address) address = await this.ctx.storage.get('__address');
    if (!address) return null;
    const { kind, name } = parse(address);
    const Kind = KINDS[kind];
    if (!Kind || BINDINGS[kind] !== this.constructor.binding) throw new Error(`${this.constructor.name} doesn't host ${kind}`);
    const storage = this.ctx.storage;
    if (!(await storage.get('__address'))) await storage.put('__address', address);
    this.entity = new EntityHost(Kind, {
      address, kind, name, storage, services: this.runtime.services,
      now: () => Date.now(),
      ref: (a) => this.runtime.ref(a),
      setAlarm: (t) => (t == null ? storage.deleteAlarm() : storage.setAlarm(t)),
    });
    return this.entity;
  }

  async invoke(address, method, args = []) {
    return (await this.hostFor(address)).invoke(method, args);
  }

  async alarm() {
    const host = await this.hostFor(null);
    if (host) await host.alarm();
  }
}

export class ActorDO extends EntityDO { static binding = 'ACTOR'; }
export class RoomDO extends EntityDO { static binding = 'ROOM'; }
export class ItemDO extends EntityDO { static binding = 'ITEM'; }
export class TopicDO extends EntityDO { static binding = 'TOPIC'; }
