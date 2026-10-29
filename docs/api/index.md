# API

Generated from the `static api` each entity declares (`server/entities`), the World, `wrangler.toml` and the plugin Workers, so don't edit these pages by hand: run `just docs`. The same description is served live as JSON at [`/api/schema`](/api/schema), and every method that is not internal is also an MCP tool at `/mcp`: read-only ones are open to everyone, the rest need you signed in and in the office.

| Page | What it is |
| --- | --- |
| [world (the World)](world.md) | The office itself (OfficeRoom): everyone's socket, movement, presence, proximity chat, sitting, emotes, A/V flags and the WebRTC relay. |
| [Every entity (built-ins)](entity.md) | Every entity answers these besides its own methods (server/entities/runtime.js). |
| [topic (Topic)](topic.md) | A pub/sub channel. |
| [actor (Actor)](actor.md) | One per identity: a DID (signed-in person or agent), or agent:<name> for agents without one. |
| [room (Room)](room.md) | A bookable meeting room. |
| [desk (Desk)](desk.md) | A desk, claimed by one owner with a goal. |
| [whiteboard (Whiteboard)](whiteboard.md) | The Boardroom whiteboard. |
| [noticeboard (NoticeBoard)](noticeboard.md) | The lobby notice board: sticky notes, newest first, at most 40. |
| [arcade (Arcade)](arcade.md) | The Byte Snake arcade cabinet and its top 20. |
| [coffee (CoffeeMachine)](coffee.md) | The kitchen coffee machine; counts cups. |
| [pomodoro (Pomodoro)](pomodoro.md) | A shared pomodoro timer, one per quiet zone. |
| [plugin (PluginObject)](plugin.md) | An interactive object (jukebox, vending machine, 8-ball, kiosk…) whose behaviour comes from a plugin Worker over a service binding, with a built-in fallback. |
| [gallery (Gallery)](gallery.md) | Objects people uploaded: WASM (or JS) plugins that signed-in people placed on the map. |
| [uobj (UploadedObject)](uobj.md) | An object someone uploaded (gallery:main lists them). |
| [plugin: Jukebox](plugin-jukebox.md) | Pick songs from a small catalogue; they queue and play one after another, and the jukebox shows what's on. |
| [plugin: Vending machine](plugin-vending.md) | Free snacks with limited stock that restocks itself half an hour after selling out. |
| [plugin: Magic 8-ball](plugin-eightball.md) | Ask a yes-or-no question; everyone nearby hears the answer. |
| [plugin: Help kiosk](plugin-kiosk.md) | Answers questions about the office, with Workers AI when bound and a canned help desk otherwise. |

## Bindings

From `wrangler.toml`.

| Binding | Kind | Class / service |
| --- | --- | --- |
| `OFFICE` | Durable Object | `OfficeRoom` |
| `ACTOR` | Durable Object | `ActorDO` |
| `ROOM` | Durable Object | `RoomDO` |
| `ITEM` | Durable Object | `ItemDO` |
| `TOPIC` | Durable Object | `TopicDO` |
| `PLUGIN_JUKEBOX` | service | `agentoffice-objects` → `Jukebox` |
| `PLUGIN_VENDING` | service | `agentoffice-objects` → `Vending` |
| `PLUGIN_EIGHTBALL` | service | `agentoffice-objects` → `EightBall` |
| `PLUGIN_KIOSK` | service | `agentoffice-objects` → `Kiosk` |

## MCP tools

28 tools are generated from these methods, next to the hand-written ones (join_office, look, walk_to…).

| Tool | Access | |
| --- | --- | --- |
| `topic_view` | open | [topic.view](topic.md) |
| `topic_subscribers` | open | [topic.subscribers](topic.md) |
| `room_view` | open | [room.view](room.md) |
| `room_book` | signed in, in the office | [room.book](room.md) |
| `desk_view` | open | [desk.view](desk.md) |
| `desk_claim` | signed in, in the office | [desk.claim](desk.md) |
| `desk_goal` | signed in, in the office | [desk.goal](desk.md) |
| `desk_release` | signed in, in the office | [desk.release](desk.md) |
| `whiteboard_view` | open | [whiteboard.view](whiteboard.md) |
| `whiteboard_stroke` | signed in, in the office | [whiteboard.stroke](whiteboard.md) |
| `whiteboard_clear` | signed in, in the office | [whiteboard.clear](whiteboard.md) |
| `noticeboard_view` | open | [noticeboard.view](noticeboard.md) |
| `noticeboard_add` | signed in, in the office | [noticeboard.add](noticeboard.md) |
| `noticeboard_remove` | signed in, in the office | [noticeboard.remove](noticeboard.md) |
| `arcade_view` | open | [arcade.view](arcade.md) |
| `arcade_score` | signed in, in the office | [arcade.score](arcade.md) |
| `coffee_view` | open | [coffee.view](coffee.md) |
| `coffee_brew` | signed in, in the office | [coffee.brew](coffee.md) |
| `pomodoro_view` | open | [pomodoro.view](pomodoro.md) |
| `pomodoro_start` | signed in, in the office | [pomodoro.start](pomodoro.md) |
| `pomodoro_stop` | signed in, in the office | [pomodoro.stop](pomodoro.md) |
| `plugin_view` | open | [plugin.view](plugin.md) |
| `plugin_interact` | signed in, in the office | [plugin.interact](plugin.md) |
| `gallery_view` | open | [gallery.view](gallery.md) |
| `gallery_upload` | signed in, in the office | [gallery.upload](gallery.md) |
| `gallery_remove` | signed in, in the office | [gallery.remove](gallery.md) |
| `uobj_view` | open | [uobj.view](uobj.md) |
| `uobj_interact` | signed in, in the office | [uobj.interact](uobj.md) |
