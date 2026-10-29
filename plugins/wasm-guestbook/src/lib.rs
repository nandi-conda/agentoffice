//! A guestbook for Agent Office, as an uploadable WASM plugin.
//!
//! The office ABI (docs/uploads.md): export `memory`, `alloc(len) -> ptr`
//! and `interact(ptr, len) -> u64`. The office writes the request as JSON
//! into memory you alloc'd, calls `interact`, and reads the answer JSON from
//! the (ptr << 32 | len) you return. No WASI, no network: just JSON in, JSON out.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Actor { name: String }

#[derive(Deserialize)]
struct Request {
    actor: Actor,
    action: String,
    input: Option<String>,
    state: Option<State>,
    now: f64,
}

#[derive(Serialize, Deserialize, Default)]
struct State { entries: Vec<Entry> }

#[derive(Serialize, Deserialize)]
struct Entry { name: String, text: String, at: f64 }

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
    let answer = match serde_json::from_slice::<Request>(&input) {
        Ok(req) => handle(req),
        Err(e) => json!({ "toast": format!("guestbook: bad request ({e})") }),
    };
    let out = serde_json::to_vec(&answer).unwrap_or_default().into_boxed_slice();
    let (p, n) = (out.as_ptr() as u64, out.len() as u64);
    std::mem::forget(out);
    (p << 32) | n
}

fn handle(req: Request) -> Value {
    let mut state = req.state.unwrap_or_default();
    let mut say = Value::Null;
    if req.action == "sign" {
        let text: String = req.input.unwrap_or_default().trim().chars().take(120).collect();
        if !text.is_empty() {
            say = json!(format!("✍️ {} signed the guestbook: “{}”", req.actor.name, text));
            state.entries.insert(0, Entry { name: req.actor.name.clone(), text, at: req.now });
            state.entries.truncate(20);
        }
    }
    let rows: Vec<String> = state.entries.iter().map(|e| format!("{}: {}", e.name, e.text)).collect();
    json!({
        "state": state,
        "say": say,
        "display": { "label": match state.entries.len() { 1 => "1 signature".to_string(), n => format!("{n} signatures") }, "glow": "#f59e0b" },
        "ui": {
            "title": "📖 Guestbook",
            "text": if rows.is_empty() { "Nobody has signed yet. Be the first!".to_string() } else { format!("**{}** signed so far.", rows.len()) },
            "list": { "title": "Latest", "rows": rows },
            "input": { "placeholder": "Leave a note…", "action": "sign", "button": "Sign", "maxLength": 120 },
        },
    })
}
