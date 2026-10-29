# wasm: Coffee machine

Pours you a coffee: the cup goes in your inventory. Counts every cup. People see it as “Grab a coffee”.

- a WASM plugin the office ships: `public/plugins/coffee.wasm`, built from `plugins/wasm-coffee` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:coffee`: use it with the MCP tool `plugin_interact` (name `coffee`, action = one of these)

## `pour()`

`an action: plugin_interact { action }`

Pour a coffee into your inventory (what pressing E does)

## `brew()`

`an action: plugin_interact { action }`

Count a cup without taking one (the office's coffee message, away from the machine)
