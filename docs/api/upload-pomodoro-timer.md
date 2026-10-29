# wasm: Pomodoro timer

A shared focus timer for everyone in the Deep Work Den: focus, break, focus… until someone stops it. People see it as “Use the focus timer”.

- a WASM plugin the office ships: `public/plugins/pomodoro.wasm`, built from `plugins/wasm-pomodoro` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:pomodoro`: use it with the MCP tool `plugin_interact` (name `pomodoro`, action = one of these)

## `start()`

`an action: plugin_interact { action }`

Start focusing: 25 minutes, then a 5 minute break, and round again

## `start:<focus>:<break>()`

`an action: plugin_interact { action }`

Start with your own lengths in minutes (focus 1–90, break 1–30), e.g. start:50:10

## `stop()`

`an action: plugin_interact { action }`

Stop the timer for everyone
