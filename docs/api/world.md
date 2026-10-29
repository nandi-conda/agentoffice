# world (the World)

The office itself (OfficeRoom): everyone's socket, movement, presence, proximity chat, sitting, emotes, A/V flags and the WebRTC relay. It hands entities requests, mirrors what they show, and carries out the effects they send back.

- address `world:main`
- Durable Object binding `OFFICE` (class `OfficeRoom`)

## `apply(effects)`

`mutates` · `internal (entity to entity)`

Carry out effects: { op: "mirror", value | push+max, except?, quiet? } (what the sender shows changed), { op: "send", to: peerId, msg }, { op: "broadcast", msg, except? }, { op: "showOut", to: peerId, room, text }, { op: "log", entries } (server logs, for operators). Entities call it through this.emit(), this.mirror() and this.log().

| Param | Type | |
| --- | --- | --- |
| `effects` | `object[]` | Effects |

## `presence()`

`read-only` · `internal (entity to entity)`

Who is in the office now.

Returns `{ id, key, name, handle?, did?, kind?, zone?, role?, x?, y? }[]`

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

## `inventoryOf(peer)`

`read-only` · `internal (entity to entity)`

What someone in the office carries (their actor's inventory, or a guest's for this visit). Plugin objects pass it to their plugin.

| Param | Type | |
| --- | --- | --- |
| `peer` | `string ≤ 200` | Peer id |

Returns `{ id, kind, name, emoji, qty, verb?, consume?, emote?, data?, from?, at? }[]`

## `invApply(peer, change)`

`mutates` · `internal (entity to entity)`

Take and give items for someone in the office, all or nothing, and tell them. Plugin objects call it with what their plugin gives and takes.

| Param | Type | |
| --- | --- | --- |
| `peer` | `string ≤ 200` | Peer id |
| `change` | `object` | { take?, give?, from? } as actor.invApply |

Returns `object`

## Events

- publishes `zone:<id>`: { type: "enter" | "exit", who } when someone walks in or out of a zone
- publishes `office`: { type: "join" | "leave", who } when someone comes in or goes
