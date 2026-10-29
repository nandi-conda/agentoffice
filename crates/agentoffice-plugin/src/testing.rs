//! Try a plugin with `cargo test`, the way the office would call it: the
//! request goes in as JSON and the answer comes back out as JSON, state is
//! kept between calls, `give` lands in (or bounces off) the person's
//! inventory, and anything the office would clip or refuse is flagged.
//!
//! ```
//! use agentoffice_plugin::prelude::*;
//! use agentoffice_plugin::testing::TestOffice;
//!
//! #[derive(Serialize, Deserialize, Default)]
//! struct Dice { rolls: u32 }
//!
//! impl Plugin for Dice {
//!     const MANIFEST: Manifest = Manifest::new("Dice").actions(&[Action::new("roll", "Roll it")]);
//!     fn on_action(&mut self, _req: &Request) -> Response { self.rolls += 1; Response::new() }
//!     fn panel(&self, _req: &Request) -> Option<Ui> {
//!         Some(Ui::new("🎲 Dice").text(format!("Rolled {} times.", self.rolls)).primary("Roll", "roll"))
//!     }
//! }
//!
//! let mut office = TestOffice::<Dice>::new();
//! assert_eq!(office.use_as("Ada").ui.unwrap().title, "🎲 Dice");
//! office.act("Ada", "roll");
//! assert_eq!(office.state().rolls, 1);
//! office.assert_clean();
//! ```

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Value};

use crate::{handle_json, Actor, Booking, Display, Item, Object, Permission, Person, Plugin, Response, Room};

/// The office's limits (server/plugins.js, server/sandbox.js, public/js/items.js).
pub mod limits {
    pub const ANSWER_BYTES: usize = 64 * 1024;
    pub const STATE_BYTES: usize = 32 * 1024;
    pub const SAY: usize = 280;
    pub const TOAST: usize = 200;
    pub const TITLE: usize = 60;
    pub const TEXT: usize = 1500;
    pub const ITEMS: usize = 24;
    pub const BUTTONS: usize = 6;
    pub const LIST_ROWS: usize = 20;
    pub const LABEL: usize = 40;
    pub const GIVE: usize = 5;
    pub const INPUT: usize = 500;
    pub const SLOTS: usize = 20;
    pub const STACK: u32 = 20;
    pub const WATCH: usize = 12;
    pub const DATA_BYTES: usize = 16 * 1024;
}

thread_local! {
    static LOGS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn push_log(line: &str) {
    eprintln!("[plugin] {line}");
    LOGS.with(|l| l.borrow_mut().push(line.to_string()));
}

fn take_logs() -> Vec<String> {
    LOGS.with(|l| std::mem::take(&mut *l.borrow_mut()))
}

fn valid_action(a: &str) -> bool {
    !a.is_empty() && a.len() <= 64 && a.chars().all(|c| c.is_ascii_alphanumeric() || "_:.-".contains(c))
}

fn valid_kind(k: &str) -> bool {
    let mut c = k.chars();
    k.len() <= 32 && c.next().is_some_and(|h| h.is_ascii_lowercase() || h.is_ascii_digit())
        && c.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ":._-".contains(ch))
}

/// A pretend office with one object: your plugin.
pub struct TestOffice<P> {
    /// The object as the plugin sees it (`u-test`, kind `upload`).
    pub object: Object,
    /// The office clock, epoch ms. Moves on 1 s per call; set it or [`advance`](Self::advance) it.
    pub now: f64,
    state: Value,
    people: HashMap<String, Actor>,
    inventories: HashMap<String, Vec<Item>>,
    display: Option<Display>,
    wake_at: Option<f64>,
    watching: Vec<String>,
    event_now: Option<Value>,
    said: Vec<String>,
    logs: Vec<String>,
    warnings: Vec<String>,
    manifest: Value,
    next_id: u32,
    seed: u64,
    granted: Vec<String>,
    rooms: Vec<Room>,
    unlocked: Vec<(String, String)>,
    plugin: std::marker::PhantomData<P>,
}

impl<P: Plugin> Default for TestOffice<P> {
    fn default() -> Self { Self::new() }
}

