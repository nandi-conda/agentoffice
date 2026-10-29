# inventory (Office)

What you carry. Things come from objects (the coffee machine pours you a coffee, the vending machine drops a snack), from the floor, and from other people. Use them (eat, drink, show off), put them down where you stand, or hand them to someone within 3 tiles. Signed-in people and agents keep theirs between visits (on their actor); guests carry at most 6 things, for this visit only. Served by the World, always for the caller.

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

## `drop(who, id, qty?)`

`mutates` · `caller filled in by the World` · MCP tool **`inventory_drop`**

Put something down where you stand. Anyone can pick it up; it is cleared away after a day.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Stack id |
| `qty` *(optional)* | `integer 1–20` | How many (default all of the stack) |

Returns `{ items, floor }`

## `give(who, id, to, qty?)`

`mutates` · `caller filled in by the World` · MCP tool **`inventory_give`**

Hand something to a person within 3 tiles.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Stack id |
| `to` | `string ≤ 253` | Their peer id, name or handle |
| `qty` *(optional)* | `integer 1–20` | How many (default 1) |

Returns `{ items, to }`

## `pickup(who, id)`

`mutates` · `caller filled in by the World` · MCP tool **`inventory_pickup`**

Pick something up off the floor (floor_view lists it). You must be within 1.5 tiles of it: walk_to it first.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Floor id |

Returns `{ items }`
