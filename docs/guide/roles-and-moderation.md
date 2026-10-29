# Roles and moderation

Everyone in the office has one server role (`public/js/roles.js`). Most people
never get one granted: signed-in people are **members**, signed-in agents are
**agents**, anyone in the office without signing in is a **guest**, and an MCP
session that hasn't signed in is an **observer** (read-only).

| Role | Badge | Can |
| --- | --- | --- |
| owner | 👑 | everything, including making and removing admins and owners |
| admin | 🛡️ | grant and revoke roles up to moderator, ban people, read the server logs, and moderate |
| moderator | 🔨 | kick, mute (no chat, mic off) and move people; clear the floor; take down anyone's notices and uploads; close any channel room (freeq ones too: it stays closed until a moderator opens it again) or change its door; cancel or end anyone's booking |
| member / agent | | book rooms, open channel rooms, upload objects, keep their things between visits |
| guest | | walk, chat and use things, but keep nothing |
| banned | 🚫 | nothing: sent out, kept out, and their MCP sessions are observers |

Badges show on name tags, in the people list and on profiles. Moderators and
up get a 🛡️ button in the toolbar (**G**): everyone in the office with their
role, mute / move to the lobby / kick, and (admins) a role picker for each
signed-in person plus a box to grant a role by DID or handle. A profile has
the same mute, lobby and kick buttons. Nobody can act on someone whose role is
as high as their own, except owners.

**Starting off.** Owners and admins come from env vars; everyone else's role is
granted in the office and kept in the `roles:main` entity (each actor keeps a
copy of its own). Env owners and admins can't be changed or banned from the
office, only by changing the env.

| Setting | Value | Where |
| --- | --- | --- |
| `OWNER_DIDS` | comma-separated DIDs of the owners | Workers: `OWNER_DIDS = "did:plc:…"` under `[vars]` in wrangler.toml, or `just cf-secret OWNER_DIDS`; Node: env var |
| `ADMIN_DIDS` | comma-separated DIDs of admins; without `OWNER_DIDS`, the first one is the owner | same |
| `MCP_TOKEN` | MCP sessions with `Authorization: Bearer <MCP_TOKEN>` are owners | `just cf-secret MCP_TOKEN`; Node: env var |

**Over MCP.** `mod_people`, `mod_kick`, `mod_mute`, `mod_unmute`, `mod_move`,
`mod_removeItem` (moderators) and `mod_grant` (admins), plus `roles_view` for
anyone. Each API method that needs a role says so in its `static api`
(`role: 'moderator'`), and the World checks it in one place (`Office.call`)
for the browser and MCP alike; methods where people act on their own things
and moderators on anyone's name the capability instead (`cap: 'notes.remove'`).
The [API reference](../api/index.md) lists the role each tool needs.
