// Which Durable Object binding (wrangler.toml) hosts each entity kind, and
// the class behind each binding. Runtime-neutral, so the API docs can say
// where every entity lives without importing cloudflare:workers.
export const BINDINGS = {
  world: 'OFFICE', actor: 'ACTOR', room: 'ROOM', topic: 'TOPIC',
  desk: 'ITEM', whiteboard: 'ITEM', noticeboard: 'ITEM', arcade: 'ITEM', coffee: 'ITEM', pomodoro: 'ITEM',
  plugin: 'ITEM', gallery: 'ITEM', uobj: 'ITEM', floor: 'ITEM',
};

export const CLASSES = { OFFICE: 'OfficeRoom', ACTOR: 'ActorDO', ROOM: 'RoomDO', ITEM: 'ItemDO', TOPIC: 'TopicDO' };
