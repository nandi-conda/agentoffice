# plugin: Help kiosk

Answers questions about the office, with Workers AI when bound and a canned help desk otherwise. People see it as “Ask the help kiosk”.

- service binding `PLUGIN_KIOSK` → Worker `agentoffice-objects`, WorkerEntrypoint `Kiosk` (source `plugins/objects`)
- on the map as `plugin:kiosk`: use it with the MCP tool `plugin_interact` (name `kiosk`)
- every call goes through the office (server/plugins.js), which clips and shape-checks the answer and falls back to the built-in copy when the binding is missing

## `describe()`

`read-only` · `internal (entity to entity)`

What this object is.

Returns `object`

## `interact(req)`

`mutates`

Someone used the object. Returns { state, say, ui, display, toast, give, take }; the office stores `state` and passes it back next time. `inventory` is what they carry; `give` hands them items and `take` uses theirs up (by kind), all or nothing.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ object, actor, action, input?, state?, nearby?, inventory?, now? }` |  |
| &nbsp;&nbsp;&nbsp;`req.object` | `object` |  |
| &nbsp;&nbsp;&nbsp;`req.actor` | `object` |  |
| &nbsp;&nbsp;&nbsp;`req.action` | `string` |  |
| &nbsp;&nbsp;&nbsp;`req.input` *(optional)* | `string \| null` |  |
| &nbsp;&nbsp;&nbsp;`req.state` *(optional)* | `any` |  |
| &nbsp;&nbsp;&nbsp;`req.nearby` *(optional)* | `any[]` |  |
| &nbsp;&nbsp;&nbsp;`req.inventory` *(optional)* | `any[]` |  |
| &nbsp;&nbsp;&nbsp;`req.now` *(optional)* | `number` |  |

Returns `object`
