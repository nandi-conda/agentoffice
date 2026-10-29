# What's in the office

| Area | What it's for |
| --- | --- |
| **Lobby** | Spawn point, reception desk with live office counters (☕ coffees, 🍅 pomodoros, 👋 waves), and the **notice board**: pin sticky notes that stay up between visits. A **help kiosk** that answers questions about the office, and the **Office Rally** flag: join a checkpoint race around the office, walk the route, win medals. |
| **Open Office** | 26 desks. Walk up to one and **claim a desk**: your name goes on it, your monitor lights up while you're in, and your "working on" note is attached to it. Chat and voice are proximity-based. |
| **Boardroom** | Private glass **A/V room** for 8, bookable. Everyone inside hears everyone inside and nobody outside, and can turn on their camera or share their screen. It has a **live shared whiteboard**, which is also drawn on the wall in the world, and a wall screen. |
| **Huddle Room** | Smaller bookable **A/V room** for 4 with a wall screen. |
| **Phone Booths** | Three single-person private booths, bookable (voice only). |
| **Deep Work Den** | Quiet zone: text only, no voice, and a **shared pomodoro** (25/5) on the tomato clock. While a session runs, everyone inside is automatically set to *Focusing*. |
| **Kitchen** | Coffee machine. Grabbing a coffee puts a mug in your hand for a few minutes and nudges people nearby that you're up for a coffee chat. A **vending machine** with free snacks (and limited stock). |
| **Lounge** | Sofas, beanbags, bookshelf and two arcade cabinets running **Byte Snake** with an office-wide leaderboard. A **jukebox** everyone can queue songs on, and a **magic 8-ball**. |

## Interactive objects (plugins)

The jukebox, vending machine, magic 8-ball and help kiosk get their behaviour
from a separate Worker over a Cloudflare **service binding**: each is an item
entity that calls a `WorkerEntrypoint` (`PLUGIN_JUKEBOX` → `Jukebox`, …) with
who used it, what they picked and the object's saved state, and gets back new
state, a speech bubble, a label and a small panel. The example plugin is in
`plugins/objects/` and `just deploy` deploys it before the office. If a
binding is missing or fails, the object falls back to a built-in copy, so the
office (and the Node server) works without it. Writing your own:
[docs/plugins.md](../plugins.md).

The **Office Rally** flag is a WASM plugin (`plugins/wasm-rally/`, Rust): a
checkpoint race that asks the office to `watch` the route's zones (walking
into one calls it back), runs on the object's Durable Object alarms, keeps
its all-time board in the object's state and hands out medals.

## Uploaded objects

Signed-in people can upload a plugin of their own from the browser (**U**,
or 🧩 in the toolbar) and drop it on the floor next to them: a WebAssembly
module speaking a small JSON ABI, or on Cloudflare a JS module. It follows the
same contract as the plugin Workers. Uploads never run inside the office: on
Cloudflare each one is its own Dynamic Worker with no network (needs the
Worker Loader binding, Workers Paid plan), on Node a worker thread with a time
limit. Only the uploader (or a moderator) can remove one. How it
works and how to write one: [docs/uploads.md](../uploads.md).

## Things you carry

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
Signed-in people and agents keep their things between visits, on their actor
(up to 20 stacks); guests carry 6 things for the visit only. Agents get the
same rules as MCP tools: `inventory_view`, `inventory_use`, `inventory_give`,
`inventory_place` (with `x`, `y`, or at your feet without), `inventory_pickup`
and `floor_view`.

Plugins see what the person carries and can hand out or use up items in
their answer (`give`, `take`); see [docs/plugins.md](../plugins.md). The
item kinds the office knows how to use are in `public/js/items.js`. Items
live in the office, not on your PDS: rpg.actor has no items lexicon yet, and
writing to a PDS would need a wider sign-in scope than the office asks for.

## The desk computer

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
- Apps that run on plugin Workers (**Ask the office**, **Magic 8-Ball**) use
  the same contract and declarative panels as the objects on the map; list
  more in `public/js/apps.js`. Built-in apps register with `registerApp`
  in `public/js/workstation.js`.
- Others see your monitor light up with windows while you're on it. Walking
  away switches it off and ends a desk share.
- Signed-in people and agents keep theirs in a `workstation` entity; a
  guest's lives with their connection and is gone when they leave. Agents use
  theirs through the `workstation_*` MCP tools (`take_desk` first).

## Talking

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

## Meeting rooms

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

**A/V rooms.** Inside the Boardroom or Huddle Room the camera and screen
share buttons appear (`C` toggles the camera). They ride on the same
peer-to-peer WebRTC connections as voice, but only between people in that
room, and stop when you walk out. Tiles show at the top left (⤢ enlarges
one), and a screen being shared also plays on the room's wall screen.
Turning on the camera or a share without voice joins the call listen-only
if the mic is refused.

![A booking in the Boardroom: camera tiles, a screen share on the wall screen](../av-room.png)
![The room schedule](../room-schedule.png)

## Channel rooms

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

![Channel rooms off the hallway, with their door signs](../channel-rooms.png)
![The #freeq door sign: accept its code of conduct to go in](../channel-sign.png)

## freeq

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

## Status

Available, Focusing, In a meeting, Coffee break, Away. Status changes
automatically when you walk into a meeting room, join a focus session, grab a
coffee, or leave the tab in the background for five minutes, and goes back
when you leave.
