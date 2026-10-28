# world (the World)

The office itself (OfficeRoom): everyone's socket, movement, presence, proximity chat, sitting, emotes, A/V flags and the WebRTC relay. It hands entities requests, mirrors what they show, and carries out the effects they send back.

- address `world:main`
- Durable Object binding `OFFICE` (class `OfficeRoom`)

## `apply(effects)`

`mutates` · `internal (entity to entity)`

Carry out effects: { op: "mirror", value | push+max, except?, quiet? } (what the sender shows changed), { op: "send", to: peerId, msg }, { op: "broadcast", msg, except? }, { op: "showOut", to: peerId, room, text }. Entities call it through this.emit() and this.mirror().

| Param | Type | |
| --- | --- | --- |
| `effects` | `object[]` | Effects |

## `presence()`

`read-only` · `internal (entity to entity)`

Who is in the office now.

Returns `{ id, key, name, handle?, did?, kind?, zone? }[]`

## `deliver(key, msg)`

`read-only` · `internal (entity to entity)`

A protocol message for an actor, to each of their open connections. Returns how many got it.

| Param | Type | |
| --- | --- | --- |
| `key` | `string ≤ 200` | Owner key |
| `msg` | `object` | Protocol message { t, ... } |

Returns `integer ≥ 0`

## `summary()`

`read-only` · `internal (entity to entity)`

The public office summary (/api/office).

Returns `{ online, desks, counters }`

## Events

- publishes `zone:<id>`: { type: "enter" | "exit", who } when someone walks in or out of a zone
- publishes `office`: { type: "join" | "leave", who } when someone comes in or goes
