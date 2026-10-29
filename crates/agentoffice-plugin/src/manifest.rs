//! What a plugin says about itself: its name, how it looks, and the actions
//! its panels send. Built in a `const`, checked at compile time, and written
//! by [`export_plugin!`](crate::export_plugin) into the module's
//! `agentoffice.manifest` custom section as JSON. The office reads it on
//! upload (public/js/manifest.js): it fills in the upload form, and the
//! actions show up in `gallery_view` for agents.

/// How the object is drawn. Every look is a real object, the same art the
/// office's own objects use (an uploaded arcade cabinet is drawn like the
/// Lounge's), or your own pixel [`Sprite`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    /// A screen on a stand showing your emoji (the default).
    Kiosk,
    /// An arcade cabinet, in your glow colour.
    Arcade,
    Jukebox,
    Vending,
    /// A crystal ball.
    EightBall,
    /// A coffee machine.
    Coffee,
    /// A chequered flag on a pole.
    Flag,
    /// A whiteboard on a stand: the office's drawing editor opens on it and
    /// draws your feed's strokes (`append` `{ points, color, size }`, needs
    /// `Permission::Feed`), like the boardroom's.
    Whiteboard,
    /// A cork board: shows the `notes` in your `display.data`
    /// (`[{ id, text, color, by, ts, owner }]`) and opens the notice board panel.
    NoticeBoard,
    /// A tomato clock: draws the pomodoro state in your `display.data`
    /// (`{ phase, endsAt, round, focusMin, breakMin }`).
    Pomodoro,
    /// A desk bell.
    Bell,
    /// A room's door panel: lit with the booking state of the room it stands in.
    DoorPanel,
    /// Your own pixel art: set by [`Manifest::sprite`].
    Sprite,
    /// Not put on the map when uploaded: it starts as one item, named and
    /// drawn after the manifest, in the uploader's inventory. With the
    /// `unlock` permission that item is a skeleton key.
    Item,
}

impl Look {
    pub const fn as_str(self) -> &'static str {
        match self {
            Look::Kiosk => "kiosk",
            Look::Arcade => "arcade",
            Look::Jukebox => "jukebox",
            Look::Vending => "vending",
            Look::EightBall => "eightball",
            Look::Coffee => "coffee",
            Look::Flag => "rally",
            Look::Whiteboard => "whiteboard",
            Look::NoticeBoard => "board",
            Look::Pomodoro => "pomodoro",
            Look::Bell => "reception",
            Look::DoorPanel => "panel",
            Look::Sprite => "sprite",
            Look::Item => "item",
        }
    }
}

/// Pixel art for your object: up to 16 columns by 24 rows, one character
/// per pixel. `.` (or a space) is see-through; every other character is a
/// colour from the palette. It's drawn one tile wide, standing on its tile,
/// so 16 rows make an object about as tall as a jukebox.
///
/// ```
/// use agentoffice_plugin::Sprite;
/// const BOOK: Sprite = Sprite::new(&[
///     "..bbbb..",
///     "..bwwb..",
///     "..bbbb..",
/// ]).colors(&[('b', "#7c2d12"), ('w', "#fef3c7")]);
/// ```
#[derive(Clone, Copy, Debug)]
pub struct Sprite {
    pub rows: &'static [&'static str],
    /// (character, `#rrggbb`), up to 16 colours.
    pub palette: &'static [(char, &'static str)],
}

impl Sprite {
    pub const MAX_W: usize = 16;
    pub const MAX_H: usize = 24;
    pub const fn new(rows: &'static [&'static str]) -> Self { Sprite { rows, palette: &[] } }
    pub const fn colors(mut self, palette: &'static [(char, &'static str)]) -> Self { self.palette = palette; self }
}

