# uobj (UploadedObject)

An object someone uploaded (gallery:main lists them). Its plugin runs in the sandbox: a Dynamic Worker on Cloudflare, a worker thread on Node. Same contract and panel as the built-in plugin objects.

- address `uobj:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)

## `view()`

`read-only` · MCP tool **`uobj_view`**

What everyone sees on the object and how its plugin was last reached, and its feed when it keeps one (the whiteboard's strokes).

Returns `{ display, via, feed? }`

## `interact(who, req)`

`mutates` · `caller filled in by the World` · `caller must be within 3 tiles` · MCP tool **`uobj_interact`**

Use the object. `action` is "use" to open it, or an action id from the panel it answered with; `input` is typed text for actions that take it. The panel goes back to the caller as an objui message; what it says goes to everyone. The name is the object id (u-…) from gallery_view, whose `api` lists the actions the object declares.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ action?, input?, data? }` | What to do |
| &nbsp;&nbsp;&nbsp;`req.action` *(optional)* | `string ≤ 64 /^[\w:.-]{1,64}$/` | Action id |
| &nbsp;&nbsp;&nbsp;`req.input` *(optional)* | `string \| null` | Typed text |
| &nbsp;&nbsp;&nbsp;`req.data` *(optional)* | `any` | JSON for actions that take it (≤ 16 KB), e.g. a whiteboard stroke { points, color, size } |

Returns `object | null`

## `perform(who, req)`

`mutates` · `caller filled in by the World` · `internal (entity to entity)`