impl<P: Plugin> TestOffice<P> {
    /// An office with your plugin as its only object (no state yet), and
    /// nobody in it: people are made up as you name them.
    pub fn new() -> Self {
        TestOffice {
            object: Object { id: "u-test".into(), kind: "upload".into(), name: P::MANIFEST.name.into(), zone: Some("lobby".into()) },
            now: 1_761_700_000_000.0,
            state: Value::Null,
            people: HashMap::new(),
            inventories: HashMap::new(),
            display: None,
            wake_at: None,
            watching: Vec::new(),
            event_now: None,
            said: Vec::new(),
            logs: Vec::new(),
            warnings: Vec::new(),
            manifest: serde_json::from_str(&P::MANIFEST.to_json()).expect("the manifest is JSON"),
            next_id: 0,
            seed: 1,
            granted: P::MANIFEST.permissions.iter().map(|p| p.as_str().to_string()).collect(),
            rooms: [("booth1", "Booth 1"), ("booth2", "Booth 2"), ("booth3", "Booth 3"), ("board", "Boardroom"), ("huddle", "Huddle Room")]
                .into_iter().map(|(id, name)| Room { id: id.into(), name: name.into(), booking: None }).collect(),
            unlocked: Vec::new(),
            plugin: std::marker::PhantomData,
        }
    }

    /// Grant only these permissions, as when someone without the role for
    /// the rest uploaded it. By default the plugin has every permission its
    /// manifest lists (an uploader with the role for them).
    pub fn grant_only(&mut self, permissions: &[Permission]) -> &mut Self {
        self.granted = permissions.iter().map(|p| p.as_str().to_string()).collect();
        self
    }

    /// `owner` booked `room` (`board`, `huddle`, `booth1`…) for a meeting
    /// running now, for an hour. Everyone else is kept out, unless let in.
    pub fn book(&mut self, room: &str, owner: &str, title: &str) -> &mut Self {
        let until = self.now + 3_600_000.0;
        let r = self.rooms.iter_mut().find(|r| r.id == room).unwrap_or_else(|| panic!("no bookable room {room:?}"));
        r.booking = Some(Booking { title: title.into(), name: owner.into(), until, yours: false });
        self.unlocked.retain(|(id, _)| id != room);
        self
    }

    /// Who the plugin let into which booked room, as (room, name), oldest first.
    pub fn unlocked(&self) -> &[(String, String)] { &self.unlocked }

    /// The `seed` the next call gets (each call after that gets a new one).
    /// Calls are repeatable: the same seeds every run.
    pub fn seed(&mut self, seed: u64) -> &mut Self { self.seed = seed; self }

    /// Start from this state instead of none.
    pub fn with_state(mut self, state: P) -> Self {
        self.state = serde_json::to_value(state).expect("state is JSON");
        self
    }

    fn actor(&mut self, name: &str) -> Actor {
        self.people.entry(name.to_string()).or_insert_with(|| Actor {
            id: name.to_lowercase().replace(' ', "-"), did: None, handle: None, name: name.into(), kind: "human".into(), role: Some("guest".into()),
        }).clone()
    }

    /// `name` is signed in with an AT Protocol handle (so has a `did`).
    pub fn sign_in(&mut self, name: &str, handle: &str) -> &mut Self {
        let mut a = self.actor(name);
        a.handle = Some(handle.into());
        a.did = Some(format!("did:plc:{}", handle.replace('.', "")));
        if a.role.as_deref() == Some("guest") { a.role = Some("member".into()); }
        self.people.insert(name.into(), a);
        self
    }

    /// `name` is an AI agent.
    pub fn agent(&mut self, name: &str) -> &mut Self {
        let mut a = self.actor(name);
        a.kind = "agent".into();
        self.people.insert(name.into(), a);
        self
    }

    /// Give `name` a server role (`moderator`, `admin`…).
    pub fn role(&mut self, name: &str, role: &str) -> &mut Self {
        let mut a = self.actor(name);
        a.role = Some(role.into());
        self.people.insert(name.into(), a);
        self
    }

    /// Put things in `name`'s inventory before they walk up.
    pub fn carry(&mut self, name: &str, kind: &str, qty: u32) -> &mut Self {
        self.next_id += 1;
        let item = Item { id: format!("i{}", self.next_id), kind: kind.into(), name: kind.into(), emoji: "📦".into(), qty, ..Default::default() };
        self.inventories.entry(name.into()).or_default().push(item);
        self
    }

    /// `name` walks up and presses E.
    pub fn use_as(&mut self, name: &str) -> Response { self.call(name, "use", None) }

