# room (Room)

A bookable meeting room. Keeps its own bookings, wakes itself for reminders and start/end announcements, keeps everyone but the meeting out while it runs, releases rooms nobody turned up to, and listens on its zone topic for people coming in. Notes for a booking's owner go to their actor, so they get them even when away.

- address `room:<name>`
- Durable Object binding `ROOM` (class `RoomDO`)
- 5: `booth1`, `booth2`, `booth3`, `board`, `huddle`

## `view()`

`read-only` · MCP tool **`room_view`**

Its bookings (a day of history included).

Returns `{ id, room, title, start, end, owner, name, invitees, lock, autoRelease }[]`

## `book(who, m, ctx)`

`mutates` · `caller filled in by the World` · `ctx { all, presence } filled in by the World` · `moderators may for anyone (bookings.override)` · MCP tool **`room_book`**

Create, cancel, extend, end, update a booking, or admit someone knocking. 15 min to 4 h, up to 14 days ahead, no overlaps; only the owner may change a booking (moderators can cancel or end anyone's).

| Param | Type | |
| --- | --- | --- |
| `m` | `{ op, id?, title?, start?, end?, minutes?, invitees?, lock?, autoRelease?, to? }` | What to do |
| &nbsp;&nbsp;&nbsp;`m.op` | `"create" \| "cancel" \| "extend" \| "end" \| "update" \| "admit"` | create, cancel, extend, end, update or admit |
| &nbsp;&nbsp;&nbsp;`m.id` *(optional)* | `string ≤ 16` | Booking id (all ops but create) |
| &nbsp;&nbsp;&nbsp;`m.title` *(optional)* | `string ≤ 80` | Title |
| &nbsp;&nbsp;&nbsp;`m.start` *(optional)* | `integer \| string` | ms since epoch, or "now" |
| &nbsp;&nbsp;&nbsp;`m.end` *(optional)* | `integer ≥ 0` | ms since epoch |
| &nbsp;&nbsp;&nbsp;`m.minutes` *(optional)* | `integer 5–240` | Length for create (15..240), or how much to extend by (5..120) |
| &nbsp;&nbsp;&nbsp;`m.invitees` *(optional)* | `string ≤ 253[] (≤ 20)` | Invitees |
| &nbsp;&nbsp;&nbsp;`m.lock` *(optional)* | `boolean` | Ignored: every booking keeps everyone but its holders out |
| &nbsp;&nbsp;&nbsp;`m.autoRelease` *(optional)* | `boolean` | Free the room if nobody turns up within 10 minutes (default true) |
| &nbsp;&nbsp;&nbsp;`m.to` *(optional)* | `string ≤ 64` | Peer id to let in (admit) |

Returns `{ booking?, error? }`

## `unlock(who, by)`

`mutates` · `internal (entity to entity)`

Let someone into the meeting running now, past the booking, as if a holder had let them in: what a plugin with the unlock permission (e.g. the Skeleton Key) does for whoever uses it. The people in the meeting are told.

| Param | Type | |
| --- | --- | --- |
| `who` | `{ id, key, name, handle?, did?, kind?, zone?, role?, x?, y? }` | The person calling, filled in by the World |
| &nbsp;&nbsp;&nbsp;`who.id` | `string ≤ 200` | Peer id in the office |
| &nbsp;&nbsp;&nbsp;`who.key` | `string ≤ 200` | Owner key: a DID, agent:<name> or human:<id> |
| &nbsp;&nbsp;&nbsp;`who.name` | `string ≤ 200` | Display name |
| &nbsp;&nbsp;&nbsp;`who.handle` *(optional)* | `string ≤ 200` | AT Protocol handle |
| &nbsp;&nbsp;&nbsp;`who.did` *(optional)* | `string ≤ 200` | DID |
| &nbsp;&nbsp;&nbsp;`who.kind` *(optional)* | `string ≤ 200` | human, agent or freeq |
| &nbsp;&nbsp;&nbsp;`who.zone` *(optional)* | `string ≤ 200` | Zone they stand in |
| &nbsp;&nbsp;&nbsp;`who.role` *(optional)* | `string ≤ 200` | Their server role: owner, admin, moderator, member, agent, guest (public/js/roles.js) |
| &nbsp;&nbsp;&nbsp;`who.x` *(optional)* | `number ≥ 0` | Where they stand, in tiles |
| &nbsp;&nbsp;&nbsp;`who.y` *(optional)* | `number ≥ 0` | Where they stand, in tiles |
| `by` | `string ≤ 40` | What let them in |

Returns `object`

## `tick(opts?)`

`mutates` · `internal (entity to entity)`

Send due reminders and announcements, release no-shows. Safe to call as often as you like; the alarm calls it.

| Param | Type | |
| --- | --- | --- |
| `opts` *(optional)* | `{ presence }` |  |
| &nbsp;&nbsp;&nbsp;`opts.presence` | `{ id, key, name, handle?, did?, kind?, zone?, role?, x?, y? }[]` | Who is in |

## Events

- subscribes `zone:<room>`: enter: a holder turning up keeps the booking from being released
