# topic (Topic)

A pub/sub channel. Keeps its subscribers and fans events out to them; the World mirrors the subscriber count so it only publishes to topics somebody listens to.

- address `topic:<name>`
- Durable Object binding `TOPIC` (class `TopicDO`)
- 13: `zone:focus`, `zone:booths`, `zone:booth1`, `zone:booth2`, `zone:booth3`, `zone:lobby`, `zone:open`, `zone:board`, `zone:huddle`, `zone:kitchen`, `zone:lounge`, `office`, `desks`

## `view()`

`read-only` · MCP tool **`topic_view`**

How many subscribe.

Returns `integer ≥ 0`

## `subscribers()`

`read-only` · MCP tool **`topic_subscribers`**

Addresses subscribed to this topic.

Returns `string ≤ 200[]`

## `subscribe(address)`

`mutates` · `internal (entity to entity)`

Add an entity to the topic.

| Param | Type | |
| --- | --- | --- |
| `address` | `string ≤ 200` | Subscriber address |

Returns `integer ≥ 0`

## `unsubscribe(address)`

`mutates` · `internal (entity to entity)`

Remove an entity from the topic.

| Param | Type | |
| --- | --- | --- |
| `address` | `string ≤ 200` | Subscriber address |

## `publish(ev, from)`

`read-only` · `internal (entity to entity)`

Send an event to every subscriber but the publisher (their notify()).

| Param | Type | |
| --- | --- | --- |
| `ev` | `object` | The event, usually { type, ... } |
| `from` | `string ≤ 200` | Publisher address |

Returns `integer ≥ 0`
