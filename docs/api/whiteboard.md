# whiteboard (Whiteboard)

The Boardroom whiteboard. Strokes are kept one storage key each (the last 3000), so drawing only writes what changed.

- address `whiteboard:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`whiteboard_view`**

Every stroke on the board.

Returns `{ points, color, size, by }[]`

## `stroke(who, stroke)`

`mutates` · `caller filled in by the World` · MCP tool **`whiteboard_stroke`**

Draw a stroke. Coordinates are 0..1 across the board, origin top-left.

| Param | Type | |
| --- | --- | --- |
| `stroke` | `{ points, color?, size? }` | The stroke |
| &nbsp;&nbsp;&nbsp;`stroke.points` | `number 0–1[] (≤ 2)[] (≤ 400)` | At least 2 points, at most 400 |
| &nbsp;&nbsp;&nbsp;`stroke.color` *(optional)* | `string ≤ 7 /^#[0-9a-fA-F]{6}$/` | #rrggbb |
| &nbsp;&nbsp;&nbsp;`stroke.size` *(optional)* | `number 1–24` | Width |

## `clear()`

`mutates` · MCP tool **`whiteboard_clear`**

Wipe the board.
