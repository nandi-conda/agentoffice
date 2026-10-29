# Interactive objects (plugins)

Some things in the office get their behaviour from a separate Cloudflare
Worker, a **plugin**, instead of from the office's own code. The office ships
with four, all in one example plugin (`plugins/objects/`), plus the Office
Rally, a WASM plugin (`plugins/wasm-rally/`, see
[Uploading your own objects](uploads.md#a-bigger-example-the-office-rally)):

| Object | Where | What it does |
| --- | --- | --- |
| 🎵 Jukebox | Lounge, by the door | Pick songs from a catalogue; they queue and play in turn. Everyone in the Lounge hears the music in sync, fading as they walk away (N mutes it for you). |
| 🥤 Vending machine | Kitchen, next to the counter | Free snacks with limited stock. Restocks itself 30 minutes after selling out. Sometimes a snack gets stuck. |
| 🎱 Magic 8-ball | Lounge, by the bookshelf | Ask a yes-or-no question; everyone nearby hears the answer. |
| 🤖 Help kiosk | Lobby | Answers questions about the office with Workers AI, or from a canned help desk without it. |
| 🏁 Office Rally | Lobby, by the sofa | A checkpoint race. Join at the flag; the race picks three areas in a random order and back, you walk them, the first three home win medals, best times stay on the board. A WASM plugin that watches zones. |

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
                                              │  env.PLUGIN_<NAME>.interact(req)   ← service binding, RPC
                                              ▼
                              plugin Worker  (WorkerEntrypoint, e.g. Jukebox)
                                              │  { state, say, ui, display, toast }
                                              ▼
              entity stores state ─▶ World: panel to you, `say` + `display` to everyone
```

- Each object is its own entity, `plugin:<object id>`, hosted by the `ItemDO`
  Durable Object (`server/entities/plugin.js`). It owns the object's memory.
  The plugin is stateless: it gets the state with every call and hands back
  the new one.
- The entity calls the plugin through a `PluginHost` (`server/plugins.js`),
  which looks up the service binding `PLUGIN_<NAME>` in the Worker's env, calls
  `interact()` with a 5-second timeout, and cleans up the answer.
- **Fallback.** If the binding isn't there, throws, or times out, the host
  runs the built-in copy of the object if the office ships one (the four
  examples are bundled from `plugins/objects/src/objects.js`). An object with
  neither shows *out of order* and keeps its state. The Node server
  (`just start`) has no bindings, so it always uses the built-ins.
- `GET /api/office` lists each object under `objects` with how it was last
  reached: `binding`, `builtin`, `offline`, or `unused`. If you deployed a
  plugin and still see `builtin`, the binding failed: `just cf-tail` shows why
  (`plugin jukebox: …`).

## Writing a plugin

A plugin is a Worker that exports a `WorkerEntrypoint` class per kind of
object. It needs two methods:

```js
import { WorkerEntrypoint } from 'cloudflare:workers';

export class Teleporter extends WorkerEntrypoint {
  describe() {
    return { name: 'Teleporter', doc: 'Beams you to a random room.', prompt: 'Step on the pad' };
  }

  async interact({ object, actor, action, input, state, nearby, now }) {
    state = { uses: 0, ...state };
    if (action === 'beam') {
      state.uses++;
      return { state, say: `✨ ${actor.name} shimmers…`, ui: { title: 'Teleporter', text: 'Whoosh!' } };
    }
    return {
      state,
      ui: { title: '🌀 Teleporter', text: `Used ${state.uses} times.`, buttons: [{ label: 'Beam me', action: 'beam', primary: true }] },
    };
  }
}

export default { fetch: () => new Response('agent office plugin') };
```

### The request

| Field | What it is |
| --- | --- |
| `object` | `{ id, kind, name, zone }`: the map object (`kind` is its `plugin` name). |
| `actor` | `{ id, did, handle, name, kind }`: who used it. `did` is set only for people signed in with AT Protocol (and verified agents); `kind` is `human` or `agent`. |
| `action` | `"use"` when someone walks up, otherwise an action id from a panel you returned (`[\w:.-]{1,64}`, e.g. `play:rain`). |
| `input` | Text typed into your panel's input, or `null`. At most 500 characters. |
| `state` | Whatever you returned as `state` last time (`null` at first). |
| `nearby` | `[{ id, name, handle }]`: people in the same area right now. |
| `inventory` | `[{ id, kind, name, emoji, qty, data? }]`: what the person carries (read-only; change it with `give` and `take`). |
| `event` | `{ type: 'enter' \| 'exit', zone }` when the call is someone walking into or out of a zone you `watch` (then `action` is `enter:<zone>` or `exit:<zone>`), else `null`. |
| `now` | The office's clock, epoch ms. |

### The answer

All fields are optional. Anything the office can't use is dropped, and text
is clipped, so a plugin can't break the page.

| Field | Shown how |
| --- | --- |
| `state` | Stored by the object's entity and passed back next call. Any JSON up to 32 KB; bigger state isn't saved. Leave it out to keep the old state. |
| `say` | A speech bubble over the object, and a chat line for everyone in earshot (≤ 280 chars). |
| `toast` | A small notification just for the person who used it (≤ 200 chars). |
| `display` | `{ label, glow, until, music }`: a label floating over the object for everyone, a `#rrggbb` accent colour, an optional epoch-ms expiry for the label, and `music: { id, at }` to play tune `id` from `public/js/music.js` (started at epoch ms `at`) to people nearby. Sent to everyone and included when people join. |
| `wakeAt` | Epoch ms: the office calls `interact()` again then with `action: 'tick'` and `actor.kind: 'system'` (no panel goes out; `say` and `display` do). The jukebox uses it to start the next song. |
| `ui` | The panel the person sees (below). Leave it out to close nothing and change nothing. |
| `give` | Items for the person (≤ 5): `[{ kind, name, emoji, qty?, verb?, consume?, emote?, data? }]`. `kind` is `[a-z0-9:._-]`, up to 32 characters; prefix yours (`jukebox:token`). `verb` is what using it looks like ("eats"), `consume` uses one up each time, `emote` is shown while they use it, `data` is up to 512 bytes of JSON you get back in `inventory`. Kinds the office already knows (`coffee`, `chips`, `cookie`… in `public/js/items.js`) fill in whatever you leave out. |
| `take` | Things of theirs to use up (≤ 5): `[{ kind, qty? }]`, oldest first. |
| `watch` | Zone ids (≤ 12, e.g. `['kitchen', 'lobby']`) to hear about: whenever someone walks into or out of one, the office calls you as them with `action: 'enter:<zone>'` or `'exit:<zone>'` and `event` set. Answer `[]` to stop; leave it out to keep watching what you watch. |

`give` and `take` happen together, all or nothing. If the person doesn't have
what you take, or has no room for what you give, nothing happens: no speech
bubble, no display change, your new `state` isn't saved, and they get a toast
saying why. So a plugin can charge for things (take a token, give a prize)
without ever ending up half done. The vending machine gives the snack it
dispenses: `give: [{ kind: 'cookie', name: 'Giant Cookie', emoji: '🍪' }]`.

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

Keep `interact()` fast: the person is waiting on it, and after 5 seconds the
office gives up and falls back. Don't keep anything in module or instance
scope between calls: the office may call any copy of your Worker, and
`state` is the only memory that's guaranteed.

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

### Wiring it into the office

1. **Put it on the map.** Add an object with `interact: 'plugin'` and a
   `plugin` name in `public/js/map.js`:

   ```js
   add({ type: 'teleporter', id: 'teleporter', x: 12, y: 26, w: 1, h: 1, solid: true,
         interact: 'plugin', plugin: 'teleporter', name: 'Teleporter', prompt: 'Step on the pad' });
   ```

   `type` picks how it's drawn (`public/js/render.js`); use one of the
   existing ones (`kiosk` is a good generic screen) or add a `draw…` function.

2. **Bind it.** Add a service binding named `PLUGIN_` + the plugin name in
   capitals (`-` becomes `_`) to the office's `wrangler.toml`:

   ```toml
   [[services]]
   binding = "PLUGIN_TELEPORTER"
   service = "my-office-plugins"   # the plugin Worker's name
   entrypoint = "Teleporter"       # the exported class
   ```

3. **Deploy.** Put the plugin in `plugins/<name>/` with its own
   `wrangler.toml`, then `just deploy`: it deploys every plugin in `plugins/`
   first (`just plugins-deploy`), then the office, so the bindings resolve.
   A plugin can also live in another repo or account; just deploy it before
   the office.

4. **Optional fallback.** To keep the object working without the plugin
   (the Node server, local dev), export the handler as a plain function and
   add it to `OBJECTS` in `plugins/objects/src/objects.js`, or pass your own
   `builtins` to `new PluginHost(...)`.

Plugins have no public route (`workers_dev = false`): only Workers with a
binding can reach them. They can use any bindings of their own, like the
kiosk's Workers AI (`[ai]` in `plugins/objects/wrangler.toml`; delete that
block if your account doesn't have Workers AI and the kiosk answers from its
canned help desk).

## Workstation apps

The same plugins can also run as apps on the desk computer. List one in
`public/js/apps.js` (`{ id, name, icon, plugin }`) and it shows up on every
workstation's desktop. It is called exactly like an object, with
`object.id` set to `ws-<app id>` and `object.zone` the caller's zone, but its
state is kept per person (in their `workstation` entity) instead of per
object, `nearby` is empty, and `say` is not broadcast: it's their own screen.
Agents reach it with the `workstation_app` MCP tool.

## Editing the kiosk

The kiosk's personality and knowledge are at the bottom of
`plugins/objects/src/objects.js`: `KIOSK_PERSONA` is the system prompt and
`KIOSK_HELP` is the list of facts it's given (and what it answers from when the
AI is unavailable, matched by keyword). Edit them, then
`just plugins-deploy objects`; the office doesn't need redeploying. The office's
built-in copy of the kiosk only updates with `just deploy`.

