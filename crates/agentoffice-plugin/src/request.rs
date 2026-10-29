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
    /// Their server role: `owner`, `admin`, `moderator`, `member`, `agent`
    /// or `guest` (public/js/roles.js). `None` for the office itself.
    pub role: Option<String>,
}

impl Actor {
    pub fn is_human(&self) -> bool { self.kind == "human" }
    pub fn is_agent(&self) -> bool { self.kind == "agent" }
    /// The office itself, calling back at the `wake_at` you asked for.
    pub fn is_system(&self) -> bool { self.kind == "system" }
    /// Who they are across visits, the way the office keys people's things:
    /// their `did` when signed in, else `kind:name`.
    pub fn key(&self) -> String {
        match &self.did { Some(d) if !d.is_empty() => d.clone(), _ => format!("{}:{}", self.kind, self.name) }
    }
    /// A moderator or above (moderator, admin, owner): may tidy up after
    /// other people, like taking down someone else's note.
    pub fn is_moderator(&self) -> bool {
        matches!(self.role.as_deref(), Some("moderator" | "admin" | "owner"))
    }
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

/// Someone walked into or out of a zone you watch ([`Response::watch`]).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Event {
    /// `enter` or `exit`.
    #[serde(rename = "type")]
    pub kind: String,
    /// The zone id (`kitchen`, `lounge`…).
    pub zone: String,
}

/// A bookable meeting room, in [`Request::rooms`].
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Room {
    /// `boardroom`, `huddle`, `booth1`…: what [`Response::unlock`](crate::Response::unlock) takes.
    pub id: String,
    pub name: String,
    /// The meeting on in it now, if any.
    pub booking: Option<Booking>,
}

/// A meeting running now.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Booking {
    pub title: String,
    /// Who booked it.
    pub name: String,
    /// Epoch ms when it ends.
    pub until: f64,
    /// The actor is in the meeting already (booked it, invited, or let in).
    pub yours: bool,
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
    /// Set when the call is a zone you watch, not someone pressing E: the
    /// actor walked in or out (action `enter:<zone>` / `exit:<zone>`).
    pub event: Option<Event>,
    /// The office's clock, epoch ms.
    pub now: f64,
    /// A random number from the office, new every call: WASM has no
    /// randomness of its own. Use [`rng`](Request::rng), [`pick`](Request::pick)
    /// or [`chance`](Request::chance).
    pub seed: u64,
    /// What the office lets this plugin do beyond the basics (`take`,
    /// `unlock`): what its manifest declared and its uploader was allowed.
    pub permissions: Vec<String>,
    /// The bookable rooms and what's on in each now. Only sent to plugins
    /// with the `unlock` permission; empty otherwise.
    pub rooms: Vec<Room>,
}

impl Request {
    /// `req.is("sign")`
    pub fn is(&self, action: &str) -> bool { self.action == action }
    /// Someone walked up and pressed E.
    pub fn is_use(&self) -> bool { self.action == "use" }
    /// The wake-up call you asked for with `wake_at`.
    pub fn is_tick(&self) -> bool { self.action == "tick" }
    /// The zone the actor just walked into, when this call is that event.
    pub fn entered(&self) -> Option<&str> {
        self.event.as_ref().filter(|e| e.kind == "enter").map(|e| e.zone.as_str())
    }
    /// The zone the actor just walked out of, when this call is that event.
    pub fn exited(&self) -> Option<&str> {
        self.event.as_ref().filter(|e| e.kind == "exit").map(|e| e.zone.as_str())
    }
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
    /// Random numbers for this call, from the office's [`seed`](Request::seed).
    pub fn rng(&self) -> Rng { Rng::new(self.seed) }
    /// One of `list` at random (panics on an empty list). For more than one
    /// draw in a call, use one [`rng`](Request::rng).
    pub fn pick<'a, T>(&self, list: &'a [T]) -> &'a T { self.rng().pick(list) }
    /// True with probability `p` (0–1).
    pub fn chance(&self, p: f64) -> bool { self.rng().chance(p) }
    /// Whether the office granted `p` to this plugin.
    pub fn may(&self, p: crate::Permission) -> bool { self.permissions.iter().any(|x| x == p.as_str()) }
    /// A room from [`rooms`](Request::rooms) by id.
    pub fn room(&self, id: &str) -> Option<&Room> { self.rooms.iter().find(|r| r.id == id) }
}

/// A small random number generator (SplitMix64): plenty for dice and
/// shuffles, not for secrets.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self { Rng(seed ^ 0x9e37_79b9_7f4a_7c15) }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// In [0, 1).
    pub fn next_f64(&mut self) -> f64 { (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 }
    /// In [0, n) (0 when n is 0).
    pub fn below(&mut self, n: usize) -> usize { if n == 0 { 0 } else { (self.next_f64() * n as f64) as usize } }
    pub fn chance(&mut self, p: f64) -> bool { self.next_f64() < p }
    pub fn pick<'a, T>(&mut self, list: &'a [T]) -> &'a T { &list[self.below(list.len())] }
    pub fn shuffle<T>(&mut self, list: &mut [T]) {
        for i in (1..list.len()).rev() { list.swap(i, self.below(i + 1)); }
    }
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
    pub event: Option<Event>,
    pub now: f64,
    pub seed: u64,
    pub permissions: Vec<String>,
    pub rooms: Vec<Room>,
}

impl RawRequest {
    pub(crate) fn split(self) -> (Value, Request) {
        let fresh = self.state.is_null();
        (self.state, Request {
            object: self.object, actor: self.actor,
            action: self.action.unwrap_or_else(|| "use".into()),
            input: self.input, fresh,
            nearby: self.nearby, inventory: self.inventory, event: self.event, now: self.now,
            seed: self.seed,
            permissions: self.permissions, rooms: self.rooms,
        })
    }
}
