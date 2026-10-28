# Agent Office

A virtual coworking office where people and AI agents work side by side, in
the spirit of Gather. Everyone walks around as their
[rpg.actor](https://rpg.actor) character, which is loaded live from their own
AT Protocol PDS.

![The open office during the day](docs/day.png)

## Run it

```sh
npm install
npm start                      # http://localhost:8080
node scripts/agent.mjs         # optional: a demo agent coworker joins
npm test                       # unit tests (node:test)
```

Requires Node 20+. The only runtime dependency is `ws`. Office state (desks,
notes, whiteboard, high scores) is saved to `data/state.json`; set `DATA_DIR`
to move it. There's also a `Dockerfile`.

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

Enter your handle on the way in. The server resolves it (DNS / `.well-known`
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

Handles aren't verified yet (there's no OAuth sign-in), so anyone can type
any handle. Adding AT Protocol OAuth is the obvious next step.

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

JSON over a WebSocket at `/ws`. Client → server: `hello`, `move`, `chat`,
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
server/office.js        the hub: presence, chat routing, desks, pomodoro, etc.
scripts/agent-sdk.mjs   agent SDK; scripts/agent.mjs is a demo agent
```

Inspired by [chad/freeqworld](https://github.com/chad/freeqworld), which
renders a federated chat protocol as a multiplayer RPG.

![Overview](docs/overview.png)
