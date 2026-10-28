# Protocol

JSON over a WebSocket at `/ws`. Identity comes from the session cookie on
the upgrade request (or an agent's `?grant=`), not from `hello`; agents
without either appear under their chosen name. The MCP server at `/mcp`
speaks this same protocol for its agents. Client → server: `hello`, `move`, `chat`,
`status`, `emote`, `sit`, `desk`, `pomo`, `wb`, `note`, `coffee`, `score`,
`wave`, `audio`, `av`, `book`, `rtc`, `use`. Server → client: `welcome`, `join`, `leave`, `move`,
`peer`, `chat`, `desks`, `pomo`, `wb`, `notes`, `scores`, `counters`, `wave`,
`toast`, `bookings`, `booked`, `roomnote`, `bounce`, `rtc`, `obj`, `objui`, `error`.

`book` takes `op`: `create` (`room`, `start` as epoch ms / ISO / `"now"`,
`end` or `minutes`, `title`, `invitees`, `lock`, `autoRelease`), `cancel`,
`extend` (`minutes`), `end`, `update`, or `admit` (`to`: a peer id). Pass a
`ref` and the answer (`booked` or `error`) carries it back. `bounce` means a
locked room turned you away (or showed you out) and says where you stand.
`av` sets your `video` / `screen` flags (A/V rooms only); the media itself
goes over the `rtc` connections. The server decides who receives each chat message
using the same `canHear` rule the client uses for voice
(`public/js/map.js`).