A protocol message the World turns into an action (the whiteboard's `wb` strokes): like interact, without the cooldown between uses.

| Param | Type | |
| --- | --- | --- |
| `req` | `object` | { action, input, data } |

## `act(who, action, input?, event?)`

`mutates` · `internal (entity to entity)`

The office's own call into the object, without the use cooldown or the walk up: a carried Skeleton Key gets `open:<room>` this way as its carrier reaches a booked door.

| Param | Type | |
| --- | --- | --- |
| `who` | `object \| null` | Who it is for (null: the office itself) |
| `action` | `string ≤ 64` | Action id |
| `input` *(optional)* | `string \| null` | Typed text |
| `event` *(optional)* | `{ type, zone?, data? }` | An office event |
| &nbsp;&nbsp;&nbsp;`event.type` | `string ≤ 200` | Event type |
| &nbsp;&nbsp;&nbsp;`event.zone` *(optional)* | `string ≤ 200` | Zone |
| &nbsp;&nbsp;&nbsp;`event.data` *(optional)* | `any` | What goes with it |

Returns `object | null`

## `install(item, code)`

`mutates` · `internal (entity to entity)`

Store the code and manifest of a new upload (from gallery:main).

| Param | Type | |
| --- | --- | --- |
| `item` | `{ id, name, prompt, doc, emoji, glow, look, sprite?, lang, size, version, x, y, zone, carried?, owner, createdAt, permissions, level, api }` | An uploaded object |
| &nbsp;&nbsp;&nbsp;`item.id` | `string ≤ 200` | Object id on the map (u-…); its entity is uobj:<id> |
| &nbsp;&nbsp;&nbsp;`item.name` | `string ≤ 40` | Name |
| &nbsp;&nbsp;&nbsp;`item.prompt` | `string ≤ 60` | What the E prompt says |
| &nbsp;&nbsp;&nbsp;`item.doc` | `string ≤ 280` | What it does |
| &nbsp;&nbsp;&nbsp;`item.emoji` | `string ≤ 8` | Its emoji (on its screen, and as an item) |
| &nbsp;&nbsp;&nbsp;`item.glow` | `string ≤ 9` | Accent colour #rrggbb |
| &nbsp;&nbsp;&nbsp;`item.look` | `string ≤ 200` | How it's drawn: kiosk, arcade, jukebox, vending, eightball, coffee, rally, whiteboard, board, pomodoro, reception, panel, computer, sprite, item |
| &nbsp;&nbsp;&nbsp;`item.sprite` *(optional)* | `object` | Look sprite: its own pixel art from the manifest, { rows: ["..bb..", …], palette: { b: "#rrggbb" } }, ≤ 16 × 24 |
| &nbsp;&nbsp;&nbsp;`item.lang` | `string ≤ 200` | wasm or js |
| &nbsp;&nbsp;&nbsp;`item.size` | `number ≥ 0` | Code size in bytes |
| &nbsp;&nbsp;&nbsp;`item.version` | `string ≤ 200` | First bytes of the code's SHA-256 |
| &nbsp;&nbsp;&nbsp;`item.x` | `number \| null` | Tile x (null: carried) |
| &nbsp;&nbsp;&nbsp;`item.y` | `number \| null` | Tile y (null: carried) |
| &nbsp;&nbsp;&nbsp;`item.zone` | `string \| null` | Zone it stands in |
| &nbsp;&nbsp;&nbsp;`item.carried` *(optional)* | `boolean` | Not in a room: one item in someone's inventory (with unlock, a skeleton key). Put it down to stand it in a room again |
| &nbsp;&nbsp;&nbsp;`item.owner` | `object \| null` | Who put it in the room (at first its uploader): { did, handle, name }. Null while carried: it belongs to whoever holds it |
| &nbsp;&nbsp;&nbsp;`item.createdAt` | `number ≥ 0` | When, epoch ms |
| &nbsp;&nbsp;&nbsp;`item.permissions` | `"take" \| "feed" \| "notify" \| "unlock"[]` | What its manifest asked for beyond the basics and was granted: take (trusted), feed (trusted), notify (trusted), unlock (privileged) |
| &nbsp;&nbsp;&nbsp;`item.level` | `"basic" \| "trusted" \| "privileged"` | basic, trusted (moderators upload it) or privileged (admins upload it) |
| &nbsp;&nbsp;&nbsp;`item.api` | `object` | The actions its manifest declares, { action: { doc, params? } }: pass one as `action` to uobj_interact (with `input` when it has params.input). Empty when the module has no manifest. |
| `code` | `string ≤ 699052` | Base64 code |

## `uninstall()`

`mutates` · `internal (entity to entity)`

Forget the code and memory (from gallery:main).

## `program()`

`read-only` · `internal (entity to entity)`

The code a workstation runs at this object while it stands in a room as a computer (look `computer`); null otherwise.

Returns `object | null`

## `moved(item)`

`mutates` · `internal (entity to entity)`

Where it is now (from gallery:main, when it's picked up or put down).

| Param | Type | |
| --- | --- | --- |
| `item` | `{ id, name, prompt, doc, emoji, glow, look, sprite?, lang, size, version, x, y, zone, carried?, owner, createdAt, permissions, level, api }` | An uploaded object |
| &nbsp;&nbsp;&nbsp;`item.id` | `string ≤ 200` | Object id on the map (u-…); its entity is uobj:<id> |
| &nbsp;&nbsp;&nbsp;`item.name` | `string ≤ 40` | Name |
| &nbsp;&nbsp;&nbsp;`item.prompt` | `string ≤ 60` | What the E prompt says |
| &nbsp;&nbsp;&nbsp;`item.doc` | `string ≤ 280` | What it does |
| &nbsp;&nbsp;&nbsp;`item.emoji` | `string ≤ 8` | Its emoji (on its screen, and as an item) |
| &nbsp;&nbsp;&nbsp;`item.glow` | `string ≤ 9` | Accent colour #rrggbb |
| &nbsp;&nbsp;&nbsp;`item.look` | `string ≤ 200` | How it's drawn: kiosk, arcade, jukebox, vending, eightball, coffee, rally, whiteboard, board, pomodoro, reception, panel, computer, sprite, item |
| &nbsp;&nbsp;&nbsp;`item.sprite` *(optional)* | `object` | Look sprite: its own pixel art from the manifest, { rows: ["..bb..", …], palette: { b: "#rrggbb" } }, ≤ 16 × 24 |
| &nbsp;&nbsp;&nbsp;`item.lang` | `string ≤ 200` | wasm or js |
| &nbsp;&nbsp;&nbsp;`item.size` | `number ≥ 0` | Code size in bytes |
| &nbsp;&nbsp;&nbsp;`item.version` | `string ≤ 200` | First bytes of the code's SHA-256 |
| &nbsp;&nbsp;&nbsp;`item.x` | `number \| null` | Tile x (null: carried) |
| &nbsp;&nbsp;&nbsp;`item.y` | `number \| null` | Tile y (null: carried) |
| &nbsp;&nbsp;&nbsp;`item.zone` | `string \| null` | Zone it stands in |
| &nbsp;&nbsp;&nbsp;`item.carried` *(optional)* | `boolean` | Not in a room: one item in someone's inventory (with unlock, a skeleton key). Put it down to stand it in a room again |
| &nbsp;&nbsp;&nbsp;`item.owner` | `object \| null` | Who put it in the room (at first its uploader): { did, handle, name }. Null while carried: it belongs to whoever holds it |
| &nbsp;&nbsp;&nbsp;`item.createdAt` | `number ≥ 0` | When, epoch ms |
| &nbsp;&nbsp;&nbsp;`item.permissions` | `"take" \| "feed" \| "notify" \| "unlock"[]` | What its manifest asked for beyond the basics and was granted: take (trusted), feed (trusted), notify (trusted), unlock (privileged) |
| &nbsp;&nbsp;&nbsp;`item.level` | `"basic" \| "trusted" \| "privileged"` | basic, trusted (moderators upload it) or privileged (admins upload it) |
| &nbsp;&nbsp;&nbsp;`item.api` | `object` | The actions its manifest declares, { action: { doc, params? } }: pass one as `action` to uobj_interact (with `input` when it has params.input). Empty when the module has no manifest. |

## Events

- subscribes `zone:<id>`: enter / exit, for the zones its plugin asked to watch (answer `watch`): calls the plugin with action `enter:<zone>` / `exit:<zone>` as that person
