# wasm: Vending machine

Free snacks while stock lasts; they go in your inventory. Restocks 30 minutes after it sells out. People see it as “Get a snack”.

- a WASM plugin the office ships: `public/plugins/vending.wasm`, built from `plugins/wasm-vending` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:vending`: use it with the MCP tool `plugin_interact` (name `vending`, action = one of these)

## `buy:<snack>()`

`an action: plugin_interact { action }`

Get a snack (chips, choc, gum, soda, cookie)
