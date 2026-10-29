# Uploading your own objects

Anyone signed in with their AT Protocol handle can upload a plugin of their
own and put it on the office floor, no deploy needed. It works like the
built-in [plugin objects](plugins.md): people walk up, press **E**, and get
a panel; what it says shows up as a speech bubble and in the chat nearby.

- Press **U** (or 🧩 in the toolbar) to see what's out there, walk to one,
  or remove your own.
- Upload a `.wasm` file (or, on Cloudflare, a `.js` module), give it a name,
  a prompt, an emoji and a look, and press **Place it next to me**. It lands
  on the free tile next to you.
- **Try the example guestbook** in that panel uploads
  `public/plugins/guestbook.wasm`, built from
  [`plugins/wasm-guestbook`](https://github.com/nandi-conda/agentoffice/tree/main/plugins/wasm-guestbook)
  with the [Rust plugin crate](#writing-a-wasm-plugin-in-rust).
- A module that carries a [manifest](#the-manifest) fills in the form
  itself; you can still change anything.
- Agents can do the same over MCP: `gallery_view`, `gallery_upload` (with the
  file in base64) and `gallery_remove`; use one with `uobj_interact`
  (name = the object's id, `u-…`).

Limits: 3 objects per person and 40 in the office; WASM up to 512 KB, JS up
to 128 KB; 64 KB answers; the usual 32 KB of `state`. Only the uploader can
remove an object, plus anyone whose DID is in the office's `ADMIN_DIDS`
(comma-separated, a Worker var or env var).

Uploaded objects can hand out items with `give` (they land in the person's
inventory, see [plugins.md](plugins.md)). Anything more needs a
[permission](#permission-levels), and who may upload the plugin follows from it.

## Permission levels

A plugin lists what it needs beyond the basics in its manifest
(`.permissions(&[Permission::Unlock])`). Each permission belongs to a level,
and the level decides whose upload the office takes (`public/js/permissions.js`,
the capabilities `plugins.trusted` and `plugins.privileged` in
`public/js/roles.js`):

| Level | Permissions | Who can upload it |
| --- | --- | --- |
| basic | none: panels, `say`, `toast`, `display`, music, `give`, `wakeAt`, `watch` | anyone signed in |
| trusted | `take` (use up things the person carries), `feed` (keep a long list every browser gets, beyond the 32 KB of state: [the feed](plugins.md#the-feed)), `notify` (send notes to particular people anywhere in the office, kept for signed-in people who are away) | moderators, admins, owners |
| privileged | `unlock` (let whoever uses it into a meeting room someone else booked) | admins and owners |

The office keeps what was granted with the upload (`permissions` and `level`
in `gallery_view`) and only honours that: a `take` without the permission
or a note is dropped, an `unlock` refused with a
toast. The request says what the plugin has (`permissions`), and plugins
with `unlock` also get `rooms`. The office's own objects (public/plugins) get
whatever their manifest declares. JS uploads
have no manifest, so they're always basic. A moderator can still remove any
upload, privileged or not.

**The Skeleton Key** ([`plugins/wasm-skeleton-key`](https://github.com/nandi-conda/agentoffice/tree/main/plugins/wasm-skeleton-key),
built copy `public/plugins/skeleton_key.wasm`) is the privileged example:
admins see a "the Skeleton Key" link in the 🧩 panel. Its panel lists every
bookable room; for one that's booked and not yours, **open** lets you in as
if the meeting had admitted you (until it ends), and the people in the
meeting get a note that you let yourself in with the key. Anyone can use it
once an admin has put it out, so put it somewhere sensible.

## How they run

The office never runs uploaded code itself. A Cloudflare Worker isn't
allowed to compile WebAssembly from bytes at runtime, and it shouldn't run
strangers' code next to everyone's sessions anyway. Instead:

| Where | Sandbox | Runs | Limits |
| --- | --- | --- | --- |
| Cloudflare | a **Dynamic Worker** per upload, through the Worker Loader binding `LOADER` | WASM and JS | its own isolate; `globalOutbound: null` (no `fetch`, no network); no bindings; 50 ms CPU per call; 5 s wall clock |
| Node (`just start`) | a fresh **worker thread** per call | WASM only (Node has no safe way to run untrusted JS) | killed after 1 s; 5 s wall clock |

On upload the office checks a WASM file without compiling it: the header,
that it exports `memory`, `alloc` and `interact`, that it only imports what
the office provides (no WASI), and that it starts with at most 16 MiB of
memory. The code is stored in the object's own entity (`uobj:<id>`, an
`ItemDO`) next to its state; the list of objects, their places and owners
are in `gallery:main`.

### Turning it on on Cloudflare

Dynamic Workers need the **Workers Paid** plan ($5/month per account). The
binding is on in `wrangler.toml`, so `just deploy` turns uploads on:

```toml
[[worker_loaders]]
binding = "LOADER"
```

On the Free plan Cloudflare refuses the binding and the deploy fails;
`just deploy` (scripts/deploy.sh) spots that and says what to check: the plan
under **Workers & Pages → Plans** in the Cloudflare dashboard, and that
wrangler is logged in to the account you think (`wrangler whoami`). To deploy
on Free anyway, comment those two lines out. The office still runs without
them, but every interactive object is WASM run in this sandbox too
([plugins.md](plugins.md)), so the jukebox, vending machine, 8-ball
and rally show *out of order*; the upload panel says this office can't run
uploads, and `GET /api/office` shows objects and uploads as `offline`. Each upload is
one Dynamic Worker, kept warm by its id and code hash (`u-…@<sha>`). The
Paid plan includes 1,000 of them a month; past that it's $0.002 per Dynamic
Worker per day (waived during the beta), plus the usual CPU time.

With the binding on, `just cf-dev` runs Dynamic Workers locally too, so
uploads work in local dev.
(The CPU limit isn't enforced locally; the 5-second timeout still is.)

## Writing a WASM plugin in Rust

The `agentoffice-plugin` crate (`crates/agentoffice-plugin`) hides the ABI.
An object is a type that implements the `Plugin` trait, and the type *is*
the object's memory: the office keeps it between calls, and every method
gets it as `self`. Rust comes from pixi (conda-forge's `rust` plus the
`wasm32-unknown-unknown` std, in pixi's `rust` environment), so there's
nothing to install by hand.

```sh
just plugin-new dice        # plugins/wasm-dice, from a template with a test
just plugin-test dice       # cargo test: runs it in TestOffice, no office needed
just plugin-build dice      # → target/wasm32-unknown-unknown/release/dice.wasm, checked like an upload
```

Then press **U** in the office and upload the `.wasm`: the form fills itself
in from the manifest. `just plugin-build` with no name builds every
`plugins/wasm-*` and refreshes `public/plugins/guestbook.wasm`.

The guestbook (`plugins/wasm-guestbook/src/lib.rs`) is the whole pattern:

```rust
use agentoffice_plugin::prelude::*;

#[derive(Serialize, Deserialize, Default)]
struct Guestbook { entries: Vec<Entry> }

#[derive(Serialize, Deserialize)]
struct Entry { name: String, text: String, at: f64 }

impl Plugin for Guestbook {
    const MANIFEST: Manifest = Manifest::new("Guestbook")
        .doc("Leave a note for the office; the last 20 stay up.")
        .prompt("Sign the guestbook")
        .emoji("📖")
        .glow("#f59e0b")
        .look(Look::Plinth)
        .actions(&[Action::new("sign", "Sign the guestbook with a note").input("Your note, up to 120 characters")]);

    fn on_action(&mut self, req: &Request) -> Response {
        let note = req.text_clipped(120);
        if !req.is("sign") || note.is_empty() {
            return Response::new();
        }
        let say = format!("✍️ {} signed the guestbook: “{note}”", req.actor.name);
        self.entries.insert(0, Entry { name: req.actor.name.clone(), text: note, at: req.now });
        self.entries.truncate(20);
        Response::new().say(say)
    }

    fn panel(&self, _req: &Request) -> Option<Ui> {
        Some(Ui::new("📖 Guestbook")
            .list("Latest", self.entries.iter().map(|e| format!("{}: {}", e.name, e.text)))
            .input(Input::new("sign").placeholder("Leave a note…").button("Sign").max_length(120)))
    }

    fn display(&self) -> Option<Display> {
        Some(Display::label(format!("{} signatures", self.entries.len())).glow("#f59e0b"))
    }
}

export_plugin!(Guestbook);
```

### The `Plugin` trait

Your type derives `Serialize`, `Deserialize` and `Default` (`Default` is
the state a new object starts with). Before each call it's loaded from the
saved JSON; after the call it's saved again if it changed. Keep it under
32 KB, and add new fields with `#[serde(default)]` so an older object's
saved state still loads (if it doesn't, the person gets a toast and
nothing changes).

| Method | Called when | Default |
| --- | --- | --- |
| `const MANIFEST: Manifest` | (required) what it's called, how it looks, its actions | |
| `on_use(&mut self, req) -> Response` | someone walks up and presses E | nothing |
| `on_action(&mut self, req) -> Response` | someone picks an action on your panel (`req.action`, `req.input`) | a toast: unknown action |
| `on_tick(&mut self, req) -> Response` | the wake-up call you asked for with `.wake_at(ms)` (`actor.kind` is `system`; no panel goes out) | nothing |
| `on_enter(&mut self, zone, req) -> Response` | `req.actor` walked into a zone you watch (`.watch([...])`); no panel opens, a `toast` goes to them, `say`/`display`/`give`/`wake_at` work as usual | nothing |
| `on_exit(&mut self, zone, req) -> Response` | `req.actor` walked out of a zone you watch | nothing |
| `panel(&self, req) -> Option<Ui>` | after `on_use` / `on_action`, when the answer has no `ui` (never for ticks or zone events) | none |
| `display(&self) -> Option<Display>` | after every call, when the answer has no `display` | none |
| `interact(&mut self, req) -> Response` | every call: does the dispatch above | override it to dispatch yourself |

`export_plugin!(MyPlugin)` exports `alloc` and `interact` for it and embeds
its manifest. One per crate. It only exports on `wasm32`, so the same crate
builds natively for `cargo test`.

| Piece | What it gives you |
| --- | --- |
| `Request` | `object`, `actor` (`is_human`, `is_agent`, `is_system`, `mention`, `role`, `key()`: DID or `kind:name`, `is_moderator()`), `action` (`is`, `is_use`, `is_tick`, `arg("play")` for `play:rain`), `input` (`text`, `text_clipped`), `data` (`data_as::<T>()`: JSON sent with the action, ≤ 16 KB), `fresh` (first call ever), `nearby` (each with `did`, `kind`, `key()`), `inventory` (`count`, `has`, `item`), `event` (`entered()`, `exited()`: the zone, on a zone event; `office_event("book")`: the data of an event only the office sends, like the room panels' `book` and `unlock`; unlike `data`, nobody can send one from a panel), `now`, `seed` (`rng()`, `pick(&list)`, `chance(p)`: WASM has no randomness of its own, so the office sends a random seed every call), `permissions` (`may(Permission::Take)`: what the office granted), `rooms` (`room(id)`: each bookable room and the `booking` on now, with `yours`; only for plugins with `unlock`). |
| `Response` | Builder: `.say()`, `.say_opt()`, `.toast()`, `.display(Display::label(…).glow(…).until(…).music(…).data(…))` (`data`: any JSON ≤ 16 KB every browser gets), `.ui(…)`, `.give(…)`, `.wake_at()`, `.watch(["kitchen", "lobby"])` (≤ 12 zones; the office calls `on_enter`/`on_exit` as people walk in and out) and `.unwatch()`, `.take(kind, qty)` (needs `Permission::Take`), `.append(entry)` and `.clear_feed()` (the [feed](plugins.md#the-feed); need `Permission::Feed`), `.unlock(room_id)` (needs `Permission::Unlock`), `.notify(Note::to([...], text).outside(zone).keep().kind(..).re(..))` or `Note::inside(zone, text)` (≤ 10 notes; needs `Permission::Notify`), `.reply(data)` (≤ 16 KB for whoever called: the office's own calls, agents in `plugin_interact`). `Response::error(msg)` is just a toast. |
| `Ui` | `Ui::new(title).text(…).item(Row::new(label, action).detail(…).disabled(…)).list(title, rows).input(Input::new(action)…).button(label, action).primary(label, action)`. |
| `Give` | `Give::new("cookie")` (kinds the office knows fill in the rest) or your own `Give::new("dice:token").name(…).emoji(…).verb("plays").consume().data(…)`. |
| `stamp(ms)` | A time for text people read (`<t:ms>`): browsers show it as a 12-hour clock in their own zone. Never format times yourself. |
| `log("…")` | A line in the office log (`office.log`); `cargo test` prints it. |
| `TestOffice` | `cargo test` stand-in for the office (below): `.seed(n)` fixes the next call's seed (calls are repeatable anyway), `.grant_only(&[…])` plays an upload by someone without the role (by default it has every permission its manifest lists), `.book("board", "Grace", "Planning")` books a room now and `.unlocked()` lists who your plugin let in where; `.here(&["Ada"])` sets who's `nearby`, `.notes()` lists the notes sent, and `.office_call(name, action, kind, data)` makes a call with an office event. Using a permission you didn't declare is a warning. |

### The manifest

`Manifest::new(name)` with `.doc()`, `.prompt()`, `.emoji()`, `.glow()`,
`.look(Look::Plinth | Kiosk | Jukebox | Vending | EightBall)` and
`.actions(&[Action::new("id", "what it does").input("what to type")])` and
`.permissions(&[Permission::Take | Feed | Notify | Unlock])` ([levels](#permission-levels)). It's
a `const`, checked when you compile: a name over 40 characters, a glow that
isn't a colour or an action listed twice is a build error, not a surprise
on upload.

`export_plugin!` writes it as JSON into the module's `agentoffice.manifest`
custom section. The office reads it on upload without running anything:
whatever the uploader leaves blank (name, prompt, doc, emoji, colour, look)
comes from it, the upload panel fills its form from it, and the declared
actions are stored with the object as `api`. Agents see that `api` in
`gallery_view`, so they know what to send to `uobj_interact`, and the
example uploads in `public/plugins/` get an API reference page of their own
(`just docs`, e.g. [upload: Guestbook](api/upload-guestbook.md)).

### Testing without the office

`agentoffice_plugin::testing::TestOffice` calls your plugin the way the
office does: the request goes in as JSON and the answer comes out as JSON,
state is kept between calls, `give` lands in the person's inventory (or
bounces, all or nothing, when their hands are full), and anything the
office would clip or drop is a warning, as is a panel action your manifest
doesn't list.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn signing() {
        let mut office = TestOffice::<Guestbook>::new();
        assert!(office.use_as("Ada").ui.unwrap().list.unwrap().rows.is_empty());
        office.type_in("Ada", "sign", "hello");
        assert_eq!(office.state().entries.len(), 1);
        assert_eq!(office.said().len(), 1);
        office.assert_clean();
    }
}
```

It also has `act(who, action)`, `sign_in(who, handle)`, `agent(who)`, `role(who, "moderator")`,
`carry(who, kind, qty)`, `with_state(…)`, `inventory(who)`, `display()`,
`logs()`, `advance(ms)`, `tick()` (jump to your `wake_at` and make the
office's `tick` call), and `walk_in(who, zone)` / `walk_out(who, zone)`
with `watching()` (the zone event, delivered only if you watch that zone,
like the office). `just plugin-build` then runs the built module once
in the same Node sandbox `just start` uses, so you see the real thing
answer.

### A bigger example: the Office Rally

The rally flag in the Lobby is a WASM plugin too
([`plugins/wasm-rally`](https://github.com/nandi-conda/agentoffice/tree/main/plugins/wasm-rally),
built into `public/plugins/rally.wasm`): a checkpoint race that leans on
everything the object's Durable Object does for a plugin.

1. **Join** (`join`): the first racer starts a 20-second countdown, answered
   as `.wake_at(start)`. The office's alarm calls `on_tick` then.
2. **Start** (that tick, or `start`): it shuffles three checkpoints from the
   clock, adds the Lobby, and answers `.watch(route)`. The object's entity
   subscribes to those zones' enter/exit topics (pub/sub between Durable
   Objects) and turns each walk-in into an `on_enter` call. It also asks to
   be woken at one minute left, then at the end.
3. **Checkpoints** (`on_enter`): the next zone on your route counts, others
   are ignored; you get a toast with the next one.
4. **Finish** (`on_enter("lobby")` after the last one): your place and time
   go to everyone, and the first three get a medal with `.give(…)`, applied
   to their inventory all or nothing.
5. **Time** (everyone home, or the last tick): results go into the all-time
   board and the history in its state, and it answers `.unwatch()`.

The office runs one call per object at a time, so a walk-in and a button
press never race each other for the state. Agents play it over MCP with
`plugin_interact` (name `rally`) and `walk_to`.

The office's own WASM objects are listed in `public/js/map.js` with a
`wasm` file (`wasm: 'rally.wasm'`) and run in the same sandbox as uploads,
so on Cloudflare they need the Worker Loader binding too; the code is read
from the static assets (`ASSETS`). `just plugin-build rally` rebuilds it.

## The raw ABI (any language)

Any language that compiles to `wasm32` without WASI works: Rust, C, Zig,
TinyGo, AssemblyScript. The ABI is JSON in, JSON out:

| Export | Signature | What the office does with it |
| --- | --- | --- |
| `memory` | memory | reads and writes the JSON through it |
| `alloc` | `(len: i32) -> i32` | asks for `len` bytes to write the request into |
| `interact` | `(ptr: i32, len: i32) -> i64` | calls it with the request; reads the answer at `result >> 32`, `result & 0xffffffff` bytes long |

| Import (optional) | What it does |
| --- | --- |
| `office.log(ptr: i32, len: i32)` | logs a line (shows in `just cf-tail` / the Node console) |
| `env.abort(...)` | AssemblyScript's abort; throws |

| Custom section (optional) | What it holds |
| --- | --- |
| `agentoffice.manifest` | UTF-8 JSON, ≤ 8 KB: `{ "name", "prompt", "doc", "emoji", "glow", "look", "api": { "<action>": { "doc", "params": { "input": { "type": "string", "description" } } } } }` (the shape the crate's `export_plugin!` writes; read by `public/js/manifest.js`) |

Each call gets a fresh instance, so keep nothing in globals: the request
carries the object's `state`, and the `state` you answer with is what the
next call gets. The request and answer are exactly the
[plugin contract](plugins.md#the-request):

```json
{ "object": { "id": "u-…", "kind": "upload", "name": "Guestbook", "zone": "lobby" },
  "actor": { "id": "…", "did": "did:plc:…", "handle": "…", "name": "Ada", "kind": "human" },
  "action": "use", "input": null, "state": null, "nearby": [], "inventory": [], "now": 1761700000000 }
```

```json
{ "state": { … }, "say": "…", "toast": "…",
  "display": { "label": "3 signatures", "glow": "#f59e0b" },
  "ui": { "title": "📖 Guestbook", "text": "…", "list": { "title": "Latest", "rows": ["…"] },
          "input": { "placeholder": "Leave a note…", "action": "sign", "button": "Sign" } } }
```

Without the crate, the Rust glue is two functions (roughly what
`export_plugin!` expands to):

```rust
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn interact(ptr: *mut u8, len: usize) -> u64 {
    let input = unsafe { Vec::from_raw_parts(ptr, len, len) };
    let answer = handle(serde_json::from_slice(&input).unwrap());   // your logic
    let out = serde_json::to_vec(&answer).unwrap().into_boxed_slice();
    let (p, n) = (out.as_ptr() as u64, out.len() as u64);
    std::mem::forget(out);
    (p << 32) | n
}
```

`opt-level = "z"`, `lto = true` and `panic = "abort"` (the workspace
`Cargo.toml`'s release profile) keep modules small: the guestbook is about
115 KB.

## Writing a JS plugin (Cloudflare only)

A single ES module that exports `interact` (or a default object with
`interact`). No imports, no network.

```js
export function interact({ actor, action, input, state }) {
  state = { count: 0, ...state };
  if (action === 'roll') {
    state.count++;
    const n = 1 + Math.floor(Math.random() * 6);
    return { state, say: `🎲 ${actor.name} rolled a ${n}` };
  }
  return { state, ui: { title: '🎲 Dice', text: `Rolled ${state.count} times.`, buttons: [{ label: 'Roll', action: 'roll', primary: true }] } };
}
```
