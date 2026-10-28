# plugin (PluginObject)

An interactive object (jukebox, vending machine, 8-ball, kiosk…) whose behaviour comes from a plugin Worker over a service binding, with a built-in fallback.

- address `plugin:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- 4: `kiosk`, `vending`, `jukebox`, `eightball`

## `view()`

`read-only` · MCP tool **`plugin_view`**

What everyone sees on the object and how its plugin was last reached.

Returns `{ display, via }`

## `interact(who, req)`

`mutates` · `caller filled in by the World` · `caller must be within 3 tiles` · MCP tool **`plugin_interact`**

Use the object. `action` is "use" to open it, or an action id from the panel it answered with; `input` is typed text for actions that take it. The panel goes back to the caller as an objui message; what it says goes to everyone.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ action?, input? }` | What to do |
| &nbsp;&nbsp;&nbsp;`req.action` *(optional)* | `string ≤ 64 /^[\w:.-]{1,64}$/` | Action id |
| &nbsp;&nbsp;&nbsp;`req.input` *(optional)* | `string \| null` | Typed text |

Returns `object | null`
