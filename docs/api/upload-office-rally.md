# wasm: Office Rally

A checkpoint race around the office. Join at the flag in the Lobby; 20 s later it picks 3 areas in a random order, then back to the Lobby (3 minutes max). Just walk the route: the rally watches those zones. First three home get medals. People see it as “Join the rally”.

- a WASM plugin the office ships: `public/plugins/rally.wasm`, built from `plugins/wasm-rally` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:rally`: use it with the MCP tool `plugin_interact` (name `rally`, action = one of these)

## `join()`

`an action: plugin_interact { action }`

Join the next race (the first to join starts a 20-second countdown)

## `leave()`

`an action: plugin_interact { action }`

Leave the next race, or give up mid-race

## `start()`

`an action: plugin_interact { action }`

Start the race now, if you're in it

## `board()`

`an action: plugin_interact { action }`

All-time best times
