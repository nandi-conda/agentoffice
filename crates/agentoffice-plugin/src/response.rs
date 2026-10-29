//! What you answer with: new state, a speech bubble, a panel, things to hand
//! out. Every field is optional; build one with the methods on [`Response`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Your answer to one call.
///
/// ```
/// use agentoffice_plugin::prelude::*;
/// let r = Response::new()
///     .say("🎲 Ada rolled a 3")
///     .ui(Ui::new("🎲 Dice").text("Rolled **3** times.").primary("Roll", "roll"));
/// ```
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    /// Your plugin as it is after the call; filled in for you when it changed.
    #[doc(hidden)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    /// A speech bubble over the object and a chat line for everyone nearby (≤ 280 chars).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub say: Option<String>,
    /// A notification just for the person who used it (≤ 200 chars).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toast: Option<String>,
    /// What everyone sees on the object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<Display>,
    /// The panel the person sees. `None` changes nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui: Option<Ui>,
    /// Things for the person (≤ 5). All or nothing: if they have no room,
    /// nothing in this answer happens and they get a toast.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub give: Vec<Give>,
    /// Epoch ms: the office calls you again then with action `tick`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_at: Option<f64>,
    /// Zones to hear about (≤ 12): the office calls [`Plugin::on_enter`] /
    /// [`Plugin::on_exit`] as people walk in and out. `Some(vec![])` stops;
    /// `None` keeps whatever you watch now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watch: Option<Vec<String>>,
    /// Things of the person's to use up (≤ 5), all or nothing together with
    /// `give`. Needs [`Permission::Take`](crate::Permission::Take).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub take: Vec<Take>,
    /// Let the person who used it into this meeting room while it's booked
    /// by someone else, as if the meeting had let them in. Needs
    /// [`Permission::Unlock`](crate::Permission::Unlock) (admins upload those).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unlock: Option<Unlock>,
    /// Entries to add to the object's feed (≤ 20 per answer, ≤ 8 KB each):
    /// a long list the office keeps (the last 3000) and every browser gets,
    /// for objects the office draws itself, like the whiteboard's strokes.
    /// Your state stays small; the feed isn't sent back to you. Needs
    /// [`Permission::Feed`](crate::Permission::Feed).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub append: Vec<Value>,
    /// Empty the feed (before anything in `append` goes on). Needs
    /// [`Permission::Feed`](crate::Permission::Feed).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub clear_feed: bool,
}

impl Response {
    pub fn new() -> Self { Self::default() }
    /// Just a toast, for when something went wrong.
    pub fn error(msg: impl Into<String>) -> Self { Self::new().toast(msg) }
    pub fn say(mut self, text: impl Into<String>) -> Self { self.say = Some(text.into()); self }
    /// Say it only if there's something to say.
    pub fn say_opt(mut self, text: Option<impl Into<String>>) -> Self { self.say = text.map(Into::into); self }
    pub fn toast(mut self, text: impl Into<String>) -> Self { self.toast = Some(text.into()); self }
    pub fn display(mut self, display: Display) -> Self { self.display = Some(display); self }
    pub fn ui(mut self, ui: Ui) -> Self { self.ui = Some(ui); self }
    pub fn give(mut self, item: Give) -> Self { self.give.push(item); self }
    pub fn wake_at(mut self, at: f64) -> Self { self.wake_at = Some(at); self }
    /// Watch these zones (and only these) from now on.
    pub fn watch<Z: Into<String>>(mut self, zones: impl IntoIterator<Item = Z>) -> Self {
        self.watch = Some(zones.into_iter().map(Into::into).collect());
        self
    }
    /// Stop watching zones.
    pub fn unwatch(mut self) -> Self { self.watch = Some(Vec::new()); self }
    /// Use up `qty` of `kind` the person carries (see the field).
    pub fn take(mut self, kind: impl Into<String>, qty: u32) -> Self { self.take.push(Take { kind: kind.into(), qty }); self }
    /// Let them into room `room` (an id from [`Request::rooms`](crate::Request::rooms)).
    pub fn unlock(mut self, room: impl Into<String>) -> Self { self.unlock = Some(Unlock { room: room.into() }); self }
    /// Add an entry to the feed (see the field).
    pub fn append(mut self, entry: impl Serialize) -> Self {
        if let Ok(v) = serde_json::to_value(entry) { self.append.push(v); }
        self
    }
    /// Empty the feed.
    pub fn clear_feed(mut self) -> Self { self.clear_feed = true; self }
}

/// Things to use up: `qty` (1–20) of `kind`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Take {
    pub kind: String,
    pub qty: u32,
}

/// A meeting room to let the person into.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Unlock {
    pub room: String,
}

/// What everyone sees on the object: a floating label and an accent colour.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Display {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `#rrggbb`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glow: Option<String>,
    /// Epoch ms when the label goes away.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<f64>,
    /// A tune from public/js/music.js, started at `at`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub music: Option<Music>,
    /// Any JSON (≤ 16 KB) every browser gets with the display, for objects
    /// the office draws itself: the notice board's notes, the pomodoro's
    /// phase, the coffee machine's cup count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl Display {
    pub fn label(text: impl Into<String>) -> Self { Display { label: Some(text.into()), ..Default::default() } }
    pub fn glow(mut self, colour: impl Into<String>) -> Self { self.glow = Some(colour.into()); self }
    pub fn until(mut self, at: f64) -> Self { self.until = Some(at); self }
    pub fn music(mut self, id: impl Into<String>, at: f64) -> Self { self.music = Some(Music { id: id.into(), at }); self }
    pub fn data(mut self, data: impl Serialize) -> Self { self.data = serde_json::to_value(data).ok(); self }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Music {
    pub id: String,
    pub at: f64,
}

