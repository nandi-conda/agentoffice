// Entities on Cloudflare: every entity (server/entities) is its own Durable
// Object, named by its address. Calls between them are Durable Object RPC:
// stub.invoke(address, method, args). The World (OfficeRoom) answers the
// same invoke() for 'world:main'.

import { DurableObject } from 'cloudflare:workers';
import { EntityHost, makeRef, parse } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';
import { loadActor } from '../server/atproto.js';

import { BINDINGS } from '../server/entities/bindings.js';

export { BINDINGS };

export class DORuntime {
  constructor(env) {
    this.env = env;
    this.services = { loadActor: env.OFFLINE ? null : loadActor };
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
