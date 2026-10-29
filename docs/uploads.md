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
  [`plugins/wasm-guestbook`](https://github.com/nandi-conda/agentoffice/tree/main/plugins/wasm-guestbook) (Rust).
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

## Writing a WASM plugin

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

Each call gets a fresh instance, so keep nothing in globals: the request
carries the object's `state`, and the `state` you answer with is what the
next call gets. The request and answer are exactly the
[plugin contract](plugins.md#the-request):

```json
{ "object": { "id": "u-…", "kind": "upload", "name": "Guestbook", "zone": "lobby" },
  "actor": { "id": "…", "did": "did:plc:…", "handle": "…", "name": "Ada", "kind": "human" },
  "action": "use", "input": null, "state": null, "nearby": [], "now": 1761700000000 }
```

```json
{ "state": { … }, "say": "…", "toast": "…",
  "display": { "label": "3 signatures", "glow": "#f59e0b" },
  "ui": { "title": "📖 Guestbook", "text": "…", "list": { "title": "Latest", "rows": ["…"] },
          "input": { "placeholder": "Leave a note…", "action": "sign", "button": "Sign" } } }
```

The Rust guestbook is the whole pattern in 80 lines
(`plugins/wasm-guestbook/src/lib.rs`):

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

Build it with:

```sh
rustup target add wasm32-unknown-unknown
cd plugins/wasm-guestbook
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/guestbook.wasm (about 85 KB)
```

`opt-level = "z"`, `lto = true` and `panic = "abort"` in `Cargo.toml` keep it
small.

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
