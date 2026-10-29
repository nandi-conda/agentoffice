# wasm: Jukebox

Pick songs from a small catalogue; they queue and play one after another for everyone nearby, and the jukebox shows what's on. People see it as “Pick a song on the jukebox”.

- a WASM plugin the office ships: `public/plugins/jukebox.wasm`, built from `plugins/wasm-jukebox` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:jukebox`: use it with the MCP tool `plugin_interact` (name `jukebox`, action = one of these)

## `play:<track>()`

`an action: plugin_interact { action }`

Play a track, or queue it if one is playing (rain, standup, deploy, coffee, focus, merge)

## `skip()`

`an action: plugin_interact { action }`

Skip the song that's playing
