//! Write [Agent Office](https://github.com/nandi-conda/agentoffice) objects
//! in Rust. People upload the `.wasm` you build (press **U** in the office),
//! put it on the floor, walk up and press **E**; your handler gets a typed
//! [`Request`] and answers with a [`Response`].
//!
//! ```ignore
//! use agentoffice_plugin::prelude::*;
//!
//! #[derive(Serialize, Deserialize, Default)]
//! struct State { count: u32 }
//!
//! /// A button that counts how often it was pressed.
//! #[plugin(name = "Counter", prompt = "Press the button", emoji = "🔢",
//!          action("press", "Press it"))]
//! fn counter(mut req: Request<State>) -> Response<State> {
//!     if req.is("press") {
//!         req.state.count += 1;
//!     }
//!     let n = req.state.count;
//!     Response::new()
//!         .ui(Ui::new("🔢 Counter").text(format!("Pressed **{n}** times.")).primary("Press", "press"))
//!         .display(Display::label(format!("{n}")))
//!         .state(req.state)
//! }
//! ```
//!
//! What this crate does for you:
//!
//! - the ABI (`memory`, `alloc`, `interact`, JSON in and out) via
//!   [`#[plugin]`](macro@plugin) or [`export_plugin!`];
//! - your `state` typed and (de)serialized for you;
//! - a panel builder ([`Ui`]), inventory helpers ([`Request::count`], [`Give`]);
//! - a manifest embedded in the module, which the office reads on upload so
//!   the form fills itself in and agents see your actions in `gallery_view`;
//! - [`testing::TestOffice`], to try it with `cargo test` the way the
//!   office would call it.
//!
//! Build with `just plugin-build <name>` (or `cargo build --release --target
//! wasm32-unknown-unknown`). See docs/uploads.md.

mod request;
mod response;
#[cfg(not(target_arch = "wasm32"))]
pub mod testing;

pub use agentoffice_plugin_macros::plugin;
pub use request::{Actor, Item, Object, Person, Request};
pub use response::{Button, Display, Give, Input, IntoResponse, List, Music, Response, Row, Ui};
#[doc(hidden)]
pub use serde;
#[doc(hidden)]
pub use serde_json;

/// Everything a plugin usually needs, including serde's derives.
pub mod prelude {
    pub use crate::{log, plugin, Actor, Display, Give, Input, Item, Request, Response, Row, Ui};
    pub use serde::{Deserialize, Serialize};
    pub use serde_json::{json, Value};
}

use serde::{de::DeserializeOwned, Serialize};

/// Run one call: request JSON in, answer JSON out. What `interact` does
/// inside the module, and what [`testing::TestOffice`] calls natively.
pub fn handle_json<S, R, F>(input: &[u8], handler: F) -> Vec<u8>
where
    S: DeserializeOwned + Serialize + Default,
    R: IntoResponse<S>,
    F: FnOnce(Request<S>) -> R,
{
    let answer = match serde_json::from_slice::<request::RawRequest>(input) {
        Err(e) => Response::<S>::error(format!("bad request ({e})")),
        Ok(raw) => match raw.typed::<S>() {
            Ok(req) => handler(req).into_response(),
            Err(e) => Response::error(e),
        },
    };
    serde_json::to_vec(&answer).unwrap_or_else(|e| format!("{{\"toast\":\"couldn't encode the answer: {e}\"}}").into_bytes())
}

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
    pub unsafe fn interact<S, R, F>(ptr: *mut u8, len: usize, handler: F) -> u64
    where
        S: DeserializeOwned + Serialize + Default,
        R: IntoResponse<S>,
        F: FnOnce(Request<S>) -> R,
    {
        let input = Vec::from_raw_parts(ptr, len, len);
        let out = handle_json(&input, handler).into_boxed_slice();
        let (p, n) = (out.as_ptr() as u64, out.len() as u64);
        std::mem::forget(out);
        (p << 32) | n
    }
}

/// Export `handler` as the plugin, without a manifest (prefer
/// [`#[plugin]`](macro@plugin), which also embeds one). `handler` is a
/// `fn(Request<S>) -> impl IntoResponse<S>`. Only exports on `wasm32`, so the
/// same crate builds natively for `cargo test`.
#[macro_export]
macro_rules! export_plugin {
    ($handler:path) => {
        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn alloc(len: usize) -> *mut u8 {
            $crate::abi::alloc(len)
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn interact(ptr: *mut u8, len: usize) -> u64 {
            unsafe { $crate::abi::interact(ptr, len, $handler) }
        }

        // Natively the handler is only called from tests: that's not dead code.
        #[cfg(not(target_arch = "wasm32"))]
        const _: () = {
            let _ = $handler;
        };
    };
}