/// The panel: data, never HTML. `text` takes `**bold**` and line breaks.
///
/// ```
/// use agentoffice_plugin::prelude::*;
/// let ui = Ui::new("🥤 Vending")
///     .text("Pick a snack.")
///     .item(Row::new("🍪 Giant Cookie", "buy:cookie").detail("3 left"))
///     .list("Sold today", ["Ada: cookie"])
///     .input(Input::new("note").placeholder("Leave a note…").button("Send"))
///     .button("Close", "close");
/// ```
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Ui {
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// Tappable rows (≤ 24).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Row>,
    /// A read-only numbered list (≤ 20 rows).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<List>,
    /// A text box; sends its action with what was typed as `input`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Input>,
    /// Up to 6.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub buttons: Vec<Button>,
}

impl Ui {
    pub fn new(title: impl Into<String>) -> Self { Ui { title: title.into(), ..Default::default() } }
    pub fn text(mut self, text: impl Into<String>) -> Self { self.text = text.into(); self }
    /// A tappable row.
    pub fn item(mut self, row: Row) -> Self { self.items.push(row); self }
    pub fn items(mut self, rows: impl IntoIterator<Item = Row>) -> Self { self.items.extend(rows); self }
    pub fn list<R: Into<String>>(mut self, title: impl Into<String>, rows: impl IntoIterator<Item = R>) -> Self {
        self.list = Some(List { title: title.into(), rows: rows.into_iter().map(Into::into).collect() });
        self
    }
    pub fn input(mut self, input: Input) -> Self { self.input = Some(input); self }
    pub fn button(mut self, label: impl Into<String>, action: impl Into<String>) -> Self {
        self.buttons.push(Button { label: label.into(), action: action.into(), primary: false });
        self
    }
    /// The highlighted button.
    pub fn primary(mut self, label: impl Into<String>, action: impl Into<String>) -> Self {
        self.buttons.push(Button { label: label.into(), action: action.into(), primary: true });
        self
    }
    /// Every action id this panel can send back.
    pub fn actions(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self.items.iter().map(|r| r.action.as_str()).collect();
        out.extend(self.buttons.iter().map(|b| b.action.as_str()));
        out.extend(self.input.iter().map(|i| i.action.as_str()));
        out
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Row {
    pub label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    pub action: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
}

impl Row {
    pub fn new(label: impl Into<String>, action: impl Into<String>) -> Self {
        Row { label: label.into(), action: action.into(), ..Default::default() }
    }
    pub fn detail(mut self, detail: impl Into<String>) -> Self { self.detail = detail.into(); self }
    pub fn disabled(mut self, disabled: bool) -> Self { self.disabled = disabled; self }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct List {
    pub title: String,
    pub rows: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Input {
    pub action: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub placeholder: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub button: String,
    /// 1–500 (the office's default is 200).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
}

impl Input {
    pub fn new(action: impl Into<String>) -> Self { Input { action: action.into(), ..Default::default() } }
    pub fn placeholder(mut self, text: impl Into<String>) -> Self { self.placeholder = text.into(); self }
    pub fn button(mut self, label: impl Into<String>) -> Self { self.button = label.into(); self }
    pub fn max_length(mut self, n: u32) -> Self { self.max_length = Some(n); self }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Button {
    pub label: String,
    pub action: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub primary: bool,
}

/// Something to put in the person's inventory.
///
/// ```
/// use agentoffice_plugin::prelude::*;
/// // A kind the office knows fills in the rest:
/// let cookie = Give::new("cookie");
/// // Your own: prefix the kind with your plugin's name.
/// let stamp = Give::new("guestbook:stamp").name("Guestbook stamp").emoji("📮").verb("shows off");
/// ```
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Give {
    /// `[a-z0-9:._-]`, up to 32 characters.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<u32>,
    /// What using it looks like: "eats", "reads".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verb: Option<String>,
    /// Using it uses one up.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub consume: bool,
    /// The emote shown while they use it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emote: Option<String>,
    /// Up to 512 bytes of JSON you get back in `inventory`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl Give {
    pub fn new(kind: impl Into<String>) -> Self { Give { kind: kind.into(), ..Default::default() } }
    pub fn name(mut self, name: impl Into<String>) -> Self { self.name = Some(name.into()); self }
    pub fn emoji(mut self, emoji: impl Into<String>) -> Self { self.emoji = Some(emoji.into()); self }
    pub fn qty(mut self, qty: u32) -> Self { self.qty = Some(qty); self }
    pub fn verb(mut self, verb: impl Into<String>) -> Self { self.verb = Some(verb.into()); self }
    pub fn consume(mut self) -> Self { self.consume = true; self }
    pub fn emote(mut self, emote: impl Into<String>) -> Self { self.emote = Some(emote.into()); self }
    pub fn data(mut self, data: impl Serialize) -> Self { self.data = serde_json::to_value(data).ok(); self }
}
