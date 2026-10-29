# wing (Wing)

The hallway wing under the core office: one procedurally generated room per channel. Sources (freeq, or people opening rooms themselves) offer channels; the wing gives each a slot off the hallways, sizes it by member count, and archives rooms nobody wants any more once they are empty. Clients build the same rooms from its view.

- address `wing:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`wing_view`**

The channel rooms, by slot. Each client generates the same room from { channel, slot, tier }.

Returns `{ id, channel, slot, tier, topic?, members, sources, created, by?, policy, access }[]`

## `offer(source, channels)`

`mutates` · `internal (entity to entity)`

A source's current channels. New ones get a room, known ones are updated, and rooms the source no longer lists are let go (archived once empty for 30 minutes and no other source wants them). Returns channel (lowercase, with #) -> zone id.

| Param | Type | |
| --- | --- | --- |
| `source` | `string ≤ 16` | Source name |
| `channels` | `{ name, members?, topic?, policy?, allow? }[] (≤ 24)` | Channels |

Returns `object`

## `open(who, name, access?, rules?)`

`mutates` · `caller filled in by the World` · MCP tool **`wing_open`**

Open a room for a channel off the hallway (or find the one it already has). Signed-in people and agents only. access: open (default), rules (people accept `rules` at the door) or invite (people inside let others in).

| Param | Type | |
| --- | --- | --- |
| `name` | `string ≤ 33` | Channel name, e.g. #design |
| `access` *(optional)* | `"open" \| "rules" \| "invite"` | open, rules or invite |
| `rules` *(optional)* | `string ≤ 2000` | Rules text for access=rules |

Returns `{ room?, error? }`

## `close(who, name)`

`mutates` · `caller filled in by the World` · `moderators may for anyone (rooms.close)` · MCP tool **`wing_close`**

Let go of a room you opened. It goes once it is empty, unless another source (freeq) still has the channel. Moderators can close any room, freeq ones included: it is archived once empty and stays closed until a moderator opens it again.

| Param | Type | |
| --- | --- | --- |
| `name` | `string ≤ 33` | Channel name |

Returns `{ ok?, closed?, error? }`

## `setAccess(who, name, access, rules?)`

`mutates` · `caller filled in by the World` · `moderators may for anyone (rooms.policy)` · MCP tool **`wing_setAccess`**

Change who may walk into a room you opened (moderators: any room opened in the office): open, rules (accept `rules` at the door) or invite. Rooms from another source (freeq) keep that source's policy.

| Param | Type | |
| --- | --- | --- |
| `name` | `string ≤ 33` | Channel name |
| `access` | `"open" \| "rules" \| "invite"` | open, rules or invite |
| `rules` *(optional)* | `string ≤ 2000` | Rules text for access=rules |

Returns `{ room?, error? }`

## `prune()`

`mutates` · `internal (entity to entity)`

Archive rooms nobody wants that have been empty long enough. The alarm calls it.

## Events

- tells `chan:<id>`: init { channel } when a room is made
- receives `active`: from chan:<id>, someone used the room