    /// `name` picks `action` on your panel.
    pub fn act(&mut self, name: &str, action: &str) -> Response { self.call(name, action, None) }

    /// `name` types `text` into your input box and sends `action`.
    pub fn type_in(&mut self, name: &str, action: &str, text: &str) -> Response {
        assert!(text.chars().count() <= limits::INPUT, "the office sends at most {} characters of input", limits::INPUT);
        self.call(name, action, Some(text))
    }

    /// Jump the clock to the `wake_at` you asked for and make the office's
    /// `tick` call. Panics if nothing asked to be woken.
    pub fn tick(&mut self) -> Response {
        let at = self.wake_at.take().expect("the plugin didn't ask for a wake-up (wake_at)");
        self.now = self.now.max(at);
        let system = Actor { id: "system".into(), did: None, handle: None, name: "the office".into(), kind: "system".into(), role: None };
        self.run(system, "tick", None)
    }

    pub fn advance(&mut self, ms: f64) -> &mut Self { self.now += ms; self }

    /// `name` walks into `zone`. Like the office, the plugin only hears about
    /// it if it watches that zone; returns `None` when it doesn't.
    pub fn walk_in(&mut self, name: &str, zone: &str) -> Option<Response> { self.event(name, "enter", zone) }

    /// `name` walks out of `zone` (only heard when watched).
    pub fn walk_out(&mut self, name: &str, zone: &str) -> Option<Response> { self.event(name, "exit", zone) }

    fn event(&mut self, name: &str, kind: &str, zone: &str) -> Option<Response> {
        if !self.watching.iter().any(|z| z == zone) { return None; }
        let who = self.actor(name);
        self.event_now = Some(json!({ "type": kind, "zone": zone }));
        let mut r = self.run(who, &format!("{kind}:{zone}"), None);
        r.ui = None; // the office opens no panel for an event
        Some(r)
    }

    fn call(&mut self, name: &str, action: &str, input: Option<&str>) -> Response {
        assert!(valid_action(action), "the office only sends action ids like [\\w:.-]{{1,64}}, not {action:?}");
        let who = self.actor(name);
        self.run(who, action, input)
    }

    fn run(&mut self, who: Actor, action: &str, input: Option<&str>) -> Response {
        self.now += 1000.0;
        let seed = self.seed;
        self.seed = self.seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        let event = self.event_now.take();
        let nearby: Vec<Person> = self.people.values().map(|a| Person { id: a.id.clone(), name: a.name.clone(), handle: a.handle.clone() }).collect();
        let inventory = if who.is_system() { Vec::new() } else { self.inventory(&who.name).to_vec() };
        // Like the office: rooms only for plugins that may unlock, each
        // marked `yours` when this actor booked it or was let in.
        let rooms: Vec<Room> = if self.granted.iter().any(|g| g == "unlock") {
            self.rooms.iter().cloned().map(|mut r| {
                if let Some(b) = r.booking.as_mut() {
                    b.yours = b.name == who.name || self.unlocked.iter().any(|(id, n)| *id == r.id && *n == who.name);
                }
                r
            }).collect()
        } else { Vec::new() };
        let req = json!({
            "object": self.object, "actor": who, "action": action, "input": input,
            "state": self.state, "nearby": nearby, "now": self.now, "inventory": inventory,
            "event": event, "seed": seed, "permissions": self.granted, "rooms": rooms,
        });
        let out = handle_json::<P>(&serde_json::to_vec(&req).unwrap());
        self.logs.extend(take_logs());
        assert!(out.len() <= limits::ANSWER_BYTES, "the answer is {} bytes; the office takes 64 KB at most", out.len());
        let raw: Value = serde_json::from_slice(&out).expect("the answer is JSON");
        let mut r: Response = serde_json::from_value(raw.clone()).expect("the answer fits Response");

        self.check(&r);

        // take without the permission: dropped, like the office.
        if !r.take.is_empty() && !self.granted.iter().any(|g| g == "take") {
            self.warn("the answer takes things without the take permission and the office drops it: add Permission::Take to MANIFEST (moderators upload those)".into());
            r.take.clear();
        }
        // give and take: all or nothing, like the office.
        if (!r.give.is_empty() || !r.take.is_empty()) && !who.is_system() {
            if let Err(why) = self.trade(&who.name, &r.give, &r.take) {
                r = Response { toast: Some(format!("{}: {why}", self.object.name)), ..Response::default() };
                return r;
            }
        }
        // unlock: only with the permission, only someone using it, only a room booked now.
        if let Some(u) = r.unlock.clone() {
            let why = if !self.granted.iter().any(|g| g == "unlock") {
                self.warn("the answer unlocks a room without the unlock permission: add Permission::Unlock to MANIFEST (admins upload those)".into());
                Some(format!("{} can't open doors: it doesn't have the unlock permission.", self.object.name))
            } else if who.is_system() || event.is_some() {
                Some(format!("{}: only someone using it can be let in", self.object.name))
            } else {
                match self.rooms.iter().find(|x| x.id == u.room) {
                    None => { self.warn(format!("unlock: there's no bookable room {:?}", u.room)); Some(format!("{}: no such room", self.object.name)) }
                    Some(x) if x.booking.is_none() => Some(format!("{}: {} isn't booked right now: just walk in", self.object.name, x.name)),
                    Some(_) => { self.unlocked.push((u.room.clone(), who.name.clone())); None }
                }
            };
            if let Some(t) = why { r.unlock = None; r.toast = Some(t); }
        }
        if let Some(state) = raw.get("state") { self.save_state(state); }
        if let Some(s) = &r.say { self.said.push(s.clone()); }
        if let Some(d) = &r.display { self.display = Some(d.clone()); }
        if let Some(at) = r.wake_at { self.wake_at = Some(at); }
        if let Some(w) = &r.watch {
            if w.len() > limits::WATCH { self.warn(format!("watch lists {} zones; the office follows {} at most", w.len(), limits::WATCH)); }
            self.watching = w.iter().take(limits::WATCH).cloned().collect();
        }
        if who.is_system() { r.ui = None; }
        r
    }

