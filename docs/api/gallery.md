# gallery (Gallery)

Objects people uploaded: WASM (or JS) plugins, each a drawn object that stands in a room or is carried in someone's inventory. Keeps where each is, its manifest and who owns it; the code lives in each uobj:<id>. Uploaded objects follow the plugin contract (docs/plugins.md) and run sandboxed (docs/uploads.md).

- address `gallery:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`gallery_view`**

Every uploaded object: the ones standing in rooms, and the carried ones.

Returns `{ id, name, prompt, doc, emoji, glow, look, sprite?, lang, size, version, x, y, zone, carried?, owner, createdAt, permissions, level, api }[]`

## `upload(who, req)`

`mutates` · `caller filled in by the World` · MCP tool **`gallery_upload`**

Upload a plugin. It becomes one item in your inventory, then stands up as itself on the tile you name with x and y (the same rules as inventory_place: within 3 tiles, reachable on foot, free), or without them on the nearest free tile. A look of `item` stays in your inventory (with the unlock permission, a skeleton key that opens booked rooms as its carrier walks up). Needs AT Protocol sign-in. `code` is the file in base64: a WebAssembly module (≤ 512 KB) exporting memory, alloc and interact (the ABI in docs/uploads.md), or on Cloudflare a JS module exporting interact(). A module built with the agentoffice-plugin crate carries a manifest: its name, prompt, doc, emoji, glow and look fill in whatever you leave out, and the permissions it lists decide who may upload it (trusted ones like take: moderators; privileged ones like unlock: admins). At most 3 per person.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ name?, lang, code, prompt?, doc?, emoji?, glow?, x?, y?, look? }` | The upload |
| &nbsp;&nbsp;&nbsp;`req.name` *(optional)* | `string ≤ 40` | What it's called (default: the manifest's name) |
| &nbsp;&nbsp;&nbsp;`req.lang` | `"wasm" \| "js"` | wasm or js |
| &nbsp;&nbsp;&nbsp;`req.code` | `string ≤ 699052` | The file, base64 |
| &nbsp;&nbsp;&nbsp;`req.prompt` *(optional)* | `string ≤ 60` | What the E prompt says, e.g. "Sign the guestbook" |
| &nbsp;&nbsp;&nbsp;`req.doc` *(optional)* | `string ≤ 280` | What it does, for the docs and the MCP tool list |
| &nbsp;&nbsp;&nbsp;`req.emoji` *(optional)* | `string ≤ 8` | An emoji to show on it |
| &nbsp;&nbsp;&nbsp;`req.glow` *(optional)* | `string ≤ 9 /^#[0-9a-fA-F]{3,8}$/` | Accent colour #rrggbb |
| &nbsp;&nbsp;&nbsp;`req.x` *(optional)* | `number ≥ 0` | Tile x to stand it on (any point in the tile) |
| &nbsp;&nbsp;&nbsp;`req.y` *(optional)* | `number ≥ 0` | Tile y |
| &nbsp;&nbsp;&nbsp;`req.look` *(optional)* | `"kiosk" \| "arcade" \| "jukebox" \| "vending" \| "eightball" \| "coffee" \| "rally" \| "whiteboard" \| "board" \| "pomodoro" \| "reception" \| "panel" \| "sprite" \| "item"` | How it's drawn (default: the manifest's look, else kiosk): kiosk (screen kiosk with its emoji), arcade (arcade cabinet), jukebox (jukebox), vending (vending machine), eightball (crystal ball), coffee (coffee machine), rally (chequered flag), whiteboard (whiteboard), board (notice board), pomodoro (focus timer), reception (desk bell), panel (door panel), sprite (its own drawing), item (an item in my inventory). sprite needs a manifest with one; item starts in your inventory |

Returns `object`

## `carry(id)`

`mutates` · `internal (entity to entity)`

An object standing in a room was picked up: it's carried now, and nobody's here.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 20` | Object id (u-…) |

Returns `object | null`

## `put(id, x, y, owner)`

`mutates` · `internal (entity to entity)`

A carried object was put down on a tile: it stands there, and is whoever put it there's.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 20` | Object id (u-…) |
| `x` | `number ≥ 0` | Tile x |
| `y` | `number ≥ 0` | Tile y |
| `owner` | `object \| null` | { did, handle, name } |

Returns `object`

## `remove(who, req)`

`mutates` · `caller filled in by the World` · `moderators may for anyone (uploads.remove)` · MCP tool **`gallery_remove`**

Take an uploaded object off the map and delete its code and memory. Only its uploader (or a moderator) can. A carried one (look item) belongs to whoever holds it: they throw it away with inventory_destroy; only a moderator can remove it here.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ id }` | Which object |
| &nbsp;&nbsp;&nbsp;`req.id` | `string ≤ 20` | Object id (u-…) |

Returns `object`

## `discard(id)`

`mutates` · `internal (entity to entity)`

A carried upload's item is gone (thrown away, swept off the floor): delete its code and memory.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 20` | Object id (u-…) |

Returns `boolean`
