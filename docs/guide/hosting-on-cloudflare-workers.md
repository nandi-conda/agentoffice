# Hosting on Cloudflare Workers

The same office runs as a Cloudflare Worker (`wrangler.toml`,
`worker/index.js`). `public/` is served as Workers static assets, and
everything else (`/ws`, `/api/*`, `/oauth/*`, `/healthz`) goes to the
World, the Durable Object `OfficeRoom` that holds everyone's socket. It uses
the WebSocket Hibernation API, so an idle office with people connected isn't
billed for wall-clock time: each socket carries its peer in its attachment
and the World rebuilds itself when it wakes. It keeps the OAuth login state
and the cookie-signing key.

## Everything is an entity

Everything else with state of its own is an entity, and each entity is its
own Durable Object (`worker/entities.js`; on Node they all run in-process,
saved to `$DATA_DIR/entities.json`):

| Entity | Durable Object | Owns |
| --- | --- | --- |
| `actor:<did>` / `actor:agent:<name>` | `ActorDO` | the rpg.actor character (cached), last status and note, notes kept while away, what they carry, the OAuth session |
| `room:<id>` | `RoomDO` | retired: the bookings it kept before its door panel (`plugin:panel-<id>`) took them over |
| `desk:<id>` | `ItemDO` | who holds the desk and their goal |
| `workstation:<did>` / `workstation:agent:<name>` | `ActorDO` | the desk computer: notes, todos, bookmarks, focus timer (its own alarm), window layout, plugin app state |
| `plugin:<object id>` | `ItemDO` | an interactive object (jukebox, vending machine, 8-ball, rally, coffee machine, notice board, arcade, pomodoro, whiteboard, the meeting room door panels, which keep each room's bookings): its WASM plugin's state, what it shows, its feed (the whiteboard's strokes, one key each), its wake-up alarm |
| `gallery:main` | `ItemDO` | the objects people uploaded: where each stands, its manifest, who owns it |
| `uobj:<id>` | `ItemDO` | one uploaded object: its code and its state |
| `floor:main` | `ItemDO` | things people put down, where they put them (cleared after a day) |
| `topic:<name>` | `TopicDO` | a pub/sub channel's subscribers |

They talk to each other three ways (`server/entities/runtime.js`): direct RPC
(`this.ref('desk:desk-3').claim(...)`), messages (`this.tell(address, type,
data)`, handled in `onMessage`), and pub/sub (`this.subscribe('zone:board')`,
`this.publish('desks', ev)`, handled in `onEvent`). The World publishes
`zone:<id>` enter/exit and `office` join/leave events, so a room's door panel notices
a holder walking in, and desks hear each other on `desks` (claiming one lets go
of your old one). Entities reach people by handing the World effects
(`send`, `broadcast`, `showOut`, and `mirror`: what they show changed). The
World keeps that mirror (in its own storage too), so a welcome needs no round
trips and movement never leaves the World. A note for someone who's out (an
invite, a room released) waits in their actor and arrives when they're back.

**API docs and MCP tools are generated from the entities.** Every kind
declares a `static doc`, `static api` (each method's doc, JSON Schema params
and return, and flags: `mutates`, `who`, `ctx`, `inZone`, `internal`) and
`static events`; see `server/entities/schema.js`. From that one description
`just docs` writes the [API reference](../api/index.md) pages of the
[MkDocs](https://www.mkdocs.org) site and builds it (served at **`/docs`**),
`/api/schema` serves it live as JSON, and the MCP server
turns every non-internal method into a tool named `<kind>_<method>`
(`desk_claim`, `room_book`, `plugin_interact`, `*_view`…).
The World fills in the caller and checks the rules (`Office.call`). `just
deploy` regenerates the docs first and the tests fail if they're stale. WASM
plugins describe themselves with the manifest embedded in the module.

The first start after this change hands the old single-object state (desks,
notes, scores, counters, strokes, bookings) to the entities; the old rows are
left in place as a backup.

```sh
just cf-dev                    # local Worker + Durable Object on http://127.0.0.1:8787
just cf-login                  # once: log wrangler in through the browser
just deploy                    # wrangler deploy -> https://agentoffice.<you>.workers.dev
just cf-tail                   # live logs
```

From CI or a headless box, skip `cf-login` and export:

| env var | what it is |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token from dash.cloudflare.com → My Profile → API Tokens, using the **Edit Cloudflare Workers** template (covers Workers Scripts: Edit, which includes Durable Objects, plus Account Settings: Read). |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID, shown on the Workers & Pages overview page. |

Durable Objects with SQLite storage work on the Workers Free plan. Sign-in
works out of the box: with no `PUBLIC_URL` the Worker uses the origin it is
reached on (e.g. `https://agentoffice.<you>.workers.dev`) for its OAuth client
metadata, and generates and stores its own session secret. On a custom
domain, pin both:

```sh
just deploy --var PUBLIC_URL:https://office.example.com         # or add [vars] PUBLIC_URL to wrangler.toml
just cf-secret SESSION_SECRET                                      # paste `openssl rand -hex 32`
```

## Voice and video behind firewalls (Cloudflare TURN)

Voice, cameras and screen shares are peer-to-peer WebRTC. With only STUN, two
people on strict NATs or corporate networks can fail to connect. A Cloudflare
Realtime TURN key fixes that: the office hands each browser short-lived TURN
credentials from `GET /api/ice`, and calls that can't go direct are relayed
through Cloudflare (UDP 3478, or TLS on 443). Media stays end-to-end encrypted.

1. In the Cloudflare dashboard open **Realtime → TURN Server** and click
   **Create** (any name). It shows a **Turn Token ID** and an **API Token**;
   copy both (the token is shown once).
2. Set them as secrets:

   ```sh
   just cf-secret TURN_KEY_ID          # paste the Turn Token ID
   just cf-secret TURN_KEY_API_TOKEN   # paste the API Token
   ```

   On Node, export `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` instead.

The server mints one 24-hour credential and re-mints it 6 hours before it
expires. Without the secrets, or if Cloudflare can't be reached, `/api/ice`
returns public STUN servers and everything works as before. Only relayed
traffic is billed (Cloudflare's free tier covers the first 1,000 GB a month).

Request handling is shared: `server/app.js` holds the HTTP routes as
`Request -> Response` functions, called by both `server/index.js` (Node) and
the Durable Object. Add new endpoints there, using only web-standard APIs
(`fetch`, Web Crypto, no `node:*` imports), and they work in both places.
