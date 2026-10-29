//! What the office sends: who used the object, what they picked, what they
//! carry, and the object's state from last time.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The object on the map.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Object {
    /// `u-…` for uploads.
    pub id: String,
    /// `upload` for uploads.
    pub kind: String,
    pub name: String,
    /// The area it stands in (`lobby`, `lounge`…), if any.
    pub zone: Option<String>,
}

/// Who used it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Actor {
    pub id: String,
    /// Set only for people signed in with AT Protocol (and verified agents).
    pub did: Option<String>,
    pub handle: Option<String>,
    pub name: String,
    /// `human`, `agent`, or `system` for the office's own wake-up calls.
    pub kind: String,
}

impl Actor {
    pub fn is_human(&self) -> bool { self.kind == "human" }
    pub fn is_agent(&self) -> bool { self.kind == "agent" }
    /// The office itself, calling back at the `wake_at` you asked for.
    pub fn is_system(&self) -> bool { self.kind == "system" }
    /// `@handle` when signed in, else their name.
    pub fn mention(&self) -> String {
        match &self.handle { Some(h) if !h.is_empty() => format!("@{h}"), _ => self.name.clone() }
    }
}

/// Someone in the same area right now.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub handle: Option<String>,
}

/// A stack of things the person carries.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub emoji: String,
    pub qty: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verb: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub consume: bool,
    /// What you put in `data` when you gave it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl Item {
    /// Your `data`, as your own type.
    pub fn data_as<T: DeserializeOwned>(&self) -> Option<T> {
        self.data.clone().and_then(|d| serde_json::from_value(d).ok())
    }
}

/// One call of your plugin. Your state isn't in here: it's your plugin
/// itself (`&mut self`).
#[derive(Clone, Debug, Default)]
pub struct Request {
    pub object: Object,
    pub actor: Actor,
    /// `"use"` when someone walks up, `"tick"` for a wake-up call, else an
    /// action id from a panel you answered with.
    pub action: String,
    /// Text typed into your panel's input box.
    pub input: Option<String>,
    /// True when there was no state yet (the first call ever).
    pub fresh: bool,
    pub nearby: Vec<Person>,
    /// What the person carries (read-only; hand things out with `give`).
    pub inventory: Vec<Item>,
    /// The office's clock, epoch ms.
    pub now: f64,
}

impl Request {
    /// `req.is("sign")`
    pub fn is(&self, action: &str) -> bool { self.action == action }
    /// Someone walked up and pressed E.
    pub fn is_use(&self) -> bool { self.action == "use" }
    /// The wake-up call you asked for with `wake_at`.
    pub fn is_tick(&self) -> bool { self.action == "tick" }
    /// The part after `prefix:`: for action `play:rain`, `req.arg("play")` is `Some("rain")`.
    pub fn arg(&self, prefix: &str) -> Option<&str> {
        self.action.strip_prefix(prefix)?.strip_prefix(':')
    }
    /// The typed text, trimmed ("" when there's none).
    pub fn text(&self) -> &str { self.input.as_deref().unwrap_or("").trim() }
    /// The typed text, trimmed and cut to `max` characters.
    pub fn text_clipped(&self, max: usize) -> String { self.text().chars().take(max).collect() }
    /// How many of `kind` the person carries.
    pub fn count(&self, kind: &str) -> u32 {
        self.inventory.iter().filter(|i| i.kind == kind).map(|i| i.qty).sum()
    }
    /// Whether the person carries at least one `kind`.
    pub fn has(&self, kind: &str) -> bool { self.count(kind) > 0 }
    /// The first stack of `kind` they carry.
    pub fn item(&self, kind: &str) -> Option<&Item> { self.inventory.iter().find(|i| i.kind == kind) }
}

// The request as it arrives; the state is split off for the plugin.
#[derive(Deserialize, Serialize, Default)]
#[serde(default)]
pub(crate) struct RawRequest {
    pub object: Object,
    pub actor: Actor,
    pub action: Option<String>,
    pub input: Option<String>,
    pub state: Value,
    pub nearby: Vec<Person>,
    pub inventory: Vec<Item>,
    pub now: f64,
}

impl RawRequest {
    pub(crate) fn split(self) -> (Value, Request) {
        let fresh = self.state.is_null();
        (self.state, Request {
            object: self.object, actor: self.actor,
            action: self.action.unwrap_or_else(|| "use".into()),
            input: self.input, fresh,
            nearby: self.nearby, inventory: self.inventory, now: self.now,
        })
    }
}
