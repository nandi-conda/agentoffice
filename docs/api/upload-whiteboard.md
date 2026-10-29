# wasm: Whiteboard

The shared Boardroom whiteboard. Everyone in the office sees it live; it's drawn on the boardroom wall too. People see it as “Open the whiteboard”.

- a WASM plugin the office ships: `public/plugins/whiteboard.wasm`, built from `plugins/wasm-whiteboard` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:whiteboard`: use it with the MCP tool `plugin_interact` (name `whiteboard`, action = one of these)
- permissions: `feed`, so it's trusted (see uploads.md, permission levels)

## `stroke()`

`an action: plugin_interact { action }`

Draw a stroke: data { points: [[x, y], …] (2–400, 0..1 across the board, origin top-left), color: "#rrggbb", size: 1–40 }

## `clear()`

`an action: plugin_interact { action }`

Wipe the board for everyone
