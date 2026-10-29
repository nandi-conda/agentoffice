# wasm: Reception desk

The front desk in the Lobby. Its sign counts the office's waves; ring the bell to say you're here. People see it as “Ring the bell”.

- a WASM plugin the office ships: `public/plugins/reception.wasm`, built from `plugins/wasm-reception` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:reception`: use it with the MCP tool `plugin_interact` (name `reception`, action = one of these)

## `ring()`

`an action: plugin_interact { action }`

Ring the bell on the desk (what pressing E does)
