# inventory (Office)

What you carry. Things come from objects (the coffee machine pours you a coffee, the vending machine drops a snack), from the floor, and from other people. Use them (eat, drink, show off), throw them away, put them down on a spot within 3 tiles, or hand them to someone within 3 tiles. Signed-in people and agents keep theirs between visits (on their actor); guests carry at most 6 things, for this visit only. Served by the World, always for the caller.

- address `inventory:<name>`
- Durable Object binding `OFFICE` (class `OfficeRoom`)
- one: `me`

## `view(who)`

`read-only` · `caller filled in by the World` · MCP tool **`inventory_view`**

What you carry.

Returns `{ id, kind, name, emoji, qty, verb?, consume?, emote?, data?, from?, at? }[]`

## `use(who, id)`

`mutates` · `caller filled in by the World` · MCP tool **`inventory_use`**

Use one of your things: eat it, drink it, or show it off. Everyone who can hear you sees it; things like snacks are used up.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Stack id (from inventory_view) |

Returns `{ items, did }`

## `place(who, id, x?, y?, qty?)`

`mutates` · `caller filled in by the World` · MCP tool **`inventory_place`**

Put something down on a tile within 3 tiles of you that you can reach on foot: not a wall or furniture, not something already lying or standing there, not a booked room you're kept out of. Leave out x and y to put it down at your feet (or the nearest free tile). Things lie on the floor: anyone can pick them up, and they are cleared away after a day. An object you carry (an uploaded plugin: an arcade cabinet, a guestbook…) stands up in the room as itself instead, works for everyone, and is yours: only you (or a moderator) can pick it up again.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Stack id |
| `x` *(optional)* | `number 0–48` | Tile x (any point in the tile) |
| `y` *(optional)* | `number 0–32` | Tile y |
| `qty` *(optional)* | `integer 1–20` | How many (default all of the stack) |

Returns `{ items, floor?, object?, x, y }`

## `give(who, id, to, qty?)`

`mutates` · `caller filled in by the World` · MCP tool **`inventory_give`**

Hand something to a person within 3 tiles.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Stack id |
| `to` | `string ≤ 253` | Their peer id, name or handle |
| `qty` *(optional)* | `integer 1–20` | How many (default 1) |

Returns `{ items, to }`

## `destroy(who, id, qty?)`

`mutates` · `caller filled in by the World` · MCP tool **`inventory_destroy`**

Throw something away for good: it is gone, not put down anywhere, and nobody gets it back. Works anywhere.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Stack id |
| `qty` *(optional)* | `integer 1–20` | How many (default all of the stack) |

Returns `{ items }`

## `pickup(who, id)`

`mutates` · `caller filled in by the World` · MCP tool **`inventory_pickup`**

Pick something up off the floor (floor_view lists it), or an object standing in a room that is yours (gallery_view lists it: its u-… id), which goes into your inventory as one item. You must be within 1.5 tiles of it: walk_to it first.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Floor id, or an object id (u-…) |

Returns `{ items }`
