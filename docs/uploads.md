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
inventory, see [plugins.md](plugins.md)) but can't `take` anyone's things:
the office drops a `take` from an upload.

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
binding is in `wrangler.toml`, commented out; uncomment it and `just deploy`:

```toml
[[worker_loaders]]
binding = "LOADER"
```

Without it the office still works; the upload panel says this office can't
run uploads, and `GET /api/office` shows uploads as `offline`. Each upload is
one Dynamic Worker, kept warm by its id and code hash (`u-…@<sha>`). The
Paid plan includes 1,000 of them a month; past that it's $0.002 per Dynamic
Worker per day (waived during the beta), plus the usual CPU time.

With the binding on, `just cf-dev` runs Dynamic Workers locally too, so
uploads work in local dev.
(The CPU limit isn't enforced locally; the 5-second timeout still is.)

## Writing a WASM plugin in Rust

The `agentoffice-plugin` crate (`crates/agentoffice-plugin`) hides the ABI:
you write one function from a typed request to a typed answer, and
`#[plugin]` exports it and embeds a **manifest** (name, prompt, emoji, look,
and the actions your panels send). Rust comes from pixi (conda-forge's
`rust` plus the `wasm32-unknown-unknown` std, in pixi's `rust` environment),
so there's nothing to install by hand.

```sh
just plugin-new dice        # plugins/wasm-dice, from a template with a test
just plugin-test dice       # cargo test: runs it in TestOffice, no office needed
just plugin-build dice      # → target/wasm32-unknown-unknown/release/dice.wasm, checked like an upload
```

Then press **U** in the office and upload the `.wasm`: the form fills itself
in from the manifest. `just plugin-build` with no name builds every
`plugins/wasm-*` and refreshes `public/plugins/guestbook.wasm`.

The guestbook (`plugins/wasm-guestbook/src/lib.rs`, trimmed a little here) is the whole pattern:

```rust
use agentoffice_plugin::prelude::*;

#[derive(Serialize, Deserialize, Default)]
struct State { entries: Vec<Entry> }

#[derive(Serialize, Deserialize)]
struct Entry { name: String, text: String, at: f64 }

/// Leave a note for the office; the last 20 stay up.
#[plugin(
    name = "Guestbook", prompt = "Sign the guestbook", emoji = "📖", glow = "#f59e0b", look = "plinth",
    action("sign", "Sign the guestbook with a note", input = "Your note, up to 120 characters"),
)]
fn guestbook(mut req: Request<State>) -> Response<State> {
    let note = req.text_clipped(120);
    let mut say = None;
    if req.is("sign") && !note.is_empty() {
        say = Some(format!("✍️ {} signed the guestbook: “{note}”", req.actor.name));
        req.state.entries.insert(0, Entry { name: req.actor.name.clone(), text: note, at: req.now });
        req.state.entries.truncate(20);
    }
    let rows: Vec<String> = req.state.entries.iter().map(|e| format!("{}: {}", e.name, e.text)).collect();
    Response::new()
        .say_opt(say)
        .display(Display::label(format!("{} signatures", rows.len())).glow("#f59e0b"))
        .ui(Ui::new("📖 Guestbook")
            .list("Latest", rows)
            .input(Input::new("sign").placeholder("Leave a note…").button("Sign").max_length(120)))
        .state(req.state)
}
```

| Piece | What it gives you |
| --- | --- |
| `Request<S>` | `object`, `actor` (`is_human`, `is_agent`, `is_system`, `mention`), `action` (`is`, `is_use`, `is_tick`, `arg("play")` for `play:rain`), `input` (`text`, `text_clipped`), `state: S` (`S::default()` the first time; `fresh` says so), `nearby`, `inventory` (`count`, `has`, `item`), `now`. |
| `Response<S>` | Builder: `.state()`, `.say()`, `.toast()`, `.display(Display::label(…).glow(…).until(…).music(…))`, `.ui(…)`, `.give(…)`, `.wake_at()`. Leave out `.state()` to keep the old state. `Response::error(msg)` is just a toast. A handler can also return `Result<Response<S>, E>`: the error becomes a toast, so `?` works. |
| `Ui` | `Ui::new(title).text(…).item(Row::new(label, action).detail(…).disabled(…)).list(title, rows).input(Input::new(action)…).button(label, action).primary(label, action)`. |
| `Give` | `Give::new("cookie")` (kinds the office knows fill in the rest) or your own `Give::new("dice:token").name(…).emoji(…).verb("plays").consume().data(…)`. Uploads can't `take`, so there's no `Take`. |
| `log("…")` | A line in the office log (`office.log`); `cargo test` prints it. |
| `#[plugin(…)]` | Exports `alloc` and `interact`, and puts the manifest in the module's `agentoffice.manifest` custom section. Keys: `name` (default: the function's name), `prompt`, `doc` (default: the `///` comment), `emoji`, `glow`, `look` (`plinth`, `kiosk`, `jukebox`, `vending`, `eightball`), and `action("id", "what it does", input = "what to type")` for each action. Bad values are compile errors. Also defines `MANIFEST`, the same JSON. |
| `export_plugin!(handler)` | The ABI without a manifest, if you'd rather not use the attribute. |

Your state is typed: if a new version's `State` can't read what an older
one saved, the person gets a toast saying so and nothing changes. Add new
fields with `#[serde(default)]` to keep old state working.

### The manifest

The office reads the manifest on upload without running anything:
whatever the uploader leaves blank (name, prompt, doc, emoji, colour, look)
comes from it, the upload panel fills its form from it, and the declared
actions are stored with the object as `api`. Agents see that `api` in
`gallery_view`, so they know what to send to `uobj_interact`, and the
example uploads in `public/plugins/` get an API reference page of their own
(`just docs`, e.g. [upload: Guestbook](api/upload-guestbook.md)). It's
optional: a module without one works as before.

### Testing without the office

`agentoffice_plugin::testing::TestOffice` calls your handler the way the
office does: the request goes in as JSON and the answer comes out as JSON,
state is kept between calls, `give` lands in the person's inventory (or
bounces, all or nothing, when their hands are full), and anything the
office would clip or drop is a warning.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn signing() {
        let mut office = TestOffice::new(guestbook).with_manifest(MANIFEST);
        assert!(office.use_as("Ada").ui.unwrap().text.contains("Nobody"));
        office.type_in("Ada", "sign", "hello");
        assert_eq!(office.state().entries.len(), 1);
        assert_eq!(office.said().len(), 1);
        office.assert_clean(); // no text over the office's limits, panel actions all in the manifest
    }
}
```

It also has `act(who, action)`, `sign_in(who, handle)`, `agent(who)`,
`carry(who, kind, qty)`, `inventory(who)`, `display()`, `logs()`,
`advance(ms)` and `tick()` (jump to your `wake_at` and make the office's
`tick` call). `just plugin-build` then runs the built module once in the
same Node sandbox `just start` uses, so you see the real thing answer.

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
| `agentoffice.manifest` | UTF-8 JSON, ≤ 8 KB: `{ "name", "prompt", "doc", "emoji", "glow", "look", "api": { "<action>": { "doc", "params": { "input": { "type": "string", "description" } } } } }` (the shape `#[plugin]` writes; read by `public/js/manifest.js`) |

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

Without the crate, the Rust glue is two functions (it's what
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
110 KB.

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
