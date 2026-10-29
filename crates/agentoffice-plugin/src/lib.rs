//! Write [Agent Office](https://github.com/nandi-conda/agentoffice) objects
//! in Rust. People upload the `.wasm` you build (press **U** in the office),
//! put it on the floor, walk up and press **E**.
//!
//! An object is a type that implements [`Plugin`]. The type *is* the
//! object's memory: the office keeps it between calls (as JSON), and every
//! method gets it as `self`.
//!
//! ```
//! use agentoffice_plugin::prelude::*;
//!
//! /// A button that counts how often it was pressed.
//! #[derive(Serialize, Deserialize, Default)]
//! struct Counter { presses: u32 }
//!
//! impl Plugin for Counter {
//!     const MANIFEST: Manifest = Manifest::new("Counter")
//!         .prompt("Press the button")
//!         .emoji("🔢")
//!         .actions(&[Action::new("press", "Press it")]);
//!
//!     fn on_action(&mut self, req: &Request) -> Response {
//!         if req.is("press") { self.presses += 1; }
//!         Response::new()
//!     }
//!
//!     fn panel(&self, _req: &Request) -> Option<Ui> {
//!         Some(Ui::new("🔢 Counter").text(format!("Pressed **{}** times.", self.presses)).primary("Press", "press"))
//!     }
//! }
//!
//! export_plugin!(Counter);
//! ```
//!
//! What this crate does for you:
//!
//! - the ABI (`memory`, `alloc`, `interact`, JSON in and out) via [`export_plugin!`];
//! - your state loaded before each call and saved after it when it changed;
//! - a panel builder ([`Ui`]), inventory helpers ([`Request::count`], [`Give`]);
//! - randomness from the office ([`Request::rng`], [`Request::pick`]), since
//!   WASM has none of its own;
//! - a [`Manifest`], checked at compile time and embedded in the module, which
//!   the office reads on upload so the form fills itself in and agents see
//!   your actions in `gallery_view`;
//! - [`testing::TestOffice`], to try it with `cargo test` the way the
//!   office would call it.
//!
//! Build with `just plugin-build <name>`. See docs/uploads.md.

pub mod manifest;
mod request;
mod response;
#[cfg(not(target_arch = "wasm32"))]
pub mod testing;

pub use manifest::{Action, Look, Manifest, Permission};
pub use request::{Actor, Booking, Event, Item, Object, Person, Request, Rng, Room};
pub use response::{Button, Display, Give, Input, List, Music, Note, Response, Row, Take, Ui, Unlock};
#[doc(hidden)]
pub use serde;
#[doc(hidden)]
pub use serde_json;

/// Everything a plugin usually needs, including serde's derives.
pub mod prelude {
    pub use crate::{export_plugin, log, stamp, Action, Actor, Booking, Display, Event, Give, Input, Item, Look, Manifest, Note, Permission, Person, Plugin, Request, Response, Rng, Room, Row, Ui};
    pub use serde::{Deserialize, Serialize};
    pub use serde_json::{json, Value};
}

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

/// An object in the office. The type is its memory: derive `Serialize`,
/// `Deserialize` and `Default` (the state it starts with). It's kept as JSON
/// (32 KB at most); add new fields with `#[serde(default)]` so older saved
/// state still loads.
///
/// Override what you need. [`interact`](Plugin::interact) sends `use` to
/// [`on_use`](Plugin::on_use), `tick` to [`on_tick`](Plugin::on_tick), zone
/// events to [`on_enter`](Plugin::on_enter) / [`on_exit`](Plugin::on_exit) and
/// every other action to [`on_action`](Plugin::on_action), then fills in
/// the panel from [`panel`](Plugin::panel) and the label from
/// [`display`](Plugin::display) when the answer left them out.
pub trait Plugin: Serialize + DeserializeOwned + Default {
    /// What the object is called, how it looks, which actions it takes.
    const MANIFEST: Manifest;

    /// Someone walked up and pressed E. Usually nothing to do: the panel
    /// comes from [`panel`](Plugin::panel).
    fn on_use(&mut self, _req: &Request) -> Response {
        Response::new()
    }

    /// Someone picked an action on your panel (`req.action`, with `req.input`
    /// for an input box). Unknown actions get a toast by default.
    fn on_action(&mut self, req: &Request) -> Response {
        Response::error(format!("{} doesn't know how to {}", Self::MANIFEST.name, req.action))
    }

    /// The office's wake-up call, at the `wake_at` you asked for. No one is
    /// looking: `say` and `display` go out, the panel doesn't.
    fn on_tick(&mut self, _req: &Request) -> Response {
        Response::new()
    }

    /// `req.actor` walked into `zone`, one you asked to watch
    /// ([`Response::watch`]). No panel opens: a `toast` goes to them, and
    /// `say`, `display`, `give` and `wake_at` work as usual.
    fn on_enter(&mut self, _zone: &str, _req: &Request) -> Response {
        Response::new()
    }

    /// `req.actor` walked out of `zone`, one you watch.
    fn on_exit(&mut self, _zone: &str, _req: &Request) -> Response {
        Response::new()
    }

    /// The panel for whoever is using it, after on_use or on_action.
    fn panel(&self, _req: &Request) -> Option<Ui> {
        None
    }

    /// What everyone sees on the object: a label, a glow. The office only
    /// sends it on when it changes.
    fn display(&self) -> Option<Display> {
        None
    }

