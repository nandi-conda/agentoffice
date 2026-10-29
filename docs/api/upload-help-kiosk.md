# wasm: Help kiosk

Ask where things are or how the office works. It answers with the office's language model, or from what it knows when there's none. People see it as “Ask the help kiosk”.

- a WASM plugin the office ships: `public/plugins/kiosk.wasm`, built from `plugins/wasm-kiosk` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:kiosk`: use it with the MCP tool `plugin_interact` (name `kiosk`, action = one of these)

## `ask(input)`

`an action: plugin_interact { action }`

Ask it something

| Param | Type | |
| --- | --- | --- |
| `input` | `string ≤ 500` | A question (≤ 300 characters) |
