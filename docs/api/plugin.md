# plugin (PluginObject)

An interactive object on the map (jukebox, vending machine, 8-ball, the Office Rally…). Its behaviour is a WASM module the office ships in public/plugins, run in the uploads sandbox.

- address `plugin:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- 8: `pomodoro`, `rally`, `noticeboard`, `coffee`, `vending`, `arcade`, `jukebox`, `eightball`

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

## `wake()`

`read-only` · `internal (entity to entity)`

Make sure the object is showing what it should: one that used to be a core entity takes over that entity's state and shows it. The World calls it when it starts.

Returns `boolean`

## Events

- subscribes `zone:<id>`: enter / exit, for the zones its plugin asked to watch (answer `watch`): calls the plugin with action `enter:<zone>` / `exit:<zone>` as that person
