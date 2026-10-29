# uobj (UploadedObject)

An object someone uploaded (gallery:main lists them). Its plugin runs in the sandbox: a Dynamic Worker on Cloudflare, a worker thread on Node. Same contract and panel as the built-in plugin objects.

- address `uobj:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)

## `view()`

`read-only` · MCP tool **`uobj_view`**

What everyone sees on the object and how its plugin was last reached.

Returns `{ display, via }`

## `interact(who, req)`

`mutates` · `caller filled in by the World` · `caller must be within 3 tiles` · MCP tool **`uobj_interact`**

Use the object. `action` is "use" to open it, or an action id from the panel it answered with; `input` is typed text for actions that take it. The panel goes back to the caller as an objui message; what it says goes to everyone. The name is the object id (u-…) from gallery_view.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ action?, input? }` | What to do |
| &nbsp;&nbsp;&nbsp;`req.action` *(optional)* | `string ≤ 64 /^[\w:.-]{1,64}$/` | Action id |
| &nbsp;&nbsp;&nbsp;`req.input` *(optional)* | `string \| null` | Typed text |

Returns `object | null`

## `install(item, code)`

`mutates` · `internal (entity to entity)`

Store the code and manifest of a new upload (from gallery:main).

| Param | Type | |
| --- | --- | --- |
| `item` | `{ id, name, prompt, doc, emoji, glow, look, lang, size, version, x, y, zone, owner, createdAt }` | An uploaded object |
| &nbsp;&nbsp;&nbsp;`item.id` | `string ≤ 200` | Object id on the map (u-…); its entity is uobj:<id> |
| &nbsp;&nbsp;&nbsp;`item.name` | `string ≤ 40` | Name |
| &nbsp;&nbsp;&nbsp;`item.prompt` | `string ≤ 60` | What the E prompt says |
| &nbsp;&nbsp;&nbsp;`item.doc` | `string ≤ 280` | What it does |
| &nbsp;&nbsp;&nbsp;`item.emoji` | `string ≤ 8` | Shown on its plinth |
| &nbsp;&nbsp;&nbsp;`item.glow` | `string ≤ 9` | Accent colour #rrggbb |
| &nbsp;&nbsp;&nbsp;`item.look` | `string ≤ 200` | How it's drawn: plinth, kiosk, jukebox, vending, eightball |
| &nbsp;&nbsp;&nbsp;`item.lang` | `string ≤ 200` | wasm or js |
| &nbsp;&nbsp;&nbsp;`item.size` | `number ≥ 0` | Code size in bytes |
| &nbsp;&nbsp;&nbsp;`item.version` | `string ≤ 200` | First bytes of the code's SHA-256 |
| &nbsp;&nbsp;&nbsp;`item.x` | `number ≥ 0` | Tile x |
| &nbsp;&nbsp;&nbsp;`item.y` | `number ≥ 0` | Tile y |
| &nbsp;&nbsp;&nbsp;`item.zone` | `string \| null` | Zone it stands in |
| &nbsp;&nbsp;&nbsp;`item.owner` | `{ did, handle, name }` | Who uploaded it |
| &nbsp;&nbsp;&nbsp;`item.createdAt` | `number ≥ 0` | When, epoch ms |
| `code` | `string ≤ 699052` | Base64 code |

## `uninstall()`

`mutates` · `internal (entity to entity)`

Forget the code and memory (from gallery:main).
