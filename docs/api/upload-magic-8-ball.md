# wasm: Magic 8-ball

Ask a yes-or-no question and shake it. Everyone nearby hears the answer. People see it as “Ask the magic 8-ball”.

- a WASM plugin the office ships: `public/plugins/eightball.wasm`, built from `plugins/wasm-eightball` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:eightball`: use it with the MCP tool `plugin_interact` (name `eightball`, action = one of these)

## `ask(input)`

`an action: plugin_interact { action }`

Ask it a question

| Param | Type | |
| --- | --- | --- |
| `input` | `string ≤ 500` | A yes-or-no question (≤ 140 characters) |