    fn save_state(&mut self, state: &Value) {
        let size = state.to_string().len();
        if size <= limits::STATE_BYTES { self.state = state.clone(); }
        else { self.warn(format!("state is {size} bytes; the office doesn't save state over 32 KB")); }
    }

    fn trade(&mut self, name: &str, give: &[crate::Give], take: &[crate::Take]) -> Result<(), String> {
        let mut inv = self.inventory(name).to_vec();
        for t in take {
            let need = t.qty.clamp(1, limits::STACK);
            if inv.iter().filter(|s| s.kind == t.kind).map(|s| s.qty).sum::<u32>() < need { return Err(format!("you don't have {need} {}", t.kind)); }
            let mut left = need;
            for s in inv.iter_mut().filter(|s| s.kind == t.kind) { let n = left.min(s.qty); s.qty -= n; left -= n; }
            inv.retain(|s| s.qty > 0);
        }
        for g in give {
            let mut left = g.qty.unwrap_or(1).clamp(1, limits::STACK);
            for s in inv.iter_mut().filter(|s| s.kind == g.kind) {
                let n = left.min(limits::STACK - s.qty);
                s.qty += n;
                left -= n;
            }
            while left > 0 {
                if inv.len() >= limits::SLOTS { return Err(format!("your hands are full ({} things at most)", limits::SLOTS)); }
                let n = left.min(limits::STACK);
                self.next_id += 1;
                inv.push(Item {
                    id: format!("i{}", self.next_id), kind: g.kind.clone(),
                    name: g.name.clone().unwrap_or_else(|| g.kind.clone()), emoji: g.emoji.clone().unwrap_or_else(|| "📦".into()),
                    qty: n, verb: g.verb.clone(), consume: g.consume, data: g.data.clone(),
                });
                left -= n;
            }
        }
        self.inventories.insert(name.into(), inv);
        Ok(())
    }

    fn warn(&mut self, w: String) {
        eprintln!("[office] {w}");
        if !self.warnings.contains(&w) { self.warnings.push(w); }
    }

