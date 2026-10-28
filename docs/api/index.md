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

## Bindings

From `wrangler.toml`.

| Binding | Kind | Class / service |
| --- | --- | --- |
| `OFFICE` | Durable Object | `OfficeRoom` |
| `ACTOR` | Durable Object | `ActorDO` |
| `ROOM` | Durable Object | `RoomDO` |
| `ITEM` | Durable Object | `ItemDO` |
| `TOPIC` | Durable Object | `TopicDO` |

## MCP tools

21 tools are generated from these methods, next to the hand-written ones (join_office, look, walk_to…).

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
