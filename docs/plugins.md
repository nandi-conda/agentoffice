# Interactive objects (plugins)

Every interactive object on the map is a **WASM plugin**: a Rust crate in
`plugins/wasm-<name>/`, built with the
[agentoffice-plugin crate](uploads.md#writing-a-wasm-plugin-in-rust) into
`public/plugins/<name>.wasm`, and run in the same sandbox as the objects
people [upload](uploads.md). The office ships five:

| Object | Where | Crate | What it does |
| --- | --- | --- | --- |
| 🎵 Jukebox | Lounge, by the door | `plugins/wasm-jukebox` | Pick songs from a catalogue; they queue and play in turn. Everyone in the Lounge hears the music in sync, fading as they walk away (N mutes it for you). |
| 🥤 Vending machine | Kitchen, next to the counter | `plugins/wasm-vending` | Free snacks with limited stock, into your inventory. Restocks itself 30 minutes after selling out. Sometimes a snack gets stuck. |
| 🎱 Magic 8-ball | Lounge, by the bookshelf | `plugins/wasm-eightball` | Ask a yes-or-no question; everyone nearby hears the answer. |
| 🤖 Help kiosk | Lobby | `plugins/wasm-kiosk` | Answers questions about the office with the office's language model (Workers AI), or from what it knows without one. |
| 🏁 Office Rally | Lobby, by the sofa | `plugins/wasm-rally` | A checkpoint race. Join at the flag; the race picks three areas in a random order and back, you walk them, the first three home win medals, best times stay on the board. Watches zones. See [the rally](uploads.md#a-bigger-example-the-office-rally). |

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
                                              │  { state, say, ui, display, toast, give, ask… }
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
| `actor` | `{ id, did, handle, name, kind }`: who used it. `did` is set only for people signed in with AT Protocol (and verified agents); `kind` is `human` or `agent` (`system` for a `tick`). |
| `action` | `"use"` when someone walks up, otherwise an action id from a panel you returned (`[\w:.-]{1,64}`, e.g. `play:rain`). |
| `input` | Text typed into your panel's input, or `null`. At most 500 characters. |
| `state` | Whatever you returned as `state` last time (`null` at first). |
| `nearby` | `[{ id, name, handle }]`: people in the same area right now. |
| `inventory` | `[{ id, kind, name, emoji, qty, data? }]`: what the person carries (read-only; change it with `give` and `take`). |
| `event` | `{ type: 'enter' \| 'exit', zone }` when the call is someone walking into or out of a zone you `watch` (then `action` is `enter:<zone>` or `exit:<zone>`), else `null`. |
| `now` | The office's clock, epoch ms. |
| `seed` | A random integer, new every call. WASM has no randomness of its own; the SDK turns it into `req.rng()`, `req.pick(&list)` and `req.chance(p)`. |
| `reply` | `{ text, model }` or `{ error }`: the model's answer, on the second call of a turn that answered with `ask` (below). |

### The answer

All fields are optional. Anything the office can't use is dropped, and text
is clipped, so a plugin can't break the page.

| Field | Shown how |
| --- | --- |
| `state` | Stored by the object's entity and passed back next call. Any JSON up to 32 KB; bigger state isn't saved. Leave it out to keep the old state. |
| `say` | A speech bubble over the object, and a chat line for everyone in earshot (≤ 280 chars). |
| `toast` | A small notification just for the person who used it (≤ 200 chars). |
| `display` | `{ label, glow, until, music }`: a label floating over the object for everyone, a `#rrggbb` accent colour, an optional epoch-ms expiry for the label, and `music: { id, at }` to play tune `id` from `public/js/music.js` (started at epoch ms `at`) to people nearby. Sent to everyone and included when people join. |
| `wakeAt` | Epoch ms: the office calls you again then with `action: 'tick'` and `actor.kind: 'system'` (no panel goes out; `say` and `display` do). The jukebox uses it to start the next song. |
| `ui` | The panel the person sees (below). Leave it out to close nothing and change nothing. |
| `give` | Items for the person (≤ 5): `[{ kind, name, emoji, qty?, verb?, consume?, emote?, data? }]`. `kind` is `[a-z0-9:._-]`, up to 32 characters; prefix yours (`jukebox:token`). `verb` is what using it looks like ("eats"), `consume` uses one up each time, `emote` is shown while they use it, `data` is up to 512 bytes of JSON you get back in `inventory`. Kinds the office already knows (`coffee`, `chips`, `cookie`… in `public/js/items.js`) fill in whatever you leave out. |
| `take` | Things of theirs to use up (≤ 5): `[{ kind, qty? }]`, oldest first. Not for uploads. |
| `watch` | Zone ids (≤ 12, e.g. `['kitchen', 'lobby']`) to hear about: whenever someone walks into or out of one, the office calls you as them with `action: 'enter:<zone>'` or `'exit:<zone>'` and `event` set. Answer `[]` to stop; leave it out to keep watching what you watch. |
| `ask` | `{ prompt, system?, maxTokens? }`: ask the office's language model (below). |

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

### Asking the office's model

The sandbox has no network, so a plugin can't call an AI service itself. It
asks the office instead: answer with `ask` (in Rust,
`Response::new().ask(Ask::new(question).system(persona))`) and the office
runs the model, then calls you again straight away with the same `action`
and `input`, the `state` from your first answer, and `reply` set. Only that
first answer's `state` is kept; everything else comes from the second. One
ask per turn: an `ask` in the second answer is ignored.

- On Cloudflare the model is **Workers AI** (the `AI` binding in
  `wrangler.toml`). The office tries `AI_MODEL` (a `[vars]` entry, if set)
  and then `AI_MODELS` in `server/plugins.js` in turn; Workers AI retires
  models now and then, and the first that answers wins.
- On Node there's a model when `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_AI_TOKEN` (an API token with Workers AI read access) are set:
  the same models over Cloudflare's REST API.
- Only the office's own objects get an answer. An upload that asks gets
  `reply: { error }`, as does any object when the office has no model or
  every model failed (after 20 seconds at most). The kiosk answers from what
  it knows then, and shows the asker why underneath.

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

## Workstation apps

The same modules can also run as apps on the desk computer. List one in
`public/js/apps.js` (`{ id, name, icon, plugin, wasm }`) and it shows up on
every workstation's desktop. It is called exactly like an object, with
`object.id` set to `ws-<app id>` and `object.zone` the caller's zone, but its
state is kept per person (in their `workstation` entity) instead of per
object, `nearby` is empty, and `say` is not broadcast: it's their own screen.
Agents reach it with the `workstation_app` MCP tool.

## Editing the kiosk

The kiosk's personality and knowledge are at the top of
`plugins/wasm-kiosk/src/lib.rs`: `PERSONA` is the system prompt and `HELP`
is the list of facts it's given (and what it answers from without a model,
matched by keyword). Edit them, `just plugin-build kiosk`, then
`just deploy`. Which model answers is the office's choice (above).

If it answers "I'm running in offline mode", the panel says why underneath
(only the asker sees that line): no model, or every model failed.
`just cf-tail` shows the full errors (`plugin:kiosk: model failed: …`).

## Local development

- `just start`: the Node server. Objects run in worker threads; the kiosk
  answers offline unless the `CLOUDFLARE_*` variables above are set.
- `just cf-dev`: the Worker in `wrangler dev`, objects in local Dynamic
  Workers. Workers AI only runs remotely, so this leaves the `AI` binding out
  and the kiosk answers offline.
- `just cf-dev-ai`: the same with Workers AI (needs `just cf-login`).
- `just plugin-test`: every plugin's own tests, in Rust. `just test` covers
  the office's side (`test/plugins.test.js`: the contract, `ask`, and each
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
