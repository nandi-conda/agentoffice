# plugin: Magic 8-ball

Ask a yes-or-no question; everyone nearby hears the answer. People see it as “Ask the 8-ball”.

- service binding `PLUGIN_EIGHTBALL` → Worker `agentoffice-objects`, WorkerEntrypoint `EightBall` (source `plugins/objects`)
- on the map as `plugin:eightball`: use it with the MCP tool `plugin_interact` (name `eightball`)
- every call goes through the office (server/plugins.js), which clips and shape-checks the answer and falls back to the built-in copy when the binding is missing

## `describe()`

`read-only` · `internal (entity to entity)`

What this object is.

Returns `object`

## `interact(req)`

`mutates`

Someone used the object. Returns { state, say, ui, display, toast }; the office stores `state` and passes it back next time.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ object, actor, action, input?, state?, nearby?, now? }` |  |
| &nbsp;&nbsp;&nbsp;`req.object` | `object` |  |
| &nbsp;&nbsp;&nbsp;`req.actor` | `object` |  |
| &nbsp;&nbsp;&nbsp;`req.action` | `string` |  |
| &nbsp;&nbsp;&nbsp;`req.input` *(optional)* | `string \| null` |  |
| &nbsp;&nbsp;&nbsp;`req.state` *(optional)* | `any` |  |
| &nbsp;&nbsp;&nbsp;`req.nearby` *(optional)* | `any[]` |  |
| &nbsp;&nbsp;&nbsp;`req.now` *(optional)* | `number` |  |

Returns `object`
