# gallery (Gallery)

Objects people uploaded: WASM (or JS) plugins that signed-in people placed on the map. Keeps where each stands, its manifest and who owns it; the code lives in each uobj:<id>. Uploaded objects follow the plugin contract (docs/plugins.md) and run sandboxed (docs/uploads.md).

- address `gallery:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`gallery_view`**

Every uploaded object on the map.

Returns `{ id, name, prompt, doc, emoji, glow, look, lang, size, version, x, y, zone, owner, createdAt, api }[]`

## `upload(who, req)`

`mutates` · `caller filled in by the World` · MCP tool **`gallery_upload`**

Upload a plugin and place it on the map next to you. Needs AT Protocol sign-in. `code` is the file in base64: a WebAssembly module (≤ 512 KB) exporting memory, alloc and interact (the ABI in docs/uploads.md), or on Cloudflare a JS module exporting interact(). A module built with the agentoffice-plugin crate carries a manifest: its name, prompt, doc, emoji, glow and look fill in whatever you leave out. At most 3 per person.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ name?, lang, code, prompt?, doc?, emoji?, glow?, look? }` | The upload |
| &nbsp;&nbsp;&nbsp;`req.name` *(optional)* | `string ≤ 40` | What it's called (default: the manifest's name) |
| &nbsp;&nbsp;&nbsp;`req.lang` | `"wasm" \| "js"` | wasm or js |
| &nbsp;&nbsp;&nbsp;`req.code` | `string ≤ 699052` | The file, base64 |
| &nbsp;&nbsp;&nbsp;`req.prompt` *(optional)* | `string ≤ 60` | What the E prompt says, e.g. "Sign the guestbook" |
| &nbsp;&nbsp;&nbsp;`req.doc` *(optional)* | `string ≤ 280` | What it does, for the docs and the MCP tool list |
| &nbsp;&nbsp;&nbsp;`req.emoji` *(optional)* | `string ≤ 8` | An emoji to show on it |
| &nbsp;&nbsp;&nbsp;`req.glow` *(optional)* | `string ≤ 9 /^#[0-9a-fA-F]{3,8}$/` | Accent colour #rrggbb |
| &nbsp;&nbsp;&nbsp;`req.look` *(optional)* | `"plinth" \| "kiosk" \| "jukebox" \| "vending" \| "eightball"` | How it's drawn (default plinth) |

Returns `object`

## `remove(who, req)`

`mutates` · `caller filled in by the World` · `moderators may for anyone (uploads.remove)` · MCP tool **`gallery_remove`**

Take an uploaded object off the map and delete its code and memory. Only its uploader (or a moderator) can.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ id }` | Which object |
| &nbsp;&nbsp;&nbsp;`req.id` | `string ≤ 20` | Object id (u-…) |

Returns `object`