/// Something a plugin may ask the office to do beyond the basics (panels,
/// speech, display, music, give, timers, watching zones). Each belongs to a
/// level, and the level decides who may upload the plugin:
///
/// | permission | level | uploaded by |
/// |---|---|---|
/// | [`Take`](Permission::Take) | trusted | moderators and up |
/// | [`Feed`](Permission::Feed) | trusted | moderators and up |
/// | [`Notify`](Permission::Notify) | trusted | moderators and up |
/// | [`Unlock`](Permission::Unlock) | privileged | admins and owners |
///
/// Without the permission the office ignores that part of your answer: a
/// take or a note is dropped, an unlock refused, a feed left as it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    /// Use up things the person carries ([`Response::take`](crate::Response::take)).
    Take,
    /// Keep a feed: a long list every browser gets, beyond the 32 KB of state
    /// ([`Response::append`](crate::Response::append), [`Response::clear_feed`](crate::Response::clear_feed)).
    /// It's the office's storage and bandwidth, so it's trusted.
    Feed,
    /// Send notes to particular people anywhere in the office, kept for
    /// signed-in people who are away ([`Response::notify`](crate::Response::notify)).
    Notify,
    /// Let whoever uses it into a meeting room someone else booked
    /// ([`Response::unlock`](crate::Response::unlock)); the request then
    /// carries [`Request::rooms`](crate::Request::rooms).
    Unlock,
}

impl Permission {
    pub const fn as_str(self) -> &'static str {
        match self {
            Permission::Take => "take",
            Permission::Feed => "feed",
            Permission::Notify => "notify",
            Permission::Unlock => "unlock",
        }
    }
    /// `basic` never appears: it's what a plugin with no permissions is.
    pub const fn level(self) -> &'static str {
        match self {
            Permission::Take | Permission::Feed | Permission::Notify => "trusted",
            Permission::Unlock => "privileged",
        }
    }
}

/// An action your panels send, for agents and the docs.
#[derive(Clone, Copy, Debug)]
pub struct Action {
    /// `[\w:.-]`, up to 64; `play:<track>` describes a family of ids.
    pub id: &'static str,
    pub doc: &'static str,
    /// What to type, when the action comes from an input box.
    pub input: Option<&'static str>,
}

