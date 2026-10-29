# actor (Actor)

One per identity: a DID (signed-in person or agent), or agent:<name> for agents without one. Holds the rpg.actor character, the status they had last, notes that came while they were away, what they carry (their inventory), and (for DIDs) their AT Protocol OAuth session. Guests get none: what a guest carries lives on their connection in the World and goes when they do.

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

## `depart(at?)`

`mutates` · `internal (entity to entity)`

Walking out, leaving from `at`.

| Param | Type | |
| --- | --- | --- |
| `at` *(optional)* | `{ x, y, dir?, zone? }` | Where they stand |
| &nbsp;&nbsp;&nbsp;`at.x` | `number` | X in tiles |
| &nbsp;&nbsp;&nbsp;`at.y` | `number` | Y in tiles |
| &nbsp;&nbsp;&nbsp;`at.dir` *(optional)* | `integer 0–3` | Facing: 0 down, 1 left, 2 right, 3 up |
| &nbsp;&nbsp;&nbsp;`at.zone` *(optional)* | `string \| null` | Area id |

## `where()`

`read-only` · `internal (entity to entity)`

Where they were last (kept while they are away, so a refresh or a new sign-in puts them back there).

Returns `object | null`

## `place(at)`

`mutates` · `internal (entity to entity)`

The World keeps where they stand (when they stop, and as they leave).

| Param | Type | |
| --- | --- | --- |
| `at` | `{ x, y, dir?, zone? }` | Where they stand |
| &nbsp;&nbsp;&nbsp;`at.x` | `number` | X in tiles |
| &nbsp;&nbsp;&nbsp;`at.y` | `number` | Y in tiles |
| &nbsp;&nbsp;&nbsp;`at.dir` *(optional)* | `integer 0–3` | Facing: 0 down, 1 left, 2 right, 3 up |
| &nbsp;&nbsp;&nbsp;`at.zone` *(optional)* | `string \| null` | Area id |

## `moveTo(who, target)`

`mutates` · `moderators may for anyone (people.move)` · `internal (entity to entity)`

Move them: in the office they walk (or, with teleport, appear) at the place; away, it is where they come back. Anyone may move themselves; moderators may move anyone (people.move); entities pass who=null.

| Param | Type | |
| --- | --- | --- |
| `who` | `object \| null` | Who asks (null: the system or another entity) |
| `target` | `{ x?, y?, place?, teleport?, text? }` | Where to: x/y or place |
| &nbsp;&nbsp;&nbsp;`target.x` *(optional)* | `number` | X in tiles |
| &nbsp;&nbsp;&nbsp;`target.y` *(optional)* | `number` | Y in tiles |
| &nbsp;&nbsp;&nbsp;`target.place` *(optional)* | `string ≤ 253` | A zone id or name, #channel, seat or desk id, furniture id, or a person |
| &nbsp;&nbsp;&nbsp;`target.teleport` *(optional)* | `boolean` | Appear there instead of walking |
| &nbsp;&nbsp;&nbsp;`target.text` *(optional)* | `string ≤ 200` | Shown to them |

Returns `{ ok?, online?, x?, y?, zone?, error? }`

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

## `inventory()`

`read-only` · `internal (entity to entity)`

What they carry.

Returns `{ id, kind, name, emoji, qty, verb?, consume?, emote?, data?, from?, at? }[]`

## `invApply(change)`

`mutates` · `internal (entity to entity)`

Take and give items in one go, all or nothing (at most 20 stacks of 20). The World calls it for picking up, dropping, giving and using; plugins reach it through the World.

| Param | Type | |
| --- | --- | --- |
| `change` | `{ take?, give?, from? }` | A change to their things: all or nothing |
| &nbsp;&nbsp;&nbsp;`change.take` *(optional)* | `{ id?, kind?, qty? }[] (≤ 10)` | Taken first, oldest stacks of a kind first |
| &nbsp;&nbsp;&nbsp;`change.give` *(optional)* | `{ id, kind, name, emoji, qty, verb?, consume?, emote?, data?, from?, at? }[] (≤ 10)` | Then given (cleaned with cleanItem) |
| &nbsp;&nbsp;&nbsp;`change.from` *(optional)* | `string ≤ 40` | Who is handing them out, stamped on given items |

Returns `{ items?, taken?, error? }`

## `role()`

`read-only` · `internal (entity to entity)`

The role they were granted (roles:main keeps the directory and hands each actor its copy).

Returns `object | null`

## `setRole(grant)`

`mutates` · `internal (entity to entity)`

Keep a copy of the role roles:main granted them (null: back to the default).

| Param | Type | |
| --- | --- | --- |
| `grant` | `object \| null` | { role, by, at } |

## Events

- receives `deliver`: A protocol message for them: delivered now if they are in, kept in their inbox (30) if not.
