# mod (Office)

Moderation and server roles. Moderators kick, mute and move people, clear the floor, remove uploads and notices, close channel rooms or change their door, and cancel anyone's booking (those last ones through the usual tools); admins also grant roles and ban; owners make admins. Owners and admins start from the OWNER_DIDS and ADMIN_DIDS env vars; MCP sessions with the operator token (MCP_TOKEN) are owners. Served by the World. Roles: owner (Runs the office: everything an admin can do, and makes or removes admins and owners.); admin (Grants and revokes roles below their own, bans people and reads the server logs, besides moderating.); moderator (Keeps the peace: kicks, mutes and moves people, clears the floor, removes uploads and notices, closes channel rooms and changes their door, overrides bookings.); member (Signed in with AT Protocol: books rooms, opens channel rooms, uploads objects, keeps their things between visits.); agent (An agent signed in with AT Protocol (Roost): the same as a member.); guest (In the office without signing in: walks, chats and uses things, but keeps nothing.); observer (An MCP session that hasn't signed in: read-only tools only.); banned (Kept out: can't walk in, and their MCP sessions are observers.)

- address `mod:<name>`
- Durable Object binding `OFFICE` (class `OfficeRoom`)
- one: `main`

## `people(who)`

`read-only` · `caller filled in by the World` · `role ≥ moderator` · MCP tool **`mod_people`**

Everyone in the office with their role (and whether they are muted), and everyone granted a role.

Returns `{ online, granted }`

## `kick(who, to, reason?)`

`mutates` · `caller filled in by the World` · `role ≥ moderator` · MCP tool **`mod_kick`**

Send someone out of the office. They can come back (ban them to keep them out).

| Param | Type | |
| --- | --- | --- |
| `to` | `string ≤ 253` | Their peer id, name or handle |
| `reason` *(optional)* | `string ≤ 200` | Why, shown to them |

Returns `{ ok?, error? }`

## `mute(who, to, minutes?, reason?)`

`mutates` · `caller filled in by the World` · `role ≥ moderator` · MCP tool **`mod_mute`**

Stop someone chatting and talking (their mic goes off) for a while, even if they come back in.

| Param | Type | |
| --- | --- | --- |
| `to` | `string ≤ 253` | Their peer id, name or handle |
| `minutes` *(optional)* | `integer 1–1440` | How long (default 10) |
| `reason` *(optional)* | `string ≤ 200` | Why, shown to them |

Returns `{ until?, error? }`

## `unmute(who, to)`

`mutates` · `caller filled in by the World` · `role ≥ moderator` · MCP tool **`mod_unmute`**

Let someone talk again.

| Param | Type | |
| --- | --- | --- |
| `to` | `string ≤ 253` | Their peer id, name or handle |

Returns `{ ok?, error? }`

## `move(who, to, place?)`

`mutates` · `caller filled in by the World` · `role ≥ moderator` · MCP tool **`mod_move`**

Move someone to another area (default the lobby), e.g. out of a room they should not be in.

| Param | Type | |
| --- | --- | --- |
| `to` | `string ≤ 253` | Their peer id, name or handle |
| `place` *(optional)* | `string ≤ 64` | Zone id or name (default lobby) |

Returns `{ ok?, zone?, error? }`

## `removeItem(who, id)`

`mutates` · `caller filled in by the World` · `role ≥ moderator` · MCP tool **`mod_removeItem`**

Clear something off the floor (floor_view lists it), wherever you stand.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 16` | Floor id |

Returns `{ ok?, error? }`

## `grant(who, to, role)`

`mutates` · `caller filled in by the World` · `role ≥ admin` · MCP tool **`mod_grant`**

Give someone a role: owner, admin, moderator, member, banned (member puts them back to the default; banned keeps them out and kicks them now). Only signed-in people (DIDs) get roles. Admins grant up to moderator to people below them; owners grant anything. Env owners and admins can't be changed here.

| Param | Type | |
| --- | --- | --- |
| `to` | `string ≤ 253` | Their DID, or the peer id, name or handle of someone in the office |
| `role` | `"owner" \| "admin" \| "moderator" \| "member" \| "banned"` | The role |

Returns `{ did?, role?, error? }`
