# wasm: Meeting room panel

The panel by a meeting room's door: keeps the room's bookings, sends reminders and start/end notes, lets knockers in, and frees the room when nobody turns up. Book with the booking form, book_room or manage_booking. People see it as “Check the room's schedule”.

- a WASM plugin the office ships: `public/plugins/rooms.wasm`, built from `plugins/wasm-rooms` with the agentoffice-plugin crate, whose manifest these actions come from; it runs in the plugin sandbox
- on the map as `plugin:panel-board`, `plugin:panel-huddle`, `plugin:panel-booth1`, `plugin:panel-booth2`, `plugin:panel-booth3`: use it with the MCP tool `plugin_interact` (name `panel-board`, `panel-huddle`, `panel-booth1`, `panel-booth2`, `panel-booth3`, action = one of these)
- permissions: `notify`, so it's trusted (see uploads.md, permission levels)