impl Action {
    pub const fn new(id: &'static str, doc: &'static str) -> Self { Action { id, doc, input: None } }
    /// The action takes typed text: say what to type.
    pub const fn input(mut self, what: &'static str) -> Self { self.input = Some(what); self }
}

/// ```
/// use agentoffice_plugin::{Action, Look, Manifest};
/// const M: Manifest = Manifest::new("Guestbook")
///     .doc("Leave a note for the office.")
///     .prompt("Sign the guestbook")
///     .emoji("📖")
///     .glow("#f59e0b")
///     .look(Look::Kiosk)
///     .actions(&[Action::new("sign", "Sign it with a note").input("Your note")]);
/// assert!(M.to_json().contains("\"sign\""));
/// ```
#[derive(Clone, Copy, Debug)]
pub struct Manifest {
    /// ≤ 40 characters.
    pub name: &'static str,
    /// What the E prompt says, ≤ 60.
    pub prompt: &'static str,
    /// What it does, ≤ 280.
    pub doc: &'static str,
    pub emoji: &'static str,
    /// `#rrggbb`
    pub glow: &'static str,
    pub look: Look,
    /// Your own art, when the look is [`Look::Sprite`].
    pub sprite: Option<Sprite>,
    pub actions: &'static [Action],
    /// What it needs beyond the basics; see [`Permission`].
    pub permissions: &'static [Permission],
}

impl Manifest {
    pub const fn new(name: &'static str) -> Self {
        Manifest { name, prompt: "", doc: "", emoji: "", glow: "", look: Look::Kiosk, sprite: None, actions: &[], permissions: &[] }
    }
    pub const fn prompt(mut self, s: &'static str) -> Self { self.prompt = s; self }
    pub const fn doc(mut self, s: &'static str) -> Self { self.doc = s; self }
    pub const fn emoji(mut self, s: &'static str) -> Self { self.emoji = s; self }
    pub const fn glow(mut self, s: &'static str) -> Self { self.glow = s; self }
    pub const fn look(mut self, l: Look) -> Self { self.look = l; self }
    /// Draw it with your own pixel art (the look becomes [`Look::Sprite`]).
    pub const fn sprite(mut self, s: Sprite) -> Self { self.sprite = Some(s); self.look = Look::Sprite; self }
    pub const fn actions(mut self, a: &'static [Action]) -> Self { self.actions = a; self }
    /// What it needs beyond the basics (who may upload it follows from these).
    pub const fn permissions(mut self, p: &'static [Permission]) -> Self { self.permissions = p; self }
    /// Whether it declares `p`.
    pub const fn has(&self, p: Permission) -> bool {
        let mut i = 0;
        while i < self.permissions.len() { if self.permissions[i] as u8 == p as u8 { return true; } i += 1; }
        false
    }
    /// `basic`, `trusted` or `privileged`: the highest level of its permissions.
    pub const fn level(&self) -> &'static str {
        if self.has(Permission::Unlock) { "privileged" } else if self.permissions.is_empty() { "basic" } else { "trusted" }
    }

    /// The manifest as JSON, the way it's embedded.
    pub fn to_json(&self) -> String {
        let w = encode::<MAX_BYTES>(self);
        String::from_utf8(w.buf[..w.len].to_vec()).expect("the manifest is UTF-8")
    }
}

/// The office reads manifests up to 8 KB.
pub const MAX_BYTES: usize = 8 * 1024;

// ---- const JSON ---------------------------------------------------------------
// A custom section has to be a fixed byte array in a static, so the JSON is
// written in a const fn: once with N = 0 to count, once with the length.

#[doc(hidden)]
pub struct Writer<const N: usize> {
    pub buf: [u8; N],
    pub len: usize,
}

impl<const N: usize> Writer<N> {
    const fn byte(mut self, b: u8) -> Self {
        if self.len < N { self.buf[self.len] = b; }
        self.len += 1;
        self
    }
    const fn raw(mut self, s: &str) -> Self {
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() { self = self.byte(b[i]); i += 1; }
        self
    }
    const fn string(mut self, s: &str) -> Self {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        self = self.byte(b'"');
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            let c = b[i];
            if c == b'"' || c == b'\\' { self = self.byte(b'\\').byte(c); }
            else if c < 0x20 { self = self.raw("\\u00").byte(HEX[(c >> 4) as usize]).byte(HEX[(c & 15) as usize]); }
            else { self = self.byte(c); }
            i += 1;
        }
        self.byte(b'"')
    }
    const fn field(self, key: &str, value: &str) -> Self {
        if value.is_empty() { return self; }
        self.string(key).byte(b':').string(value).byte(b',')
    }
}

const fn chars(s: &str) -> usize {
    let b = s.as_bytes();
    let (mut n, mut i) = (0, 0);
    while i < b.len() { if b[i] & 0xc0 != 0x80 { n += 1; } i += 1; }
    n
}

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() { return false; }
    let mut i = 0;
    while i < a.len() { if a[i] != b[i] { return false; } i += 1; }
    true
}

const fn hex_colour(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 4 || b.len() > 9 || b[0] != b'#' { return false; }
    let mut i = 1;
    while i < b.len() { if !b[i].is_ascii_hexdigit() { return false; } i += 1; }
    true
}

const fn action_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 64 { return false; }
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if !(c.is_ascii_alphanumeric() || c == b'_' || c == b':' || c == b'.' || c == b'-' || c == b'<' || c == b'>') { return false; }
        i += 1;
    }
    true
}

const fn in_palette(p: &[(char, &str)], c: u8) -> bool {
    let mut i = 0;
    while i < p.len() { if p[i].0 as u32 == c as u32 { return true; } i += 1; }
    false
}

// "sprite":{"rows":[…],"palette":{"b":"#7c2d12",…}},
const fn sprite<const N: usize>(mut w: Writer<N>, sp: &Sprite) -> Writer<N> {
    assert!(!sp.rows.is_empty() && sp.rows.len() <= Sprite::MAX_H, "manifest: a sprite has 1 to 24 rows");
    assert!(!sp.palette.is_empty() && sp.palette.len() <= 16, "manifest: a sprite's palette has 1 to 16 colours");
    let mut i = 0;
    while i < sp.palette.len() {
        let (c, colour) = sp.palette[i];
        assert!(c.is_ascii_graphic() && c != '.' && c != '"' && c != '\\', "manifest: palette characters are ASCII letters, digits or symbols (not . \" or \\)");
        assert!(hex_colour(colour), "manifest: palette colours are like \"#7c2d12\"");
        let mut j = 0;
        while j < i { assert!(sp.palette[j].0 as u32 != c as u32, "manifest: a palette character is listed twice"); j += 1; }
        i += 1;
    }
    w = w.raw("\"sprite\":{\"rows\":[");
    i = 0;
    while i < sp.rows.len() {
        let b = sp.rows[i].as_bytes();
        assert!(b.len() <= Sprite::MAX_W, "manifest: a sprite row is over 16 pixels");
        let mut j = 0;
        while j < b.len() { assert!(b[j] == b'.' || b[j] == b' ' || in_palette(sp.palette, b[j]), "manifest: a sprite pixel isn't . or a palette character"); j += 1; }
        if i > 0 { w = w.byte(b','); }
        w = w.string(sp.rows[i]);
        i += 1;
    }
    w = w.raw("],\"palette\":{");
    i = 0;
    while i < sp.palette.len() {
        if i > 0 { w = w.byte(b','); }
        let c = [sp.palette[i].0 as u8];
        w = w.byte(b'"').byte(c[0]).byte(b'"').byte(b':').string(sp.palette[i].1);
        i += 1;
    }
    w.raw("}},")
}

/// Checks the manifest (a compile error when it's in a const) and writes it
/// as JSON. Used by [`export_plugin!`](crate::export_plugin).
#[doc(hidden)]
pub const fn encode<const N: usize>(m: &Manifest) -> Writer<N> {
    assert!(chars(m.name) >= 1 && chars(m.name) <= 40, "manifest: the name must be 1 to 40 characters");
    assert!(chars(m.prompt) <= 60, "manifest: the prompt is over 60 characters");
    assert!(chars(m.doc) <= 280, "manifest: the doc is over 280 characters");
    assert!(chars(m.emoji) <= 2, "manifest: emoji is one or two emoji");
    assert!(m.glow.is_empty() || hex_colour(m.glow), "manifest: glow is a colour like \"#f59e0b\"");
    assert!(m.actions.len() <= 24, "manifest: 24 actions at most");
    let mut w = Writer { buf: [0; N], len: 0 };
    w = w.byte(b'{').raw("\"manifest\":1,");
    w = w.field("name", m.name).field("prompt", m.prompt).field("doc", m.doc).field("emoji", m.emoji).field("glow", m.glow);
    w = w.field("look", m.look.as_str());
    assert!(!matches!(m.look, Look::Sprite) || m.sprite.is_some(), "manifest: Look::Sprite needs a sprite: use .sprite(Sprite::new(..))");
    if let Some(sp) = m.sprite { w = sprite(w, &sp); }
    if !m.permissions.is_empty() {
        w = w.raw("\"permissions\":[");
        let mut i = 0;
        while i < m.permissions.len() {
            let mut j = 0;
            while j < i { assert!(m.permissions[j] as u8 != m.permissions[i] as u8, "manifest: a permission is listed twice"); j += 1; }
            if i > 0 { w = w.byte(b','); }
            w = w.string(m.permissions[i].as_str());
            i += 1;
        }
        w = w.raw("],");
    }
    w = w.raw("\"api\":{");
    let mut i = 0;
    while i < m.actions.len() {
        let a = &m.actions[i];
        assert!(action_id(a.id), "manifest: action ids are letters, digits and _ : . - (up to 64)");
        assert!(chars(a.doc) <= 200, "manifest: an action's doc is over 200 characters");
        let mut j = 0;
        while j < i { assert!(!same(m.actions[j].id, a.id), "manifest: an action is listed twice"); j += 1; }
        if i > 0 { w = w.byte(b','); }
        w = w.string(a.id).raw(":{\"doc\":").string(a.doc);
        if let Some(what) = a.input {
            assert!(chars(what) <= 200, "manifest: an action's input description is over 200 characters");
            w = w.raw(",\"params\":{\"input\":{\"type\":\"string\",\"maxLength\":500,\"description\":").string(what).raw("}}");
        }
        w = w.byte(b'}');
        i += 1;
    }
    w = w.raw("}}");
    assert!(w.len <= MAX_BYTES, "manifest: over 8 KB, shorten the docs");
    w
}
