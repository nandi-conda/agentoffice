// The API description every entity kind (and every plugin Worker) declares.
// It is plain JSON so it crosses Durable Object and service binding RPC, and
// it is the one source for the API docs (server/apidoc.js → docs/API.md,
// /docs, /api/schema) and for the MCP tools generated from it (server/mcp.js).
//
//   static doc = 'What this kind is.'
//   static api = {
//     method: {
//       doc: 'What it does.',
//       params: { name: <JSON Schema>, ... },  positional, in this order
//       returns: <JSON Schema>,                optional
//       mutates: true,                         changes state (MCP: needs sign-in)
//       who: true,                             first argument is the caller, filled in by the World
//       ctx: true,                             last argument is { all: bookings, presence }, filled in by the World
//       inZone: true,                          the caller must stand in the zone this entity is named after
//       near: 3,                               the caller must stand within this many tiles of the
//                                              thing on the map this entity is named after
//       internal: true,                        entity-to-entity only: documented, but no MCP tool
//     },
//   }
//   static events = { publishes: { topic: doc }, subscribes: { topic: doc } }
//
// EntityHost lets through `static rpc` ∪ keys(api) plus the built-ins.

export const str = (doc, max = 200, extra = {}) => ({ type: 'string', maxLength: max, description: doc, ...extra });
export const int = (doc, minimum, maximum) => ({ type: 'integer', minimum, maximum, description: doc });
export const num = (doc, minimum, maximum) => ({ type: 'number', minimum, maximum, description: doc });
export const bool = (doc) => ({ type: 'boolean', description: doc });
export const arr = (items, doc, maxItems) => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}), description: doc });
// Properties are required unless wrapped in opt() (or `required` lists them).
export const obj = (properties, doc, required) => {
  const props = {};
  for (const [k, { optional, ...s }] of Object.entries(properties)) props[k] = s;
  required ||= Object.keys(properties).filter((k) => !properties[k].optional);
  return { type: 'object', properties: props, required, additionalProperties: false, ...(doc ? { description: doc } : {}) };
};
export const opt = (s) => ({ ...s, optional: true });

// The caller, as the World describes people to entities.
export const WHO = obj({
  id: str('Peer id in the office'), key: str('Owner key: a DID, agent:<name> or human:<id>'),
  name: str('Display name'), handle: str('AT Protocol handle'), did: str('DID'),
  kind: str('human, agent or freeq'), zone: str('Zone they stand in'),
}, 'The person calling, filled in by the World', ['id', 'key', 'name']);

export const ERROR = obj({ error: str('Why it was refused') });

// Methods every entity answers (runtime.js BUILTIN).
export const BUILTIN_API = {
  view: { doc: 'What this entity shows the office; the World mirrors it and pulls it when it starts.' },
  receive: { doc: 'A direct message: { type, data, from } → onMessage.', params: { message: obj({ type: str('Message type'), data: { description: 'Payload' }, from: str('Sender address') }) }, internal: true },
  notify: { doc: 'A pub/sub event from a topic → onEvent(topic, ev, from).', params: { topic: str('Topic name'), ev: { description: 'The event' }, from: str('Publisher address') }, internal: true },
  inspect: { doc: 'Address and raw state, for debugging. Never exposed over MCP (actor state holds OAuth sessions).', internal: true },
  seed: { doc: 'Legacy data from before entities; only taken by an entity that has nothing yet.', params: { legacy: { description: 'Whatever this kind kept in the old office state' } }, internal: true },
};

// Positional params, in order, without the ones the World fills in.
export const paramList = (spec) => Object.entries(spec.params || {});

// A method's params as one JSON Schema object, for tools and docs.
export function inputSchema(spec) {
  const properties = {}, required = [];
  for (const [k, s] of paramList(spec)) {
    const { optional, ...rest } = s;
    properties[k] = rest;
    if (!optional) required.push(k);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

// The full description of a kind: its own methods plus the built-ins.
export function describeKind(kind, Kind) {
  return {
    kind,
    doc: Kind.doc || '',
    api: { ...(Kind.api || {}), ...Object.fromEntries(Object.entries(BUILTIN_API).filter(([m]) => !(Kind.api || {})[m])) },
    events: Kind.events || {},
  };
}
