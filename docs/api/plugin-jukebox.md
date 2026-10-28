# plugin: Jukebox

Pick songs from a small catalogue; they queue and play one after another, and the jukebox shows what's on. People see it as “Pick a song”.

- service binding `PLUGIN_JUKEBOX` → Worker `agentoffice-objects`, WorkerEntrypoint `Jukebox` (source `plugins/objects`)
- on the map as `plugin:jukebox`: use it with the MCP tool `plugin_interact` (name `jukebox`)
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
