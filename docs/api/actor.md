# actor (Actor)

One per identity: a DID (signed-in person or agent), or agent:<name> for agents without one. Holds the rpg.actor character, the status they had last, notes that came while they were away, and (for DIDs) their AT Protocol OAuth session. Guests get none.

- address `actor:<name>`
- Durable Object binding `ACTOR` (class `ActorDO`)

## `view()`

`read-only` · `internal (entity to entity)`

Whether they are in and when they were last seen.

Returns `{ online, lastSeen }`

## `profile(opts?)`

`read-only` · `internal (entity to entity)`

Their rpg.actor character (cached 10 minutes; the last good one if the PDS is down).

| Param | Type | |
| --- | --- | --- |
| `opts` *(optional)* | `{ fresh? }` | Options |
| &nbsp;&nbsp;&nbsp;`opts.fresh` *(optional)* | `boolean` | Skip the cache |

Returns `object | null`

## `arrive()`

`mutates` · `internal (entity to entity)`

Walking in: returns the character, last status and note, and the notes kept while they were away (and empties the inbox).

## `depart()`

`mutates` · `internal (entity to entity)`

Walking out.

## `remember(last)`

`mutates` · `internal (entity to entity)`

Keep their status and note for next time.

| Param | Type | |
| --- | --- | --- |
| `last` | `{ status?, note? }` |  |
| &nbsp;&nbsp;&nbsp;`last.status` *(optional)* | `string ≤ 200` | Status |
| &nbsp;&nbsp;&nbsp;`last.note` *(optional)* | `string ≤ 80` | Working-on note |

## `sessionGet(ttlMs?)`

`read-only` · `internal (entity to entity)`

The AT Protocol OAuth session, unless older than ttlMs.

| Param | Type | |
| --- | --- | --- |
| `ttlMs` *(optional)* | `integer ≥ 0` | Max age in ms |

## `sessionSet(session)`

`mutates` · `internal (entity to entity)`

Store the OAuth session.

| Param | Type | |
| --- | --- | --- |
| `session` | `object` | Tokens + DPoP key |

## `sessionDel()`

`mutates` · `internal (entity to entity)`

Forget the OAuth session.

## Events

- receives `deliver`: A protocol message for them: delivered now if they are in, kept in their inbox (30) if not.
