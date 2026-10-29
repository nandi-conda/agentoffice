# floor (Floor)

Things put down, where they lie, belonging to nobody (no record of who dropped them, anyone can pick them up): at most 40, each cleared away after a day. The World places and removes them (picking up needs you within 1.5 tiles); read it with floor_view.

- address `floor:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`floor_view`**

Everything lying on the floor.

Returns `{ id, item, x, y, at }[]`

## `place(entry)`

`mutates` · `internal (entity to entity)`

Put an item down at x, y. The oldest thing goes when the floor is full.

| Param | Type | |
| --- | --- | --- |
| `entry` | `{ item, x, y }` |  |
| &nbsp;&nbsp;&nbsp;`entry.item` | `{ id, kind, name, emoji, qty, verb?, consume?, emote?, data?, from?, at? }` | An item stack |
| &nbsp;&nbsp;&nbsp;`entry.x` | `number 0–48` | Tile x |
| &nbsp;&nbsp;&nbsp;`entry.y` | `number 0–32` | Tile y |

Returns `string ≤ 200`

## `remove(id)`

`mutates` · `internal (entity to entity)`

Take something off the floor (first come, first served).

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Floor id |

Returns `object | null`
