# plugin (PluginObject)

An interactive object on the map (jukebox, vending machine, 8-ball, the Office Rally…). Its behaviour is a WASM module the office ships in public/plugins, run in the uploads sandbox.

- address `plugin:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- 14: `pomodoro`, `whiteboard`, `panel-board`, `panel-huddle`, `panel-booth1`, `panel-booth2`, `panel-booth3`, `rally`, `noticeboard`, `coffee`, `vending`, `arcade`, `jukebox`, `eightball`

## `view()`

`read-only` · MCP tool **`plugin_view`**

What everyone sees on the object and how its plugin was last reached, and its feed when it keeps one (the whiteboard's strokes).

Returns `{ display, via, feed? }`

## `interact(who, req)`

`mutates` · `caller filled in by the World` · `caller must be within 3 tiles` · MCP tool **`plugin_interact`**

Use the object. `action` is "use" to open it, or an action id from the panel it answered with; `input` is typed text for actions that take it. The panel goes back to the caller as an objui message; what it says goes to everyone.

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

The office's own call into the object, without the use cooldown or the walk up: the meeting room panels get `book` (booking changes) and `unlock` (the Skeleton Key) this way, as an event only the office can send, and `tick` when the World nudges them. who=null calls as the office.

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

## `wake()`

`read-only` · `internal (entity to entity)`

Make sure the object is showing what it should: one that used to be a core entity takes over that entity's state and shows it. The World calls it when it starts.

Returns `boolean`

## Events

- subscribes `zone:<id>`: enter / exit, for the zones its plugin asked to watch (answer `watch`): calls the plugin with action `enter:<zone>` / `exit:<zone>` as that person