    /// The whole call. Override it to do your own dispatch.
    fn interact(&mut self, req: &Request) -> Response {
        let mut res = if let Some(zone) = req.entered() {
            self.on_enter(zone, req)
        } else if let Some(zone) = req.exited() {
            self.on_exit(zone, req)
        } else {
            match req.action.as_str() {
                "use" => self.on_use(req),
                "tick" => self.on_tick(req),
                _ => self.on_action(req),
            }
        };
        if res.ui.is_none() && !req.is_tick() && req.event.is_none() {
            res.ui = self.panel(req);
        }
        if res.display.is_none() {
            res.display = self.display();
        }
        res
    }
}

/// Run one call: request JSON in, answer JSON out. What `interact` does
/// inside the module, and what [`testing::TestOffice`] calls natively.
pub fn handle_json<P: Plugin>(input: &[u8]) -> Vec<u8> {
    let answer = match serde_json::from_slice::<request::RawRequest>(input) {
        Err(e) => Response::error(format!("bad request ({e})")),
        Ok(raw) => {
            let (saved, req) = raw.split();
            let loaded = if saved.is_null() { Ok(P::default()) } else { serde_json::from_value::<P>(saved.clone()) };
            match loaded {
                Err(e) => Response::error(format!("{}: its saved state doesn't fit ({e})", P::MANIFEST.name)),
                Ok(mut plugin) => {
                    let mut res = plugin.interact(&req);
                    // Save the plugin when it changed (or on the first call).
                    // (A failed program call keeps the state it had.)
                    let now = serde_json::to_value(&plugin).unwrap_or(Value::Null);
                    res.state = (res.error.is_none() && (now != saved || req.fresh)).then_some(now);
                    res
                }
            }
        }
    };
    serde_json::to_vec(&answer).unwrap_or_else(|e| format!("{{\"toast\":\"couldn't encode the answer: {e}\"}}").into_bytes())
}

/// A time (epoch ms) for text people read: the browser shows it as a
/// 12-hour clock in their own time zone. WASM doesn't know anyone's zone,
/// so never format times yourself; works in `say`, `toast` and panels.
pub fn stamp(ms: f64) -> String { format!("<t:{}>", ms.round() as i64) }

/// A line in the office's log (`just cf-tail`, or the Node console). On
/// native builds it prints to stderr, and [`testing::TestOffice`] collects it.
pub fn log(line: impl AsRef<str>) {
    let line = line.as_ref();
    #[cfg(target_arch = "wasm32")]
    unsafe {
        abi::office_log(line.as_ptr(), line.len())
    }
    #[cfg(not(target_arch = "wasm32"))]
    testing::push_log(line);
}

/// The ABI glue [`export_plugin!`] expands to. Not for calling directly.
#[doc(hidden)]
pub mod abi {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    #[link(wasm_import_module = "office")]
    extern "C" {
        #[link_name = "log"]
        pub fn office_log(ptr: *const u8, len: usize);
    }

    /// `alloc(len) -> ptr`: room for the office to write the request into.
    pub fn alloc(len: usize) -> *mut u8 {
        let mut buf = Vec::<u8>::with_capacity(len);
        let ptr = buf.as_mut_ptr();
        std::mem::forget(buf);
        ptr
    }

    /// `interact(ptr, len) -> (out_ptr << 32) | out_len`.
    ///
    /// # Safety
    /// `ptr` must come from [`alloc`] with this `len`, filled by the office.
    pub unsafe fn interact<P: Plugin>(ptr: *mut u8, len: usize) -> u64 {
        let input = Vec::from_raw_parts(ptr, len, len);
        let out = handle_json::<P>(&input).into_boxed_slice();
        let (p, n) = (out.as_ptr() as u64, out.len() as u64);
        std::mem::forget(out);
        (p << 32) | n
    }
}

/// Make a [`Plugin`] the module's object: exports `alloc` and `interact`,
/// and embeds its [`Manifest`] in the `agentoffice.manifest` custom section.
/// One per crate. The manifest is checked at compile time, so a bad one
/// fails `cargo build` and `cargo test` alike.
#[macro_export]
macro_rules! export_plugin {
    ($plugin:ty) => {
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            const LEN: usize = $crate::manifest::encode::<0>(&<$plugin as $crate::Plugin>::MANIFEST).len;

            #[unsafe(link_section = "agentoffice.manifest")]
            #[used]
            static MANIFEST: [u8; LEN] = $crate::manifest::encode::<LEN>(&<$plugin as $crate::Plugin>::MANIFEST).buf;

            #[unsafe(no_mangle)]
            pub extern "C" fn alloc(len: usize) -> *mut u8 {
                $crate::abi::alloc(len)
            }

            #[unsafe(no_mangle)]
            pub extern "C" fn interact(ptr: *mut u8, len: usize) -> u64 {
                unsafe { $crate::abi::interact::<$plugin>(ptr, len) }
            }
        };

        // Natively (cargo test) there's nothing to export: check the
        // manifest, and keep the plugin from looking unused.
        #[cfg(not(target_arch = "wasm32"))]
        const _: () = {
            let _ = $crate::manifest::encode::<0>(&<$plugin as $crate::Plugin>::MANIFEST).len;
            let _ = $crate::handle_json::<$plugin>;
        };
    };
}
