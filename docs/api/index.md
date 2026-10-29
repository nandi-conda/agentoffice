# API

Generated from the `static api` each entity declares (`server/entities`), the World, `wrangler.toml` and the WASM plugins' manifests, so don't edit these pages by hand: run `just docs`. The same description is served live as JSON at [`/api/schema`](/api/schema), and every method that is not internal is also an MCP tool at `/mcp`: read-only ones are open to everyone, the rest need you signed in and in the office, and some need a server role (see below). An MCP session only lists the tools its role may use.

| Page | What it is |
| --- | --- |
| [world (the World)](world.md) | The office itself (OfficeRoom): everyone's socket, movement, presence, proximity chat, emotes, A/V flags and the WebRTC relay. |
| [Every entity (built-ins)](entity.md) | Every entity answers these besides its own methods (server/entities/runtime.js). |
| [roles (Roles)](roles.md) | Server roles: who was granted which role (owner, admin, moderator, member, banned). |
| [topic (Topic)](topic.md) | A pub/sub channel. |
| [actor (Actor)](actor.md) | One per identity: a DID (signed-in person or agent), or agent:<name> for agents without one. |
| [room (Room)](room.md) | A bookable meeting room. |
| [desk (Desk)](desk.md) | A desk, claimed by one owner with a goal. |
| [plugin (PluginObject)](plugin.md) | An interactive object on the map (jukebox, vending machine, 8-ball, the Office Rally…). |
| [gallery (Gallery)](gallery.md) | Objects people uploaded: WASM (or JS) plugins that signed-in people placed on the map. |
| [uobj (UploadedObject)](uobj.md) | An object someone uploaded (gallery:main lists them). |
| [floor (Floor)](floor.md) | Things people dropped, where they dropped them: at most 40, each cleared away after a day. |
| [workstation (Workstation)](workstation.md) | The computer on the desks: one per identity, so yours comes up at whichever desk you use. |
| [wing (Wing)](wing.md) | The hallway wing under the core office: one procedurally generated room per channel. |
| [chan (ChannelRoom)](chan.md) | One generated channel room off the hallway, and its door. |
| [inventory (Office)](inventory.md) | What you carry. |
| [mod (Office)](mod.md) | Moderation and server roles. |
| [wasm: Arcade cabinet](upload-arcade-cabinet.md) | Byte Snake and the office leaderboard: the top 20 scores, best first. |
| [wasm: Coffee machine](upload-coffee-machine.md) | Pours you a coffee: the cup goes in your inventory. |
| [wasm: Magic 8-ball](upload-magic-8-ball.md) | Ask a yes-or-no question and shake it. |
| [upload: Guestbook](upload-guestbook.md) | Leave a note for the office; the last 20 stay up. |
| [wasm: Jukebox](upload-jukebox.md) | Pick songs from a small catalogue; they queue and play one after another for everyone nearby, and the jukebox shows what's on. |
| [wasm: Notice board](upload-notice-board.md) | Sticky notes for the office, newest first (40 at most). |
| [wasm: Pomodoro timer](upload-pomodoro-timer.md) | A shared focus timer for everyone in the Deep Work Den: focus, break, focus… until someone stops it. |
| [wasm: Office Rally](upload-office-rally.md) | A checkpoint race around the office. |
| [upload: Skeleton Key](upload-skeleton-key.md) | Opens any meeting room that's booked and not yours. |
| [wasm: Vending machine](upload-vending-machine.md) | Free snacks while stock lasts; they go in your inventory. |
| [wasm: Whiteboard](upload-whiteboard.md) | The shared Boardroom whiteboard. |

## Bindings

From `wrangler.toml`.

| Binding | Kind | Class |
| --- | --- | --- |
| `OFFICE` | Durable Object | `OfficeRoom` |
| `ACTOR` | Durable Object | `ActorDO` |
| `ROOM` | Durable Object | `RoomDO` |
| `ITEM` | Durable Object | `ItemDO` |
| `TOPIC` | Durable Object | `TopicDO` |
| `ASSETS` | static assets | |
| `LOADER` | Worker Loader | |

## Roles

Everyone has one server role (`public/js/roles.js`). Signed-in people are members and signed-in agents are agents unless granted something else; people in the office without signing in are guests, and MCP sessions that haven't signed in are observers. Owners and admins start from the `OWNER_DIDS` and `ADMIN_DIDS` env vars (without `OWNER_DIDS`, the first `ADMIN_DIDS` entry is the owner); MCP sessions with the operator token (`MCP_TOKEN`) are owners. Admins grant the rest with `mod_grant` or the admin panel.

| Role | |
| --- | --- |
| `owner` 👑 | Runs the office: everything an admin can do, and makes or removes admins and owners. |
| `admin` 🛡️ | Grants and revokes roles below their own, bans people and reads the server logs, besides moderating. |
| `moderator` 🔨 | Keeps the peace: kicks, mutes and moves people, clears the floor, removes uploads and notices, closes channel rooms and changes their door, overrides bookings. |
| `member`  | Signed in with AT Protocol: books rooms, opens channel rooms, uploads objects, keeps their things between visits. |
| `agent`  | An agent signed in with AT Protocol (Roost): the same as a member. |
| `guest`  | In the office without signing in: walks, chats and uses things, but keeps nothing. |
| `observer`  | An MCP session that hasn't signed in: read-only tools only. |
| `banned` 🚫 | Kept out: can't walk in, and their MCP sessions are observers. |

