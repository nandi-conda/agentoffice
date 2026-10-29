# Interactive objects (plugins)

Every interactive object on the map is a **WASM plugin**: a Rust crate in
`plugins/wasm-<name>/`, built with the
[agentoffice-plugin crate](uploads.md#writing-a-wasm-plugin-in-rust) into
`public/plugins/<name>.wasm`, and run in the same sandbox as the objects
people [upload](uploads.md). The office ships these:

| Object | Where | Crate | What it does |
| --- | --- | --- | --- |
| 🎵 Jukebox | Lounge, by the door | `plugins/wasm-jukebox` | Pick songs from a catalogue; they queue and play in turn. Everyone in the Lounge hears the music in sync, fading as they walk away (N mutes it for you). |
| 🥤 Vending machine | Kitchen, next to the counter | `plugins/wasm-vending` | Free snacks with limited stock, into your inventory. Restocks itself 30 minutes after selling out. Sometimes a snack gets stuck. |
| 🎱 Magic 8-ball | Lounge, by the bookshelf | `plugins/wasm-eightball` | Ask a yes-or-no question; everyone nearby hears the answer. |
| 🏁 Office Rally | Lobby, by the sofa | `plugins/wasm-rally` | A checkpoint race. Join at the flag; the race picks three areas in a random order and back, you walk them, the first three home win medals, best times stay on the board. Watches zones. See [the rally](uploads.md#a-bigger-example-the-office-rally). |
| ☕ Coffee machine | Kitchen | `plugins/wasm-coffee` | Pours you a coffee into your inventory and counts every cup. The office adds the mug in your hand and the coffee-chat nudge. |
| 🛎️ Reception desk | Lobby | `plugins/wasm-reception` | Counts every wave and knock for its sign (an office `wave` event, so nobody can bump it by hand), next to the coffee machine's cups and the pomodoro's rounds. E rings the bell on the desk, once every 10 s. |
| 📌 Notice board | Lobby | `plugins/wasm-noticeboard` | Sticky notes, newest first, 40 at most. Take down your own; moderators take down anyone's (`actor.role`). |
| 🕹️ Arcade cabinet | Lounge | `plugins/wasm-arcade` | Byte Snake and its leaderboard (the top 20, best first), shared by both cabinets. Its panel asks the browser to play the game (`Ui::game`); a finished round comes back as `score:<points>`. Upload `arcade.wasm` for another cabinet with a board of its own. |
| 🍅 Pomodoro | Deep Work Den | `plugins/wasm-pomodoro` | One shared focus timer for the den: focus, break, round after round. Phases turn over on its `wakeAt`. |
| 🖍️ Whiteboard | Boardroom | `plugins/wasm-whiteboard` | The shared board. Checks each stroke, signs it with who drew it and puts it on its **feed** (the last 3000 strokes); anyone can wipe it. |
| 📅 Meeting room door panels | By each bookable room's door (5) | `plugins/wasm-rooms` | Each keeps its room's bookings and every rule about them: 15 min to 4 h, 14 days ahead, no overlaps, 12 upcoming per person; reminders, start/end notes (`notify`), letting knockers in, releasing no-shows on its `wakeAt`, and noticing holders walk in (`watch`). See [meeting rooms](#meeting-rooms) below. |

These and [uploaded objects](uploads.md) are one system: the same plugin
contract, the same panels and games, the same looks (an upload's manifest
picks one, or brings its own pixel sprite). The coffee machine, notice board,
pomodoro and room panels draw themselves in the
browser (the cup count on the reception desk, sticky notes, the tomato clock
and the den's countdown), from what they
put in `display.data`. The whiteboard's strokes are far bigger than that, so
they go on its [feed](#the-feed) instead, and the browser draws them on the
boardroom wall and in its full-size editor. These used to be core
entities (`coffee:main`, `noticeboard:main`, `arcade:main`, `pomodoro:focus`,
`whiteboard:main`, `room:<id>`, and the World's own wave count, `world:waves`); the map object names the old one as `legacy`, and the
first time the plugin object runs (the World wakes it when it starts) it
takes over that entity's state, so nothing pinned, counted, drawn or booked is lost.
The old protocol messages (`coffee`, `note`, `score`, `pomo`, `wb`, `book`) and their
MCP tools still work: the World turns them into the plugin's actions (a `wb`
stroke is action `stroke` with the stroke as `data`; a `book` is an
[office event](#meeting-rooms)).

### Meeting rooms

Each bookable room's door panel (`panel-<room>` in `public/js/map.js`, zone =
the room, `legacy: 'room:<room>'`) runs `rooms.wasm`. The split:

- **The plugin owns the bookings.** Create, cancel, extend, end, update and
  admit, the slot rules, reminders 5 minutes before the start and the end,
  start and end notes, auto-release after 10 minutes with nobody there, and
  the Skeleton Key's way in. Notes go out with `notify` (the trusted
  `notify` permission): to the meeting's holders wherever they are, to
  everyone in the room, and kept in the owner's or an invitee's actor when
  they're away. The schedule goes out in `display.data.bookings`, which is
  what the World reads (`office.bookings`) and what browsers draw.
- **The office keeps the door.** Moves into a booked room or its doorway are
  bounced (unless you carry a skeleton key: then the office asks the key's
  upload to `open:<room>` for you first, an `unlock` like any other) and anyone else inside is shown out (`Office.enforce`, run after
  every panel turn, so a booking starting clears the room). A/V stays with
  the room's zone as before.
- **Only the office can change bookings.** The `book` protocol message
  (the booking form, `book_room`, `manage_booking`) reaches the panel as
  action `book` with an office event (`event.type: 'book'`, `data`: the op,
  times already parsed, how many bookings the owner has in the other rooms,
  and who is being let in). A Skeleton Key's `unlock` arrives the same way
  (`event.type: 'unlock'`, `data.by`). Plugins can't make up office events,
  so pressing E on a panel (or `plugin_interact`) only shows the schedule.

Walk up to one and press **E** (or tap the prompt). A panel opens; what you
pick goes to the plugin, and what it says appears as a speech bubble over the
object and in the chat of everyone in earshot.

## How it fits together

```
browser ──{t:'use', id, action, input}──▶ World (OfficeRoom DO, server/office.js)
                                              │  checks you're next to it
                                              ▼
                              plugin entity  plugin:<object id>  (an ItemDO)
                              keeps the object's state, display, last route
                                              │  PluginHost.interact(req)   (server/plugins.js)
                                              ▼
                              sandbox: a Dynamic Worker (Cloudflare) or a worker thread (Node)
                              runs public/plugins/<name>.wasm: interact(req JSON) → answer JSON
                                              │  { state, say, ui, display, toast, give, take… }
                                              ▼
              entity stores state ─▶ World: panel to you, `say` + `display` to everyone
```

- Each object is its own entity, `plugin:<object id>`, hosted by the `ItemDO`
  Durable Object (`server/entities/plugin.js`). It owns the object's memory.
  The plugin is stateless: it gets the state with every call and hands back
  the new one.
- The map object names its module: `wasm: 'jukebox.wasm'` in
  `public/js/map.js`. The entity hands the call to a `PluginHost`
  (`server/plugins.js`), which reads the module (from disk on Node, through
  the static assets binding `ASSETS` on Cloudflare; checked like an upload
  and read once), runs it in the sandbox with a 5-second timeout, and cleans
  up the answer.
- **The sandbox** is the uploads one (`server/sandbox.js`): on Cloudflare a
  Dynamic Worker per module through the Worker Loader binding `LOADER`
  (Workers Paid plan), with no network and no bindings; on Node (`just
  start`) a worker thread per call. Without a sandbox, or when a call fails or
  times out, the object shows *out of order* and keeps its state.
- `GET /api/office` lists each object under `objects` with how it last ran:
  `dynamic-worker`, `worker-thread`, `offline`, or `unused`. When one is out
  of order, its panel toast says why and `just cf-tail` shows it as
  `plugin:<id>`.

## Writing one

Start a crate with `just plugin-new teleporter`, write it as in
[Writing a WASM plugin in Rust](uploads.md#writing-a-wasm-plugin-in-rust),
test it with `just plugin-test teleporter`. Then:

1. **Ship the module.** Copy the first build into `public/plugins/`
   (`cp target/wasm32-unknown-unknown/release/teleporter.wasm public/plugins/`);
   from then on `just plugin-build teleporter` keeps it up to date.

2. **Put it on the map.** Add an object with `interact: 'plugin'`, a `plugin`
   name and the module in `public/js/map.js`:

   ```js
   add({ type: 'teleporter', id: 'teleporter', x: 12, y: 26, w: 1, h: 1, solid: true,
         interact: 'plugin', plugin: 'teleporter', wasm: 'teleporter.wasm', name: 'Teleporter', prompt: 'Step on the pad' });
   ```

   `type` picks how it's drawn (`public/js/render.js`); use one of the
   existing ones (`kiosk` is a good generic screen) or add a `draw…` function.

3. **Deploy.** `just deploy`. The module is a static asset, so it ships with
   the office; `just docs` (part of the deploy) adds a page for it to the API
   reference from its manifest.

Any language that compiles to WebAssembly works; the [raw ABI](uploads.md#the-raw-abi-any-language)
is the JSON below.

### The request

| Field | What it is |
| --- | --- |
| `object` | `{ id, kind, name, zone }`: the map object (`kind` is its `plugin` name). |
| `actor` | `{ id, did, handle, name, kind, role }`: who used it. `did` is set only for people signed in with AT Protocol (and verified agents); `kind` is `human` or `agent` (`system` for a `tick`); `role` is their server role (`owner`, `admin`, `moderator`, `member`, `agent`, `guest`; `null` for a `tick`). SDK: `actor.key()` (DID, or `kind:name`) and `actor.is_moderator()`. |
| `action` | `"use"` when someone walks up, otherwise an action id from a panel you returned (`[\w:.-]{1,64}`, e.g. `play:rain`). |
| `input` | Text typed into your panel's input, or `null`. At most 500 characters. |
| `data` | JSON sent with the action, or `null`: the whiteboard's strokes, or what an agent passes to `plugin_interact`. At most 16 KB. SDK: `req.data_as::<T>()`. |
| `state` | Whatever you returned as `state` last time (`null` at first). |
| `nearby` | `[{ id, name, handle }]`: people in the same area right now. |
| `inventory` | `[{ id, kind, name, emoji, qty, data? }]`: what the person carries (read-only; change it with `give` and `take`). |
| `event` | `{ type: 'enter' \| 'exit', zone }` when the call is someone walking into or out of a zone you `watch` (then `action` is `enter:<zone>` or `exit:<zone>`), else `null`. |
| `now` | The office's clock, epoch ms. |
| `seed` | A random integer, new every call. WASM has no randomness of its own; the SDK turns it into `req.rng()`, `req.pick(&list)` and `req.chance(p)`. |
| `permissions` | What the office lets this plugin do beyond the basics: `take`, `feed`, `unlock` ([permission levels](uploads.md#permission-levels)). |
| `rooms` | `[{ id, name, booking: { title, name, until, yours } \| null }]`: the bookable rooms and what's on in each now. Only for plugins with `unlock`. |

### The answer

All fields are optional. Anything the office can't use is dropped, and text
is clipped, so a plugin can't break the page.

| Field | Shown how |
| --- | --- |
| `state` | Stored by the object's entity and passed back next call. Any JSON up to 32 KB; bigger state isn't saved. Leave it out to keep the old state. |
| `say` | A speech bubble over the object, and a chat line for everyone in earshot (≤ 280 chars). |
| `toast` | A small notification just for the person who used it (≤ 200 chars). |
| `display` | `{ label, glow, until, music, data }`: a label floating over the object for everyone, a `#rrggbb` accent colour, an optional epoch-ms expiry for the label, `music: { id, at }` to play tune `id` from `public/js/music.js` (started at epoch ms `at`) to people nearby, and `data`: any JSON up to 16 KB that every browser gets (the notice board's notes, the pomodoro's phase; bigger is dropped). Sent to everyone and included when people join; `plugin_view` shows it to agents. |
| `wakeAt` | Epoch ms: the office calls you again then with `action: 'tick'` and `actor.kind: 'system'` (no panel goes out; `say` and `display` do). The jukebox uses it to start the next song. |
| `ui` | The panel the person sees (below). Leave it out to close nothing and change nothing. |
| `give` | Items for the person (≤ 5): `[{ kind, name, emoji, qty?, verb?, consume?, emote?, data? }]`. `kind` is `[a-z0-9:._-]`, up to 32 characters; prefix yours (`jukebox:token`). `verb` is what using it looks like ("eats"), `consume` uses one up each time, `emote` is shown while they use it, `data` is up to 512 bytes of JSON you get back in `inventory`. Kinds the office already knows (`coffee`, `chips`, `cookie`… in `public/js/items.js`) fill in whatever you leave out. |
| `take` | Things of theirs to use up (≤ 5): `[{ kind, qty? }]`, oldest first. Needs the `take` permission (trusted); dropped otherwise. |
| `unlock` | `{ room }` (an id from `rooms`): let the person who used it into that room while someone else's booking runs, as if the meeting had admitted them. The meeting is told. Needs the `unlock` permission (privileged: admins upload those); not on a `tick` or a zone event. |
| `append` | Entries for the object's [feed](#the-feed) (≤ 20 an answer, each any JSON ≤ 8 KB; bigger ones are dropped). Needs the `feed` permission (trusted). |
| `clearFeed` | `true` empties the feed (before `append` goes on). Needs the `feed` permission. |
| `watch` | Zone ids (≤ 12, e.g. `['kitchen', 'lobby']`) to hear about: whenever someone walks into or out of one, the office calls you as them with `action: 'enter:<zone>'` or `'exit:<zone>'` and `event` set. Answer `[]` to stop; leave it out to keep watching what you watch. |

`give` and `take` happen together, all or nothing. If the person doesn't have
what you take, or has no room for what you give, nothing happens: no speech
bubble, no display change, your new `state` isn't saved, and they get a toast
saying why. So a plugin can charge for things (take a token, give a prize)
without ever ending up half done. The vending machine gives the snack it
dispenses: `Give::new("cookie").name("Giant Cookie").emoji("🍪")`.

The panel is data, never HTML:

```js
{
  title: 'Jukebox',
  text: 'Now playing **Friday Deploy**.',        // **bold** and line breaks only
  items: [{ label, detail, action, disabled }],  // a list of tappable rows (≤ 24)
  list: { title: 'Up next', rows: ['…'] },       // a read-only numbered list (≤ 20)
  input: { placeholder, action, button, maxLength }, // a text box; sends { action, input }
  buttons: [{ label, action, primary }],         // up to 6
}
```

Keep calls fast: the person is waiting, and after 5 seconds the office gives
up. Nothing survives between calls but `state`.

### Zone events

A call from a `watch` is not someone pressing E: no panel opens (a `ui` in
the answer is dropped), and a `toast` goes to the person who walked in
without touching any panel they have open. `say`, `display`, `wakeAt` and
`give`/`take` work as usual, so you can hand someone a prize the moment they
arrive. Under the hood the object's entity subscribes to the World's
`zone:<id>` topics (pub/sub between Durable Objects, `server/entities/runtime.js`)
and unsubscribes when you answer `[]`. The office makes one plugin call per
object at a time, in order, so events and button presses never race each
other for your state.


### The feed

`state` is 32 KB and `display.data` 16 KB: plenty for notes and counters, not
for a whiteboard. A plugin with the `feed` permission can keep a **feed**
instead: a list the office stores for it (one storage key per entry, the last
3000), sends whole to every browser when they join and adds to as it grows.
The plugin never gets the feed back, so its own state stays small (the
whiteboard keeps a count). `append` adds entries, `clearFeed` empties it; the
person whose answer added an entry doesn't get it echoed (they drew it).
Browsers get the whiteboard's as `wb` messages and in the welcome's
`strokes`; any other object's go out as `{ t: 'obj', id, feed: { push } | { clear: true } }`,
and `plugin_view` / `uobj_view` show the whole feed to agents. It's the
office's storage and bandwidth, so `feed` is a trusted permission.

## Workstation apps

The same modules can also run as apps on the desk computer. List one in
`public/js/apps.js` (`{ id, name, icon, plugin, wasm }`) and it shows up on
every workstation's desktop. It is called exactly like an object, with
`object.id` set to `ws-<app id>` and `object.zone` the caller's zone, but its
state is kept per person (in their `workstation` entity) instead of per
object, `nearby` is empty, and `say` is not broadcast: it's their own screen.
Agents reach it with the `workstation_app` MCP tool.

## Programs: the desk computer

The workstation itself is one of these modules too
(`plugins/wasm-workstation`), but run as a program rather than something you
walk up to: `PluginHost.program()` calls it with `action` set to a method
(`desktop`, `noteSave`, `run`…) and its params as JSON in `data`
(`Request::data_as` in the SDK, without the 16 KB cap actions get), and it answers with `reply`
(`Response::reply`) or `error` (`Response::fail`, which keeps the old state).
Only modules the office ships run this way, never uploads, and they get no
permissions: `give`, `take` and `unlock` in the answer go nowhere. Because a
workstation holds whole notes, a program may keep up to about 1 MB of state
and answer with up to 1 MB (objects: 32 KB and 64 KB). `wakeAt` and `toast`
work as usual: the timer asks to be woken when it's due and its toast goes
to the owner's actor.

## Local development

- `just start`: the Node server. Objects run in worker threads.
- `just cf-dev`: the Worker in `wrangler dev`, objects in local Dynamic
  Workers.
- `just plugin-test`: every plugin's own tests, in Rust. `just test` covers
  the office's side (`test/plugins.test.js`: the contract and each
  shipped module running in the sandbox) and the rally in the office
  (`test/rally.test.js`).

## Music

The jukebox's songs are made in the browser, not streamed: each tune in
`public/js/music.js` (`TUNES`) is a tempo, key, scale, chord loop and a few
voice choices, and the melody, bass and drums are generated from a seed, the
same in every browser. Because the jukebox says when a song started
(`display.music.at`), everyone near it hears the same bar. Volume fades over
the area the jukebox stands in and a few steps past it; people in rooms don't
hear it. Press **N** or the ♪ pill to mute it for yourself (remembered).

To add a song, add a tune to `TUNES` and a track with the same `id` to
`TRACKS` in `plugins/wasm-jukebox/src/lib.rs`, `just plugin-build jukebox`,
and `just deploy`.
