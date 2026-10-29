# plugin: Office Rally

A checkpoint race around the office. Join at the flag in the Lobby; 20 s later the race picks 3 areas in a random order, then back to the Lobby, with a 3-minute limit. The plugin asks the office to watch those zones and is told whenever a racer walks in; the first three home get medals, and best times stay on the board. Its state lives in the plugin's own Durable Object (RallyRoom). Actions: `join` (the next race; the first join starts a countdown), `leave` (or give up mid-race), `start` (start now, if you're in), `board` (all-time best times), `use` (the panel). While racing, walking into an area sends `enter:<zone>` from the office itself. People see it as “Join the rally”.

- service binding `PLUGIN_RALLY` → Worker `agentoffice-rally`, WorkerEntrypoint `Rally` (source `plugins/rally`)
- on the map as `plugin:rally`: use it with the MCP tool `plugin_interact` (name `rally`)
- every call goes through the office (server/plugins.js), which clips and shape-checks the answer and falls back to the built-in copy when the binding is missing

## `describe()`

`read-only` · `internal (entity to entity)`

What this object is.

Returns `object`

## `interact(req)`

`mutates`

Someone used the flag, or (actor kind "system") the office's alarm went off, or a racer walked into a watched zone (action `enter:<zone>`). Returns { say, ui, display, toast, give, wakeAt, watch }: `watch` lists the zones the office should report, [] to stop. Actions: `join` (the next race; the first join starts a countdown), `leave` (or give up mid-race), `start` (start now, if you're in), `board` (all-time best times), `use` (the panel). While racing, walking into an area sends `enter:<zone>` from the office itself.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ object, actor, action, input?, nearby?, inventory?, event?, now? }` |  |
| &nbsp;&nbsp;&nbsp;`req.object` | `object` |  |
| &nbsp;&nbsp;&nbsp;`req.actor` | `object` |  |
| &nbsp;&nbsp;&nbsp;`req.action` | `string` |  |
| &nbsp;&nbsp;&nbsp;`req.input` *(optional)* | `string \| null` |  |
| &nbsp;&nbsp;&nbsp;`req.nearby` *(optional)* | `any[]` |  |
| &nbsp;&nbsp;&nbsp;`req.inventory` *(optional)* | `any[]` |  |
| &nbsp;&nbsp;&nbsp;`req.event` *(optional)* | `object \| null` |  |
| &nbsp;&nbsp;&nbsp;`req.now` *(optional)* | `number` |  |

Returns `object`
