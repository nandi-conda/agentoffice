# noticeboard (NoticeBoard)

The lobby notice board: sticky notes, newest first, at most 40.

- address `noticeboard:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`noticeboard_view`**

The notes.

Returns `{ id, text, by, owner, ts, color }[]`

## `add(who, text)`

`mutates` · `caller filled in by the World` · MCP tool **`noticeboard_add`**

Pin a note.

| Param | Type | |
| --- | --- | --- |
| `text` | `string ≤ 200` | Note text |

## `remove(who, id)`

`mutates` · `caller filled in by the World` · `moderators may for anyone (notes.remove)` · MCP tool **`noticeboard_remove`**

Take down one of your notes (moderators can take down anyone's).

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Note id |
