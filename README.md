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
just test                      # unit tests (node:test)
just                           # list every recipe (docker-build, docker-run, clean…)
```

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
guest. We only ask for the `atproto` scope (identity, no posting) and revoke
the tokens right after sign-in; what's kept is a signed, HttpOnly cookie
holding your DID for 30 days.

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
over DNS-over-HTTPS (Cloudflare) plus `/.well-known/atproto-did`.

## Hosting on Cloudflare Workers

The same office runs as a Cloudflare Worker (`wrangler.toml`,
`worker/index.js`). `public/` is served as Workers static assets, and
everything else (`/ws`, `/api/*`, `/oauth/*`, `/healthz`) goes to a single
Durable Object, `OfficeRoom`, that holds the office. It uses the WebSocket
Hibernation API, so an idle office with people connected isn't billed for
wall-clock time: each socket carries its peer in its attachment and the room
rebuilds itself when it wakes. Desks, notes, scores, counters and whiteboard
strokes live in the object's SQLite storage (one row per stroke), as do the
OAuth login state and the cookie-signing key.

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
npx wrangler deploy --var PUBLIC_URL:https://office.example.com   # or add [vars] PUBLIC_URL to wrangler.toml
just cf-secret SESSION_SECRET                                      # paste `openssl rand -hex 32`
```

Request handling is shared: `server/app.js` holds the HTTP routes as
`Request -> Response` functions, called by both `server/index.js` (Node) and
the Durable Object. Add new endpoints there, using only web-standard APIs
(`fetch`, Web Crypto, no `node:*` imports), and they work in both places.

## What's in the office

| Area | What it's for |
| --- | --- |
| **Lobby** | Spawn point, reception desk with live office counters (☕ coffees, 🍅 pomodoros, 👋 waves), and the **notice board**: pin sticky notes that stay up between visits. |
| **Open Office** | 26 desks. Sit down and **claim a desk**: your name goes on it, your monitor lights up while you're in, and your "working on" note is attached to it. Chat and voice are proximity-based. |
| **Boardroom** | Private glass room. Everyone inside hears everyone inside and nobody outside. It has a **live shared whiteboard**, which is also drawn on the wall in the world. |
| **Huddle Room** | Smaller private room for quick syncs. |
| **Phone Booths** | Three single-person private booths. |
| **Deep Work Den** | Quiet zone: text only, no voice, and a **shared pomodoro** (25/5) on the tomato clock. While a session runs, everyone inside is automatically set to *Focusing*. |
| **Kitchen** | Coffee machine. Grabbing a coffee puts a mug in your hand for a few minutes and nudges people nearby that you're up for a coffee chat. |
| **Lounge** | Sofas, beanbags, bookshelf and two arcade cabinets running **Byte Snake** with an office-wide leaderboard. |

### Talking

- **Proximity chat and voice.** In open areas you reach anyone within a few
  steps. Voice is peer-to-peer WebRTC with distance falloff; the server only
  relays signalling.
- **Rooms are private.** Inside a room, chat and voice stay in the room.
- `/shout …` reaches the whole office. `@name …` taps someone wherever they
  are (they get a notification with a "walk over" button).
- Wave at or knock on someone from their profile card, follow them, or walk
  over with one click.

### Status

Available, Focusing, In a meeting, Coffee break, Away. Status changes
automatically when you walk into a meeting room, join a focus session, grab a
coffee, or leave the tab in the background for five minutes, and goes back
when you leave.

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
pixels for tracing. People without an rpg.actor sprite get a generated
character in the same sheet format.

A handle is only shown if it resolves back to the same DID (bidirectional
check), so a DID document can't claim someone else's handle. The handle box
still previews anyone's character before you sign in, via `/api/actor`.

## The art style

The office is drawn entirely as vector shapes on a canvas every frame
(furniture, soft shadows, sunlight through the north windows, desk lamps), so
it stays sharp at any zoom or pixel density. Lighting follows your local
clock: morning light, golden hour, and a lamp-lit office at night (add
`?hour=21` to the URL to preview).

Characters are **raster→vector traced** in the browser (`public/js/trace.js`):
each frame is split into flat colour regions, each region's pixel boundary is
traced into closed loops, staircase corners are smoothed with Chaikin
subdivision, and a traced silhouette underneath gives a clean ink outline. The
◆ button (or `V`) switches back to the original pixels, drawn at whole-number
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

## Protocol

JSON over a WebSocket at `/ws`. Identity comes from the session cookie on
the upgrade request, not from `hello`; agents connect without one and appear
under their chosen name. Client → server: `hello`, `move`, `chat`,
`status`, `emote`, `sit`, `desk`, `pomo`, `wb`, `note`, `coffee`, `score`,
`wave`, `audio`, `rtc`. Server → client: `welcome`, `join`, `leave`, `move`,
`peer`, `chat`, `desks`, `pomo`, `wb`, `notes`, `scores`, `counters`, `wave`,
`toast`, `rtc`, `error`. The server decides who receives each chat message
using the same `canHear` rule the client uses for voice
(`public/js/map.js`).

## Layout

```
public/js/map.js        office layout, zones, hearing rules, A* (shared with server + agents)
public/js/render.js     vector renderer and lighting
public/js/trace.js      raster→vector sprite tracing
public/js/sprites.js    rpg.actor sheet loading + generated fallback characters
public/js/rtc.js        proximity voice (WebRTC, perfect negotiation)
public/js/main.js       client: input, UI, networking
server/atproto.js       handle/DID resolution and rpg.actor record reads
server/auth.js          AT Protocol OAuth sign-in and the session cookie
server/office.js        the hub: presence, chat routing, desks, pomodoro, etc.
scripts/agent-sdk.mjs   agent SDK; scripts/agent.mjs is a demo agent
```

Inspired by [chad/freeqworld](https://github.com/chad/freeqworld), which
renders a federated chat protocol as a multiplayer RPG.

![Overview](docs/overview.png)
