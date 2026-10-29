# Agent Office

A virtual coworking office where people and AI agents work side by side, in
the spirit of Gather. Everyone walks around as their
[rpg.actor](https://rpg.actor) character, which is loaded live from their own
AT Protocol PDS.

![The open office during the day](docs/day.png)

## Run it

The toolchain (Node 22 and npm) is managed by [pixi](https://pixi.sh), and
tasks live in a [justfile](https://just.systems). You need pixi and just
installed; every recipe runs through `pixi run`, so no Node on your PATH is
needed and the env is created on first use.

```sh
just install                   # npm ci
just start                     # http://127.0.0.1:8080 (PORT=3000 just start to change)
just dev                       # same, restarting on file changes
just agent                     # optional: a demo agent coworker joins
just demo                      # server + demo agent together
just mcp-add                   # register the office's MCP server with Claude Code
just roost signup my-agent --accept-terms   # AT Protocol identity for an agent on Roost
just test                      # unit tests (node:test)
just                           # list every recipe (docker-build, docker-run, clean…)
```

**Docs.** `just docs` builds the [MkDocs](https://www.mkdocs.org) (Material)
site into `public/docs`, served at **`/docs`** by both the Node server and the
Worker: this README, one page per section, plus an API reference generated
from the code. Don't edit `docs/index.md`, `docs/guide/`, `docs/api/` or
`mkdocs.yml` by hand; edit this README or the entities' `static api` and run
`just docs` (the tests fail when they're stale). MkDocs runs through
`pixi exec`, so it needs no Python setup either.

`pixi run start`, `pixi run test` and friends also work if you don't have just. Recipes install npm deps on first run if `node_modules` is missing.
Plain `npm install && npm start` still works with your own Node 22+.

Runtime dependencies are `ws` and the AT Protocol OAuth client (`@atproto/oauth-client` + friends). Office state (desks,
notes, whiteboard, high scores) is saved to `data/state.json`; set `DATA_DIR`
to move it. There's also a `Dockerfile`.

## Signing in (AT Protocol OAuth)

Type your handle and press **Sign in**: you're sent to your own PDS (Bluesky
or any other) to approve, and come back signed in. The server only trusts
DIDs that finished that flow; a handle sent any other way is ignored, so
nobody can walk in as someone else. Leave the handle empty to walk in as a
guest. We only ask for the `atproto` scope (identity, no posting). What
the browser keeps is a signed, HttpOnly cookie holding your DID for 30 days;
the server keeps the OAuth session (DPoP key + refresh token, still only
`atproto`) so it can prove who you are to freeq (see *freeq*), and revokes it
when you sign out.

Configuration (all optional):

| env var | what it does |
| --- | --- |
| `PUBLIC_URL` | Public origin when deployed, e.g. `https://office.example.com`. The server then serves its OAuth client metadata at `$PUBLIC_URL/oauth/client-metadata.json` and uses `$PUBLIC_URL/oauth/callback`. Must be HTTPS and reachable by PDSes. Unset means local dev. |
| `SESSION_SECRET` | Key that signs the session cookie (any long random string, e.g. `openssl rand -hex 32`). Unset: one is generated and kept in `$DATA_DIR/session-secret`. Set it if you run more than one instance or have no persistent `DATA_DIR`. |

Local dev needs nothing: without `PUBLIC_URL` the server uses an AT Protocol
*loopback client* (`client_id` `http://localhost?...`), which PDSes accept
without hosted metadata. The redirect must go to `127.0.0.1`, so open
**http://127.0.0.1:8080** (visiting `localhost:8080` works too; sign-in hops
you over).

`server/auth.js` only uses `fetch`, `Request`/`Response` and Web Crypto, so it
runs unchanged on Cloudflare Workers, where the Durable Object passes it
SQLite-backed state and session stores (see *Hosting on Cloudflare Workers*). Handles are resolved
over DNS-over-HTTPS (Cloudflare, then Google), then `/.well-known/atproto-did`,
then the public Bluesky resolver; DID documents come from plc.directory or
`did:web`. This lives in `server/atproto.js` rather than the @atproto resolvers,
which build `redirect: 'error'` requests that Workers reject.

## Hosting on Cloudflare Workers

The same office runs as a Cloudflare Worker (`wrangler.toml`,
`worker/index.js`). `public/` is served as Workers static assets, and
everything else (`/ws`, `/api/*`, `/oauth/*`, `/healthz`) goes to the
World, the Durable Object `OfficeRoom` that holds everyone's socket. It uses
the WebSocket Hibernation API, so an idle office with people connected isn't
billed for wall-clock time: each socket carries its peer in its attachment
and the World rebuilds itself when it wakes. It keeps the OAuth login state
and the cookie-signing key.

### Everything is an entity

Everything else with state of its own is an entity, and each entity is its
own Durable Object (`worker/entities.js`; on Node they all run in-process,
saved to `$DATA_DIR/entities.json`):

| Entity | Durable Object | Owns |
| --- | --- | --- |
| `actor:<did>` / `actor:agent:<name>` | `ActorDO` | the rpg.actor character (cached), last status and note, notes kept while away, what they carry, the OAuth session |
| `room:<id>` | `RoomDO` | retired: the bookings it kept before its door panel (`plugin:panel-<id>`) took them over |
| `desk:<id>` | `ItemDO` | who holds the desk and their goal |
| `workstation:<did>` / `workstation:agent:<name>` | `ActorDO` | the desk computer: notes, todos, bookmarks, focus timer (its own alarm), window layout, plugin app state |
| `plugin:<object id>` | `ItemDO` | an interactive object (jukebox, vending machine, 8-ball, rally, coffee machine, notice board, arcade, pomodoro, whiteboard, reception desk, the meeting room door panels, which keep each room's bookings): its WASM plugin's state, what it shows, its feed (the whiteboard's strokes, one key each), its wake-up alarm |
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
`just docs` writes the [API reference](docs/api/index.md) pages of the
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

### Voice and video behind firewalls (Cloudflare TURN)

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

## What's in the office

| Area | What it's for |
| --- | --- |
| **Lobby** | Spawn point, reception desk with live office counters (☕ coffees, 🍅 pomodoros, 👋 waves) and a bell to ring, and the **notice board**: pin sticky notes that stay up between visits. The **Office Rally** flag: join a checkpoint race around the office, walk the route, win medals. |
| **Open Office** | 26 desks. Walk up to one and **claim a desk**: your name goes on it, your monitor lights up while you're in, and your "working on" note is attached to it. Chat and voice are proximity-based. |
| **Boardroom** | Private glass **A/V room** for 8, bookable. Everyone inside hears everyone inside and nobody outside, and can turn on their camera or share their screen. It has a **live shared whiteboard**, which is also drawn on the wall in the world, and a wall screen. |
| **Huddle Room** | Smaller bookable **A/V room** for 4 with a wall screen. |
| **Phone Booths** | Three single-person private booths, bookable (voice only). |
| **Deep Work Den** | Quiet zone: text only, no voice, and a **shared pomodoro** on the tomato clock (25/5, 50/10 or 15/3). While a session runs, everyone inside is automatically set to *Focusing*. |
| **Kitchen** | Coffee machine. Grabbing a coffee puts a mug in your hand for a few minutes and nudges people nearby that you're up for a coffee chat. A **vending machine** with free snacks (and limited stock). |
| **Lounge** | Sofas, beanbags, bookshelf and two arcade cabinets running **Byte Snake** with an office-wide leaderboard. A **jukebox** everyone can queue songs on, and a **magic 8-ball**. |

### Interactive objects (plugins)

The jukebox, vending machine, magic 8-ball and the **Office Rally** flag are WASM plugins: Rust crates in `plugins/wasm-*` built with the
agentoffice-plugin crate into `public/plugins/*.wasm`, and run in the same
sandbox as uploaded objects (a Dynamic Worker on Cloudflare, a worker thread
on Node). Each is an item entity that hands the module who used it, what they
picked and the object's saved state, and gets back new state, a speech
bubble, a label and a small panel. The rally asks the office to `watch` the route's zones (walking into one calls it
back), runs on the object's Durable Object alarms and hands out medals.
Writing your own: [docs/plugins.md](docs/plugins.md).

### Uploaded objects

Signed-in people can upload a plugin of their own from the browser (**U**,
or 🧩 in the toolbar) and drop it on the floor next to them: a WebAssembly
module speaking a small JSON ABI, or on Cloudflare a JS module. It follows the
same contract as the office's own objects. Uploads never run inside the office: on
Cloudflare each one is its own Dynamic Worker with no network (needs the
Worker Loader binding, Workers Paid plan), on Node a worker thread with a time
limit. Only the uploader (or a moderator) can remove one. How it
works and how to write one: [docs/uploads.md](docs/uploads.md).

### Things you carry

Press **I** (or the 🎒 button) for your inventory. Things come from objects:
the coffee machine pours you a **coffee** in a cup you take with you, and the
vending machine drops the **snack** you picked into your hands. Use them
(drink, eat, chew; everyone in earshot sees it and you pull a face), hand one
to someone within 3 tiles, or **place** it: choose Place, and the floor
tiles within 3 steps that you can reach light up; click or tap one to put
it there (one at a time from a stack), Esc or the pill at the bottom to stop.
Walls, furniture, a spot something already lies on and booked rooms you're
kept out of are refused, here and on the server. Placed things lie on the
floor for everyone, bob a little, and anyone can walk up and press E (or tap
them) to pick them up; the cleaners take whatever is left after a day.
The 🗑️ button throws something away for good (one or the whole stack, after
a confirm); nothing lands on the floor. Signed-in people and agents keep their things between visits, on their actor
(up to 20 stacks); guests carry 6 things for the visit only. Agents get the
same rules as MCP tools: `inventory_view`, `inventory_use`, `inventory_give`,
`inventory_place` (with `x`, `y`, or at your feet without), `inventory_pickup`,
`inventory_destroy` and `floor_view`.

Plugins see what the person carries and can hand out or use up items in
their answer (`give`, `take`); see [docs/plugins.md](docs/plugins.md). The
item kinds the office knows how to use are in `public/js/items.js`. Items
live in the office, not on your PDS: rpg.actor has no items lexicon yet, and
writing to a PDS would need a wider sign-in scope than the office asks for.

### The desk computer

Walk up to any desk and press **E** (on a phone, tap the prompt) to pull up your
**workstation**: a small desktop with windows and a taskbar. It is yours,
not the desk's, so the same one comes up at whichever desk you use.

- **Notes** (saved as you type), **Todo**, **Focus timer** (a countdown ring on the wallpaper while it runs; it rings even if
  you've walked off or left: the note waits in your actor), **Calendar**
  (meeting room bookings, yours highlighted), **Browser** (bookmarks, office
  pages, any site that allows being framed, ↗ for the rest) and
  **Terminal**, an office shell: `who`, `desks`, `rooms`, `todo add …`,
  `jot …`, `cat 1`, `timer 25 writing`, `open notes`, `help`.
- **Things**: your inventory, the same panel as **I**.
- **Desk monitor**: share your screen to your desk's monitor, and people
  standing within a few steps (with audio on) can watch it.
- Apps that run on WASM plugins (**Magic 8-Ball**) use
  the same contract and declarative panels as the objects on the map; list
  more in `public/js/apps.js`. Built-in apps register with `registerApp`
  in `public/js/workstation.js`.
- Others see your monitor light up with windows while you're on it. Walking
  away switches it off and ends a desk share.
- Signed-in people and agents keep theirs in a `workstation` entity; a
  guest's lives with their connection and is gone when they leave. Agents use
  theirs through the `workstation_*` MCP tools (`take_desk` first).
- What it does (notes, todos, bookmarks, the timer, the shell) is a WASM
  program, `plugins/wasm-workstation` built to `public/plugins/workstation.wasm`,
  run in the same sandbox as the objects. The `workstation` entity is its
  host: it keeps the state, checks it's yours and that you're at a desk,
  rings the timer through your actor, keeps the window layout and hands the
  shell what it prints about the office. The window manager, desk monitor
  sharing and seating stay in the browser and the World.

### Talking

- **Proximity chat and voice.** In open areas you reach anyone within a few
  steps. Voice is peer-to-peer WebRTC with distance falloff; the server only
  relays signalling (and hands out Cloudflare TURN relays when configured, see
  *Voice and video behind firewalls*).
- **Rooms are private.** Inside a room, chat and voice stay in the room.
- `/shout …` reaches the whole office. `@name …` (display name without spaces, full handle like
  `@ada.bsky.social`, or just `@ada`) taps someone wherever they
  are (they get a notification with a "walk over" button).
- Wave at or knock on someone from their profile card, follow them, or walk
  over with one click.

### Meeting rooms

The Boardroom, Huddle Room and the three phone booths can be booked.

- **Book** from the 📅 button (or `B`): a day timeline of every room, then
  pick a room, time, length (15 min to 4 h, up to 14 days ahead), title and
  invitees. Or press `E` at the little tablet by a room's door for what's on
  now, what's next and **Book now**. You need to be signed in to book;
  guests can see the schedule.
- **In the world**, each room has a status tag in its corner (free, free
  until 15:00, or the meeting and when it ends), the door tablet glows
  green, amber or red, and the wall screens show the current meeting.
- **Holders** are the booker, invitees (by handle or DID; agents by name)
  and anyone let in. While a booking runs nobody else gets in (people and
  agents alike, enforced by the server): they bump into the door, anyone
  inside when it starts (or who got in some other way) is shown out, and
  they can **knock**, which gives someone inside a **Let in** button.
- **Reminders**: holders get a heads-up 5 minutes before and at the start
  (with a "walk there" button), people in the room get a 5-minute warning
  (and who's next), and the booker can **extend** by 15 minutes or **end**
  early. If no holder turns up within 10 minutes the room is released
  (untick "release" to keep it).
- **Under the hood** each room's door panel is a WASM plugin
  (`plugins/wasm-rooms`) that keeps the room's bookings and all of the above
  rules, reminders and releases; the office keeps the door (bouncing and
  showing out non-holders) from the schedule the panels show.

**A/V rooms.** Inside the Boardroom or Huddle Room the camera and screen
share buttons appear (`C` toggles the camera). They ride on the same
peer-to-peer WebRTC connections as voice, but only between people in that
room, and stop when you walk out. Tiles show at the top left (⤢ enlarges
one), and a screen being shared also plays on the room's wall screen.
Turning on the camera or a share without voice joins the call listen-only
if the mic is refused.

![A booking in the Boardroom: camera tiles, a screen share on the wall screen](docs/av-room.png)
![The room schedule](docs/room-schedule.png)

### Channel rooms

Under the core office runs a hallway, and every channel gets its own
procedurally generated room off it. Doors in the bottom wall of the Lobby,
Kitchen and Lounge lead down to the main hallway; halls branch south from it,
each with up to three rows of rooms on both sides. A new channel takes the
first free slot, a hall grows south as its rows fill, and a new hall opens
further east once one is full (24 rooms at most). A room's size follows the
channel's member count (small under 4, medium under 9, large after), and its
look (floor, furniture, plants, shelves) is seeded by the channel name, so
`#general` looks the same for everyone, every time. Nothing is moved while
anyone is inside: a room only resizes when empty, and a channel nobody wants
any more keeps its room for half an hour, then it's archived (its slot is
kept for it if it comes back).

Rooms are fed by **channel sources**, not by freeq itself: the `wing:main`
entity takes `offer(source, channels)` from anything that knows of channels,
and people (signed in) and agents can open one themselves from the *Channel
rooms* panel (`＋ Open a room…`, or `wing_open` over MCP). freeq is one such
source (below); the office runs the same without it. Each room is its own
entity, `chan:<id>` (a Room Durable Object): it keeps the last 40 lines said
inside and shows them to whoever walks in.

**Access policies.** A room's door follows its channel's access policy. The
sign beside the door shows it (🚪 open, 📜 accept rules, 🔒 invite only,
🎫 credential); press E at it or click it for the full policy, whether you may
come in, and how: accept the rules there, knock so someone inside lets you in,
or get the credential from the source. The World checks the door every time
anyone steps in, people and agents alike (an agent gets the same bounce, and
`chan_check` / `chan_accept` over MCP). The policy language is freeq's
(`OPEN`, `ACCEPT`, `PRESENT`, `PROVE`, `ALL`, `ANY`, `NOT`, see
`public/js/policy.js`) plus `INVITE` for rooms opened in the office, which
can be open, rules-to-accept or invite-only. People the source already lets
into the channel (for freeq: everyone we've seen in it with an account) skip
the door, banned DIDs never get in, and anything the office can't check
(credentials, proofs) stays shut until the source vouches for you.

![Channel rooms off the hallway, with their door signs](docs/channel-rooms.png)
![The #freeq door sign: accept its code of conduct to go in](docs/channel-sign.png)

### freeq

The office is bridged to [freeq](https://freeq.at), an IRC network whose
accounts are AT Protocol identities. Populated freeq channels (2+ people
besides us, the busiest 12) each get a channel room, and so does `#freeq`,
which isn't in freeq's public list. Each comes with its freeq access policy
(`GET /api/v1/policy/{channel}` and its rules text): `#freeq` asks you to
accept its code of conduct, and the sign lists its op role (GitHub
collaborators on chad/freeq). A channel's room
wears the channel's name on its sign, the channel's people stand in it (wearing
their rpg.actor character when they have one), what they say shows up as chat
there, and the whole area hears it. Someone in several attached
channels is one person: they stand in the area of the channel they last
spoke in (or the first one we saw them in), walk over when they speak in
another, and their status note lists the other channels (`#dev · also
#general`). freeqworld doesn't need this, since you only ever see one
channel-room at a time there; the office shows every room at once. A room stays attached while anyone is
still in the channel, and the list (and the policies) are refreshed every five minutes.

When you're signed in, what you say in a channel's room goes to the channel
**as you**: the server opens an IRC connection for you and signs in with
SASL `ATPROTO-CHALLENGE`, method `pds-oauth`, i.e. the access token from your
office sign-in plus a DPoP proof for your PDS's `getSession`, which freeq
checks with your PDS. If you signed in before this existed, sign out and in
again.

Guests (people who haven't signed in) talk on freeq the way freeq's own
guests do: the server opens a connection for them without SASL, under the
name they walked in with. freeq only lets guests into channels that have no
access policy, so in a policy-gated room (#freeq, for one) a guest's chat
stays in the office and they're told to sign in. At most 16 guest
connections are open at once.

Agents talk on freeq too. One that signed in with a bearer token (an MCP
`Authorization: Bearer rmcp_…` header, or `roost_sign_in`) does so as its own
DID: the office keeps the token in memory (never on disk) and signs in with
SASL method `pds-session`, which freeq checks against the agent's PDS. An agent
without a token (DID proof record, or none at all) gets a `did:key` of its own,
derived from the office's key and the agent's identity, so it's the same one
every time.

**Voice and video in a bridged room are the channel's freeq call**, so people
in freeq's own apps are on the same call. Turn voice on in the room and the
server joins (or starts) the channel's call on your freeq connection
(`+freeq.at/av-join` / `av-start` TAGMSGs; freeq replies with the session and
a MoQ token). Your browser then publishes one broadcast,
`{session}/{nick}~{instance}`, and watches everyone else's, straight to
freeq's media server at `wss://irc.freeq.at/av/moq` (MoQ, Media over QUIC,
here over WebSocket), with the same `<moq-publish>` / `<moq-watch>` builds
freeq's web app uses (`public/vendor/moq/`). Who's on the call comes from
`GET /api/v1/sessions/{id}` and shows as tiles at the top left. The camera
button turns your camera on in the call, and **Share screen** publishes your
screen as a second broadcast, `{session}/{nick}~{instance}/screen` (video
only, H.264), the same way freeq's app does, so freeq's clients see it too.
Someone's screen shows up as a large tile once their broadcast goes live.

The office never depends on it: guests, rooms freeq isn't bridging right now,
and any join that fails use the office's own WebRTC voice (with TURN when
configured) instead, and two people who are both on the freeq call skip their
WebRTC link so nobody is heard twice. Two caveats, shown in the call tile:
freeq's own notes say audio over its WebSocket path can crackle under steady
use (its WebTransport path isn't working for browsers yet), and its media
server doesn't require tokens yet, so others on freeq could listen in. The
Boardroom, Huddle Room, booths and open areas always use WebRTC.

Reading is done by one listener connection with the office's own `did:key`
(an ed25519 key made on first run, `$DATA_DIR/freeq-key.json`, or the Durable
Object's storage). It only runs while somebody is in the office, and hangs up
two minutes after the last person leaves, so the Durable Object can sleep.

| env var | what it does |
| --- | --- |
| `FREEQ` | `off` disables the bridge. |
| `FREEQ_URL` | IRC-over-WebSocket endpoint, default `wss://irc.freeq.at/irc`. The channel list comes from the same host's `/api/v1/channels`. |
| `FREEQ_ROOMS` | Attach channels to core areas instead of giving them rooms, e.g. `lounge=#general,open=#dev` (any zone id works). |
| `FREEQ_CHANNELS` | Channels that always get a room, whatever their size or listing, default `#freeq`; empty for none. |
| `FREEQ_MIN_MEMBERS` | People a channel needs (not counting us) to be attached, default 2. |


### Status

Available, Focusing, In a meeting, Coffee break, Away. Status changes
automatically when you walk into a meeting room, join a focus session, grab a
coffee, or leave the tab in the background for five minutes, and goes back
when you leave.

## Roles and moderation

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
The [API reference](docs/api/index.md) lists the role each tool needs.

## rpg.actor characters

Sign in with your handle on the way in. The server resolves your DID (DNS / `.well-known`
/ public resolver → DID document → PDS) and reads, from your own PDS only:

- `actor.rpg.sprite/self`: your sprite sheet (3×4 grid of 48px frames: rows
  down/left/right/up, columns step/idle/step) and your **emote sheets**.
  Pressing 1-9 plays your own rpg.actor emotes (happy, sad, silly, tired…),
  and the matching **talk sheet** animates your mouth when you chat or speak
  on voice.
- `actor.rpg.stats`: your character sheets, shown on your profile card.
- `app.bsky.actor.profile/self`: display name and bio.

Blobs are proxied through `/api/blob` (cached) so the browser can read
pixels to draw on the canvas.

People without an rpg.actor sprite (guests, agents, freeq nicks) get a stock
rpg.actor character instead, built from the
[Sprite Generator](https://rpg.actor/generator)'s own parts: body, face,
hair, clothes, and for agents a lanyard keycard and goggles. The look is
picked deterministically from the DID or name, so someone looks the same
everywhere, and the parts are recoloured the way the generator does it
(`public/js/stock.js`). The parts come through `/api/stock/…`, a cached
allowlisted proxy for `rpg.actor/assets/generator/`. If rpg.actor can't be
reached, a simple drawn character in the same sheet format stands in.

Sprite Generator artwork © isilme
([@isilme.reverie.house](https://bsky.app/profile/isilme.reverie.house)),
used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) as
credited on [rpg.actor/licenses](https://rpg.actor/licenses). The stock
characters are recoloured composites of that art.

A handle is only shown if it resolves back to the same DID (bidirectional
check), so a DID document can't claim someone else's handle. The handle box
still previews anyone's character before you sign in, via `/api/actor`.

## The art style

The office is drawn entirely as vector shapes on a canvas every frame
(furniture, soft shadows, sunlight through the north windows, desk lamps), so
it stays sharp at any zoom or pixel density. Lighting follows your local
clock: morning light, golden hour, and a lamp-lit office at night (add
`?hour=21` to the URL to preview).

Characters are the rpg.actor pixel sprites themselves, drawn at whole-number
scale so they stay crisp.

![The lounge at night](docs/night.png)

## Agents

Agents are first-class coworkers: they appear with an AGENT badge, claim
desks, set status, walk around using the same pathfinder, and receive
`@mentions` from anywhere in the office.

```js
import { AgentClient } from './scripts/agent-sdk.mjs';

const bot = new AgentClient({ url: 'ws://localhost:8080/ws', name: 'BuildBot' });
await bot.connect();
await bot.takeDesk('watching CI');
bot.on('mention', (m) => bot.say(`@${m.name} build is green ✅`));
```

`scripts/agent.mjs` is a demo bot that answers `@StandupBot standup` (posts
everyone's notes), `come here`, `coffee` and `focus`.

Agents can book rooms too (an agent's bookings belong to its name, or its DID
when signed in):

```js
console.log(bot.rooms());                     // [{ id: 'board', av: true, state: 'free', current, next, … }]
const b = await bot.book({ room: 'huddle', start: new Date(Date.now() + 3600e3), minutes: 30,
  title: 'Retro', invitees: ['ada.bsky.social'] });
await bot.extendBooking(b.id, 15);            // also cancelBooking, endBooking, updateBooking
bot.on('roomnote', (m) => console.log(m.text)); // reminders and start/end notices
```

`GET /api/rooms` returns every room's live status and the upcoming bookings.

### MCP server (for Claude and other AI agents)

The office serves an [MCP](https://modelcontextprotocol.io) endpoint at
**`/mcp`** using the Streamable HTTP transport, on both the Node server and the
Cloudflare Worker. Each MCP session is one agent in the office, so any MCP
client can join, walk around, use a desk, talk and listen.

**Access.** People sign in with their own AT Protocol identity over
[OAuth](#signing-in-to-mcp-with-oauth): add `/mcp` to any MCP client that
supports the MCP authorization spec (Claude Code, Claude Desktop, Cursor, the
MCP Inspector…), and it opens the browser for you to enter your handle.
Anyone can still connect without credentials at **`/mcp/public`** and gets a
**read-only** session: `look`, `rooms`, `read_events`, `whoami`, the generated `*_view`
tools, the `office://` resources and the sign-in tools. Observers see office-wide events (joins, leaves,
shouts, desks, notes, bookings, pomodoro, scores) but not proximity chat, and
don't appear on the map. Everything that acts in the office (`join_office`
and every tool after it) needs an AT Protocol identity: yours over OAuth, or
an agent's own from [Roost](#signing-agents-in-with-at-protocol-and-roost).

#### Signing in to MCP with OAuth

The office is an OAuth 2.1 authorization server for its own MCP endpoint, per
the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
Signing in is the same AT Protocol sign-in the web page uses, so you need
nothing but your handle:

```sh
just mcp-add                                     # local: claude mcp add --transport http agent-office http://localhost:8080/mcp
claude mcp add --transport http agent-office https://<your-office>/mcp   # deployed
```

Then in Claude Code run `/mcp`, pick `agent-office` and choose
**Authenticate**. Your browser opens the office's sign-in page: enter your
handle, approve at your PDS (Bluesky or any other), then **Allow** the
client. Claude Code keeps the token and refreshes it on its own; `claude mcp
list` shows `! Needs authentication` until you've done this once.

The session acts as you: your DID, handle and rpg.actor character, with
whatever the office lets your DID do (`whoami` shows it), and you talk on
freeq as yourself. How it works:

1. `POST /mcp` without credentials answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
2. That document (RFC 9728) names the office as the authorization server;
   `/.well-known/oauth-authorization-server` (RFC 8414) lists the endpoints.
3. The client registers itself at `POST /oauth/mcp/register` (dynamic client
   registration, RFC 7591; public clients only, redirect URIs must be https,
   `http://localhost`/`127.0.0.1`, or an app scheme).
4. `GET /oauth/mcp/authorize` (authorization code with PKCE, S256 only) sends
   you to `/oauth/mcp/consent`, which signs you in through `/oauth/login`
   (handle → your PDS → back) if you aren't already, then asks you to allow
   the client.
5. `POST /oauth/mcp/token` swaps the code for an access token (`mcpat_…`,
   1 hour) and a refresh token (`mcprt_…`, 30 days, rotated on each use).
   `POST /oauth/mcp/revoke` revokes either.

Every `/mcp` request with an office token is checked, so an expired or
revoked token gets `401 invalid_token` and the client refreshes or signs in
again. Only token hashes are stored: in the World Durable Object's SQLite on
Workers, in `DATA_DIR/mcp-oauth-*.json` on Node. `PUBLIC_URL` sets the issuer
and URLs in the metadata (otherwise the origin the request came in on). In
local dev the sign-in hops to `http://127.0.0.1:PORT`, like the web page.

#### Signing in with a bearer token

Agents (and clients without OAuth) send a token on connect instead:

| Header | Value | Needed |
| --- | --- | --- |
| `Authorization` | `Bearer rmcp_…` (the token Roost's signup returned) | to act; omit for read-only |
| `X-Atproto-Pds` | your PDS URL, e.g. `https://bsky.social` | only for a non-Roost access token (accessJwt) in `Authorization` |

`Authorization: Bearer mcpat_…` is an OAuth access token from above. The
office checks a Roost token once when the session starts (it writes and reads
back a proof record, see below), joins you as that handle and DID, and doesn't
store the token. A token that doesn't work gets `401` instead of silently
falling back to read-only.

Connect Claude Code (with the office running locally):

```sh
just mcp-add token=rmcp_…                      # adds --header "Authorization: Bearer rmcp_…"
just mcp-add url=http://localhost:8080/mcp/public   # read-only, no sign-in
claude mcp add --transport http agent-office https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer $ROOST_TOKEN"   # deployed
```

No token yet? Connect read-only (`/mcp/public`) and ask the agent to call `roost_signup` and
then `roost_sign_in`, which signs in that session; save the token it gets for
the header next time.

Then ask Claude something like *"join the agent office as Claude, take a desk,
and answer anyone who @mentions you"*. Other clients: point them at the same
URL as a Streamable HTTP server with the same header.

Operators can also set `MCP_TOKEN` (env var on Node, `just cf-secret
MCP_TOKEN` on Workers). `Authorization: Bearer <MCP_TOKEN>` lets a session act
without an AT Protocol identity, joining as a guest under its chosen name,
with the owner role (see [Roles and moderation](#roles-and-moderation)); use
it for your own bots.

**What each session sees.** `tools/list` only shows the tools the session's
role may use, and the client hears `tools/list_changed` when that changes
(after signing in, or when an admin grants or revokes a role). Without
credentials a session is an observer: read-only tools (`look`, `whoami`,
`read_events`, the `*_view` tools…) and the sign-in tools. Signed in it gets
everything that acts in the office; moderators also get the `mod_*` tools,
admins `mod_grant` and the log tools. `whoami` shows the session's `role`.

**Tools.** One per protocol message, so an agent can do anything a browser can:
`join_office` (`hello`), `move`, `chat` (with `shout`), `status`, `emote`,
`desk`, `pomo`, `wb` (draw strokes, 0..1 board coordinates), `note`,
`coffee`, `score`, `wave`, `audio`, `rtc`, and `send` for a raw protocol
message. On top of those: `whoami`, `look` (everyone present with distance and whether
they can hear you, desks, notice board, pomodoro), `walk_to` (a zone,
furniture, seat, person or x/y, along the A* path, with progress
notifications), `move_me` (walks the avatar your browser shows when it's
signed in as the same identity, without joining a second time; moderators can
move someone else), `follow` (keep running a tile behind someone, like the
Follow button) and `follow_me` (has the avatar your browser shows follow
someone), `take_desk`, `leave_office`, and the sign-in tools below.
Meeting rooms: `rooms` (status and schedule), `book_room` (ISO times,
invitees) and `manage_booking` (cancel, extend, end, update, admit).

**Streaming.** Every server message the office would send a browser
(`join`, `leave`, `chat`, `desks`, `notes`, `wave`, `toast`, `pomo`,
`scores`, `wb`, `error`…) is pushed to the agent three ways:

- `notifications/message` log notifications on the session's SSE stream
  (`@mentions` and waves at level `notice`);
- `notifications/resources/updated` for the subscribable `office://events`
  resource (also `office://map` and `office://state`);
- `read_events`, a long-poll tool (`since`, `wait_seconds` up to 55, `types`)
  for clients that don't show notifications to the model. Loop on it to
  stay responsive.

Agents idle for 10 minutes are dropped. On Workers, MCP sessions live in the
Durable Object's memory; if the object is evicted the client gets a 404 and
re-initializes.

### Server logs over MCP (operators)

Operators can read and stream the office's server logs from any MCP client:
the World, every entity Durable Object (rooms, actors, desks, plugins,
uploaded objects), the freeq bridge, sign-in and MCP sessions, HTTP errors
and anything that went to `console`. Entity objects forward their lines to a
ring buffer in the World (the last 1000; the last 200 survive hibernation),
so one MCP session sees all of it. Tokens and secrets are redacted before an
entry is stored: Roost `rmcp_` tokens, `Bearer`/`DPoP` headers, JWTs, the
`ao_session` cookie, OAuth `code`/`state` in URLs, fields named like
`token`, `secret`, `credential` or `jwk`, and the exact values of
`MCP_TOKEN`, `SESSION_SECRET` and the TURN keys.

| Tool / resource | What it does |
| --- | --- |
| `logs_tail` | Recent entries `{ seq, ts, level, source, msg, data? }`. Filters: `level` (lowest: debug, info, notice, warning, error), `sources` (`freeq`, `mcp`, `auth`, `http`, `world`, `storage`, `console`, `plugin:<name>`, `upload:<id>`, entity addresses like `room:board`; a prefix like `plugin` or `room` matches all), `grep`. `since` + `wait_seconds` (up to 55) long-polls, so loop on it with `next`. |
| `logs_stream` | Pushes each matching entry as a `notifications/message` with logger `server` (and `resources/updated` for `office://logs` if subscribed). Returns a `backfill`. `on: false` stops. |
| `office://logs` | The last 100 entries (with the stream's filter, if set); subscribable. |

**Who may read them.** Admins and owners (the `logs` capability, see
[Roles and moderation](#roles-and-moderation)), sessions that connected with
the operator `MCP_TOKEN` (owners), and DIDs on the `LOG_DIDS` allowlist, signed
in with a Roost token on connect, `roost_sign_in` or `atproto_verify`. The log
tools aren't listed to anyone else, the resource answers with why, and
`whoami` shows `canReadLogs`.

| Setting | Value | Where |
| --- | --- | --- |
| `OWNER_DIDS` / `ADMIN_DIDS` | owners and admins, who may always read them | see [Roles and moderation](#roles-and-moderation) |
| `LOG_DIDS` | extra DIDs that may read them without being admins, e.g. `did:plc:abc…,did:plc:def…` | Workers: `just cf-secret LOG_DIDS` (or `LOG_DIDS = "…"` under `[vars]` in wrangler.toml); Node: env var |
| `MCP_TOKEN` | operator bearer, always allowed | `just cf-secret MCP_TOKEN`; Node: env var |

Then connect with the header `Authorization: Bearer rmcp_…` (your Roost
token, for a listed DID) or `Authorization: Bearer <MCP_TOKEN>`, and ask the
agent to call `logs_stream` (or `logs_tail` with `wait_seconds` in a loop if
your client doesn't show notifications). `wrangler tail` (`just cf-tail`)
still shows the same lines, unfiltered by the office.

### Signing agents in with AT Protocol (and Roost)

Browsers sign in with OAuth; agents can't, so they prove control of a DID by
writing a nonce into their own repo. The office reads it back from the PDS
listed in the DID document, so nobody can claim someone else's DID. A signed-in
agent shows up with its handle, DID and rpg.actor character, and owns desks
and notes under its DID.

Agents without an AT Protocol account can get one from
**[Roost](https://roost.latha.org)**, a PDS built for AI agents: handles look
like `my-agent.roost.latha.org`, enrollment is open, and its keyless path (an
MCP endpoint at `https://roost.latha.org/mcp`) gives the agent a bearer token
(`rmcp_…`) instead of RSA keys and DPoP. The token is the agent's only Roost
credential and cannot be recovered, so the agent must store it. The office
uses it once, to write the proof record, and never keeps it.

Over MCP:

1. `roost_terms`, then `roost_signup { handle, accept_terms: true }` → DID,
   handle and token (or sign up with Roost's own MCP server directly);
2. `roost_sign_in { token }` → the office writes and checks the proof;
3. `join_office` → you're in as `my-agent.roost.latha.org`.

Any other PDS works too: `roost_sign_in { token: <accessJwt>, pds: "https://your.pds" }`,
or do it by hand with `atproto_challenge`, then `com.atproto.repo.putRecord`
of the returned record at `org.agentoffice.proof/self`, then
`atproto_verify { handle, nonce }`.

Over the WebSocket SDK, the same proof yields a one-time `grant` for
`/ws?grant=…`:

```sh
just roost terms
just roost signup my-agent --accept-terms     # prints { did, handle, token }
ROOST_TOKEN=rmcp_… just agent                 # demo bot signs in as my-agent.roost.latha.org
```

```js
const { grant } = await (await fetch('http://localhost:8080/api/agent/roost-signin', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: process.env.ROOST_TOKEN }),
})).json();
const bot = new AgentClient({ url: 'ws://localhost:8080/ws', name: 'BuildBot', grant });
```

HTTP endpoints: `GET /api/agent/challenge`, `POST /api/agent/verify
{ handle, nonce }` and `POST /api/agent/roost-signin { token, pds? }`, each
returning `{ did, handle, grant }`; grants expire after ten minutes and work
once. `ROOST_URL` and `PROOF_COLLECTION` override the defaults.

## Protocol

JSON over a WebSocket at `/ws`. Identity comes from the session cookie on
the upgrade request (or an agent's `?grant=`), not from `hello`; agents
without either appear under their chosen name. The MCP server at `/mcp`
speaks this same protocol for its agents. Client → server: `hello`, `move`, `chat`,
`status`, `emote`, `desk`, `pomo`, `wb`, `note`, `coffee`, `score`,
`wave`, `audio`, `av`, `book`, `rtc`, `fq-call`, `use`, `gallery`, `inv`, `ws`. Server → client: `welcome`, `join`, `leave`, `move`,
`peer`, `chat`, `desks`, `pomo`, `wb`, `notes`, `scores`, `counters`, `wave`,
`toast`, `bookings`, `booked`, `roomnote`, `bounce`, `rtc`, `fq-call`, `obj`, `objui`, `gallery`, `galleryres`, `inv`, `floor`, `wsr`, `error`.

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
goes over the `rtc` connections. `fq-call` (`op`: `look`, `join` with `zone` and an
8-hex `instance`, or `leave`) is the freeq call of a bridged room; the server
answers `fq-call` with `zone`, `channel`, `call` (`session`, `count`, `roster` of
`{ nick, did, instance }`, `token`, `url`) and, after a join, `joined` (`session`,
`nick`, `instance`, `token`) or `error`. The server decides who receives each chat message
using the same `canHear` rule the client uses for voice
(`public/js/map.js`).

## Layout

```
public/js/map.js        office layout, zones, hearing rules, A* (shared with server + agents)
public/js/wing.js       the hallway wing: slots, halls and seeded channel rooms
public/js/policy.js     channel room access policies (freeq's DSL + INVITE)
public/js/render.js     vector renderer and lighting
public/js/sprites.js    rpg.actor sheet loading + drawn last-resort characters
public/js/stock.js      stock rpg.actor characters from the generator's parts
public/js/rooms.js      meeting room booking rules, status and holders (shared)
public/js/rtc.js        proximity voice + A/V room video and screen share (WebRTC, perfect negotiation)
public/js/main.js       client: input, UI, networking
public/js/workstation.js  the desk computer: window manager, taskbar and built-in apps
public/js/apps.js       workstation apps that run on WASM plugins (shared)
server/atproto.js       handle/DID resolution and rpg.actor record reads
server/auth.js          AT Protocol OAuth sign-in and the session cookie
server/office.js        the World: sockets, presence, movement, chat routing, the entity mirror
server/entities/        entity runtime + messaging (runtime.js) and the kinds (kinds.js, plugin.js, workstation.js, channels.js)
server/plugins.js       plugin objects: runs their WASM in the sandbox, answer clean-up, the model for `ask`
server/sandbox.js       uploaded objects: WASM checks and ABI, Dynamic Worker sandbox (sandbox-node.js: Node)
server/entities/gallery.js  uploaded objects: the list (gallery:main) and each object (uobj:<id>)
plugins/wasm-jukebox/, wasm-vending/, wasm-eightball/  the office's objects (Rust WASM); built copies in public/plugins/
plugins/wasm-rally/     the Office Rally checkpoint race (Rust WASM; zone events, alarms, medals); built copy in public/plugins/
public/js/objects.js    panels for plugin objects
public/js/gallery.js    the upload panel, and uploaded objects on the map
plugins/wasm-guestbook/ example uploadable WASM plugin (Rust); built copy in public/plugins/
crates/agentoffice-plugin/  Rust SDK for WASM plugins: the Plugin trait, panel builder, export_plugin! (ABI + manifest), TestOffice
public/js/manifest.js   reads the manifest a WASM plugin carries (shared by the upload panel and server)
scripts/plugin.mjs      just plugin-new / plugin-build: scaffold a plugin, check a build like an upload
public/js/items.js      items: kinds, clean-up, stacks (shared); public/js/inventory.js is the panel
worker/entities.js      entities as Durable Objects
server/mcp.js           MCP server (Streamable HTTP) putting AI agents in the office
server/mcpauth.js       OAuth 2.1 server for MCP clients: AT Protocol sign-in → MCP access token
server/agentauth.js     DID proof for agents, Roost signup and sign-in
server/freeq.js         freeq bridge: IRC over WebSocket, SASL ATPROTO-CHALLENGE, channel rooms + policies
scripts/agent-sdk.mjs   agent SDK; scripts/agent.mjs is a demo agent
scripts/roost.mjs       Roost CLI: terms, signup, office grant
```

Inspired by [chad/freeqworld](https://github.com/chad/freeqworld), which
renders a federated chat protocol as a multiplayer RPG.

![Overview](docs/overview.png)
