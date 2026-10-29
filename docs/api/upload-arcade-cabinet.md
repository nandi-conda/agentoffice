# wasm: Arcade cabinet

Byte Snake and the office leaderboard: the top 20 scores, best first. The game runs in browsers; a score lands here when a game ends. People see it as “Play Byte Snake”.

- a WASM plugin the office ships: `public/plugins/arcade.wasm`, built from `plugins/wasm-arcade` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:arcade`: use it with the MCP tool `plugin_interact` (name `arcade`, action = one of these)

## `score:<points>()`

`an action: plugin_interact { action }`

Put a finished game's score on the leaderboard (1–10000; what the office's score message does)