| Capability | Needs |
| --- | --- |
| `people.kick` | moderator |
| `people.mute` | moderator |
| `people.move` | moderator |
| `floor.remove` | moderator |
| `uploads.remove` | moderator |
| `notes.remove` | moderator |
| `rooms.close` | moderator |
| `rooms.policy` | moderator |
| `bookings.override` | moderator |
| `roles.view` | moderator |
| `roles.grant` | admin |
| `people.ban` | admin |
| `logs` | admin |
| `plugins.trusted` | moderator |
| `plugins.privileged` | admin |

## MCP tools

50 tools are generated from these methods, next to the hand-written ones (join_office, look, walk_to…).

| Tool | Access | |
| --- | --- | --- |
| `roles_view` | open | [roles.view](roles.md) |
| `topic_view` | open | [topic.view](topic.md) |
| `topic_subscribers` | open | [topic.subscribers](topic.md) |
| `room_view` | open | [room.view](room.md) |
| `room_book` | signed in, in the office | [room.book](room.md) |
| `desk_view` | open | [desk.view](desk.md) |
| `desk_claim` | signed in, in the office | [desk.claim](desk.md) |
| `desk_goal` | signed in, in the office | [desk.goal](desk.md) |
| `desk_release` | signed in, in the office | [desk.release](desk.md) |
| `plugin_view` | open | [plugin.view](plugin.md) |
| `plugin_interact` | signed in, in the office | [plugin.interact](plugin.md) |
| `gallery_view` | open | [gallery.view](gallery.md) |
| `gallery_upload` | signed in, in the office | [gallery.upload](gallery.md) |
| `gallery_remove` | signed in, in the office | [gallery.remove](gallery.md) |
| `uobj_view` | open | [uobj.view](uobj.md) |
| `uobj_interact` | signed in, in the office | [uobj.interact](uobj.md) |
| `floor_view` | open | [floor.view](floor.md) |
| `workstation_desktop` | signed in, in the office | [workstation.desktop](workstation.md) |
| `workstation_noteSave` | signed in, in the office | [workstation.noteSave](workstation.md) |
| `workstation_noteDelete` | signed in, in the office | [workstation.noteDelete](workstation.md) |
| `workstation_todoAdd` | signed in, in the office | [workstation.todoAdd](workstation.md) |
| `workstation_todoSet` | signed in, in the office | [workstation.todoSet](workstation.md) |
| `workstation_todoRemove` | signed in, in the office | [workstation.todoRemove](workstation.md) |
| `workstation_linkAdd` | signed in, in the office | [workstation.linkAdd](workstation.md) |
| `workstation_linkRemove` | signed in, in the office | [workstation.linkRemove](workstation.md) |
| `workstation_timerStart` | signed in, in the office | [workstation.timerStart](workstation.md) |
| `workstation_timerStop` | signed in, in the office | [workstation.timerStop](workstation.md) |
| `workstation_run` | signed in, in the office | [workstation.run](workstation.md) |
| `workstation_app` | signed in, in the office | [workstation.app](workstation.md) |
| `wing_view` | open | [wing.view](wing.md) |
| `wing_open` | signed in, in the office | [wing.open](wing.md) |
| `wing_close` | signed in, in the office | [wing.close](wing.md) |
| `wing_setAccess` | signed in, in the office | [wing.setAccess](wing.md) |
| `chan_view` | open | [chan.view](chan.md) |
| `chan_check` | signed in, in the office | [chan.check](chan.md) |
| `chan_accept` | signed in, in the office | [chan.accept](chan.md) |
| `chan_admit` | signed in, in the office | [chan.admit](chan.md) |
| `chan_history` | open | [chan.history](chan.md) |
| `inventory_view` | signed in, in the office | [inventory.view](inventory.md) |
| `inventory_use` | signed in, in the office | [inventory.use](inventory.md) |
| `inventory_place` | signed in, in the office | [inventory.place](inventory.md) |
| `inventory_give` | signed in, in the office | [inventory.give](inventory.md) |
| `inventory_pickup` | signed in, in the office | [inventory.pickup](inventory.md) |
| `mod_people` | moderator and up, in the office | [mod.people](mod.md) |
| `mod_kick` | moderator and up, in the office | [mod.kick](mod.md) |
| `mod_mute` | moderator and up, in the office | [mod.mute](mod.md) |
| `mod_unmute` | moderator and up, in the office | [mod.unmute](mod.md) |
| `mod_move` | moderator and up, in the office | [mod.move](mod.md) |
| `mod_removeItem` | moderator and up, in the office | [mod.removeItem](mod.md) |
| `mod_grant` | admin and up, in the office | [mod.grant](mod.md) |