    // What the office would clip, drop or refuse.
    fn check(&mut self, r: &Response) {
        let long = |s: &str, max: usize| s.chars().count() > max;
        let mut w = Vec::new();
        if r.say.as_deref().is_some_and(|s| long(s, limits::SAY)) { w.push(format!("say is over {} characters and gets cut", limits::SAY)); }
        if r.toast.as_deref().is_some_and(|s| long(s, limits::TOAST)) { w.push(format!("toast is over {} characters and gets cut", limits::TOAST)); }
        if let Some(d) = &r.display {
            if d.label.as_deref().is_some_and(|s| long(s, limits::LABEL)) { w.push(format!("display.label is over {} characters and gets cut", limits::LABEL)); }
            if let Some(g) = &d.glow {
                let ok = (4..=9).contains(&g.len()) && g.starts_with('#') && g[1..].chars().all(|c| c.is_ascii_hexdigit());
                if !ok { w.push(format!("display.glow {g:?} isn't a #rrggbb colour and is dropped")); }
            }
            if d.data.as_ref().is_some_and(|v| v.to_string().len() > limits::DATA_BYTES) { w.push(format!("display.data is over {} bytes and is dropped", limits::DATA_BYTES)); }
        }
        assert!(r.take.len() <= limits::GIVE, "take uses up {} kinds of things; the office takes {} at most", r.take.len(), limits::GIVE);
        assert!(r.give.len() <= limits::GIVE, "give hands out {} things; the office takes {} at most", r.give.len(), limits::GIVE);
        for g in &r.give {
            assert!(valid_kind(&g.kind), "give kind {:?} must be [a-z0-9:._-], up to 32 characters", g.kind);
            if let Some(d) = &g.data {
                if d.to_string().len() > 512 { w.push(format!("give {}: data over 512 bytes is dropped", g.kind)); }
            }
        }
        if let Some(ui) = &r.ui {
            for a in ui.actions() {
                assert!(valid_action(a), "panel action {a:?} isn't [\\w:.-]{{1,64}}: the office drops it");
            }
            if long(&ui.title, limits::TITLE) { w.push(format!("ui.title is over {} characters and gets cut", limits::TITLE)); }
            if long(&ui.text, limits::TEXT) { w.push(format!("ui.text is over {} characters and gets cut", limits::TEXT)); }
            if ui.items.len() > limits::ITEMS { w.push(format!("ui.items has {}; the office shows {}", ui.items.len(), limits::ITEMS)); }
            if ui.buttons.len() > limits::BUTTONS { w.push(format!("ui.buttons has {}; the office shows {}", ui.buttons.len(), limits::BUTTONS)); }
            if ui.list.as_ref().is_some_and(|l| l.rows.len() > limits::LIST_ROWS) { w.push(format!("ui.list has more than {} rows; the rest are dropped", limits::LIST_ROWS)); }
            if let Some(api) = self.manifest["api"].as_object() {
                for a in ui.actions() {
                    let listed = api.contains_key(a) || api.keys().any(|k| k.split_once(":<").is_some_and(|(p, _)| a.strip_prefix(p).is_some_and(|rest| rest.starts_with(':'))));
                    if !listed && a != "use" { w.push(format!("panel action {a:?} isn't in the manifest: add Action::new(\"{a}\", \"…\") to MANIFEST so agents know it")); }
                }
            }
        }
        for x in w { self.warn(x); }
    }

    /// The state as the office has it saved now.
    /// Kept as JSON, like the office, and typed fresh each time.
    pub fn state(&self) -> P {
        if self.state.is_null() { P::default() } else { serde_json::from_value(self.state.clone()).expect("saved state fits the plugin") }
    }

    /// The raw saved state, as JSON.
    pub fn state_json(&self) -> &Value { &self.state }
    /// What `name` carries.
    pub fn inventory(&self, name: &str) -> &[Item] { self.inventories.get(name).map(Vec::as_slice).unwrap_or(&[]) }
    /// Everything the object said out loud, oldest first.
    pub fn said(&self) -> &[String] { &self.said }
    /// What everyone sees on the object now.
    pub fn display(&self) -> Option<&Display> { self.display.as_ref() }
    /// When the plugin asked to be woken.
    pub fn wake_at(&self) -> Option<f64> { self.wake_at }
    /// The zones the plugin watches now.
    pub fn watching(&self) -> &[String] { &self.watching }
    /// Lines the plugin logged with [`crate::log`].
    pub fn logs(&self) -> &[String] { &self.logs }
    /// Things the office would clip or drop. Empty in a well-behaved plugin.
    pub fn warnings(&self) -> &[String] { &self.warnings }
    /// Panics if there are any [`warnings`](Self::warnings).
    pub fn assert_clean(&self) {
        assert!(self.warnings.is_empty(), "the office would complain:\n  {}", self.warnings.join("\n  "));
    }
}
