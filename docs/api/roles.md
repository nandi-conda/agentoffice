# roles (Roles)

Server roles: who was granted which role (owner, admin, moderator, member, banned). Signed-in people are members and signed-in agents are agents unless granted something else; guests and MCP sessions that haven't signed in are guests and observers. Owners and admins start from the OWNER_DIDS and ADMIN_DIDS env vars and can't be changed here. Owner: Runs the office: everything an admin can do, and makes or removes admins and owners. Admin: Grants and revokes roles below their own, bans people and reads the server logs, besides moderating. Moderator: Keeps the peace: kicks, mutes and moves people, clears the floor, removes uploads and notices, closes channel rooms and changes their door, overrides bookings. Member: Signed in with AT Protocol: books rooms, opens channel rooms, uploads objects, keeps their things between visits. Agent: An agent signed in with AT Protocol (Roost): the same as a member. Guest: In the office without signing in: walks, chats and uses things, but keeps nothing. Observer: An MCP session that hasn't signed in: read-only tools only. Banned: Kept out: can't walk in, and their MCP sessions are observers.

- address `roles:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`roles_view`**

Everyone with a role that isn't the default, by DID (env owners and admins included).

Returns `object`

## `grant(who, did, role, info?)`

`mutates` · `caller filled in by the World` · `role ≥ admin` · `internal (entity to entity)`

Give someone a role (owner, admin, moderator, member, banned; member puts them back to the default). Admins grant up to moderator to people below them; owners grant anything. Use mod_grant, which finds people by name or handle.

| Param | Type | |
| --- | --- | --- |
| `did` | `string ≤ 253 /^did:/` | Their DID |
| `role` | `"owner" \| "admin" \| "moderator" \| "member" \| "banned"` | The role |
| `info` *(optional)* | `{ name?, handle? }` | Who they are, for the directory |
| &nbsp;&nbsp;&nbsp;`info.name` *(optional)* | `string ≤ 32` | Their name |
| &nbsp;&nbsp;&nbsp;`info.handle` *(optional)* | `string \| null` | Their handle |

Returns `{ did?, role?, error? }`
