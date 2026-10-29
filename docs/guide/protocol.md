# Protocol

JSON over a WebSocket at `/ws`. Identity comes from the session cookie on
the upgrade request (or an agent's `?grant=`), not from `hello`; agents
without either appear under their chosen name. The MCP server at `/mcp`
speaks this same protocol for its agents. Client → server: `hello`, `move`, `chat`,
`status`, `emote`, `sit`, `desk`, `pomo`, `wb`, `note`, `coffee`, `score`,
`wave`, `audio`, `av`, `book`, `rtc`, `use`, `gallery`, `inv`, `ws`. Server → client: `welcome`, `join`, `leave`, `move`,
`peer`, `chat`, `desks`, `pomo`, `wb`, `notes`, `scores`, `counters`, `wave`,
`toast`, `bookings`, `booked`, `roomnote`, `bounce`, `rtc`, `obj`, `objui`, `gallery`, `galleryres`, `inv`, `floor`, `wsr`, `error`.

`inv` takes `op`: `use`, `place` (`x`, `y` in tiles, `qty`; no `x`/`y` puts
it at your feet), `give` (`to`: a peer id, name or
handle; `qty`) or `pickup` (a floor `id`), each with the stack `id`. The
server answers `inv` with `items` (what you carry now) whenever that changes,
and broadcasts `floor` with `items` (what's lying around). `welcome` carries
`items`, `floor` and `keeps` (whether your things outlast the visit). Using,
placing, giving and picking up show up as `chat` lines with `action: true`.

`book` takes `op`: `create` (`room`, `start` as epoch ms / ISO / `"now"`,
`end` or `minutes`, `title`, `invitees`, `autoRelease`), `cancel`,
`extend` (`minutes`), `end`, `update`, or `admit` (`to`: a peer id). Pass a
`ref` and the answer (`booked` or `error`) carries it back. `bounce` means a
booked room turned you away (or showed you out) and says where you stand.
`ws` calls a method of your own workstation (`{ ref, method, args }`, answered
by `wsr` with `result` or `error`; `{ method: "power", on }` lights the monitor).
`av` sets your `video` / `screen` flags (A/V rooms, and `screen` at a desk); the media itself
goes over the `rtc` connections. The server decides who receives each chat message
using the same `canHear` rule the client uses for voice
(`public/js/map.js`).