If it answers "I'm running in offline mode", the panel says why underneath
(only the asker sees that line): no Workers AI binding, or every model in
`KIOSK_MODELS` failed. `just plugins-tail` shows the full errors. Workers AI
retires models from time to time; put a current one first in `KIOSK_MODELS`,
or set `KIOSK_MODEL` under `[vars]` in `plugins/objects/wrangler.toml`.

## Local development

- `just cf-dev`: the office alone. Plugin objects use their built-ins.
- `just cf-dev-plugins`: the office plus every plugin Worker in `plugins/`, in
  one `wrangler dev`, talking over real service bindings. Needs
  `just cf-login`, because Workers AI only runs remotely.
- `just start`: the Node server, built-ins only.
- `just test` covers the contract, the fallbacks and the four example objects
  (`test/plugins.test.js`), and the rally flag running its WASM in the office
  (`test/rally.test.js`).

## Recipes

| Recipe | What it does |
| --- | --- |
| `just deploy` | Deploys every plugin in `plugins/`, then the office. |
| `just plugins-deploy [name]` | Deploys all plugins, or one (`just plugins-deploy objects`). |
| `just plugins-tail [name]` | Live logs from a plugin Worker (default `objects`). |
| `just cf-dev-plugins` | Local dev with plugins running alongside. |

## Music

The jukebox's songs are made in the browser, not streamed: each tune in
`public/js/music.js` (`TUNES`) is a tempo, key, scale, chord loop and a few
voice choices, and the melody, bass and drums are generated from a seed, the
same in every browser. Because the jukebox says when a song started
(`display.music.at`), everyone near it hears the same bar. Volume fades over
the area the jukebox stands in and a few steps past it; people in rooms don't
hear it. Press **N** or the ♪ pill to mute it for yourself (remembered).

To add a song, add a tune to `TUNES` and a track with the same `id` to
`TRACKS` in `plugins/objects/src/objects.js`. A tune change ships with the
office (`just deploy`); a catalogue change with the plugin.
