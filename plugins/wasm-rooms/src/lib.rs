//! The meeting room door panels, as a WASM plugin built with the
//! agentoffice-plugin crate. Each bookable room's panel (`panel-<room>` on
//! the map, zone = the room) keeps that room's bookings and every rule about
//! them: 15 minutes to 4 hours, up to 14 days ahead, no overlaps, 12 upcoming
//! per person; reminders before the start and the end, start and end
//! announcements, letting people in who knock, and releasing rooms nobody
//! turned up to. The schedule goes out with the display (`display.data`), so
//! every browser draws the panels and the booking form from it.
//!
//! The office keeps the door itself: it reads the schedule and keeps
//! everyone but a meeting's holders out while it runs (server/office.js),
//! and the Skeleton Key's `unlock` comes here as an office event. Booking
//! changes come the same way (`book`, from the booking form, book_room and
//! manage_booking), since only the office knows how many bookings someone
//! has in the other rooms. A panel opened any other way just shows the
//! schedule.
//!
//! Build with `just plugin-build rooms`, test with `just plugin-test rooms`.

use agentoffice_plugin::prelude::*;

const MIN: f64 = 60_000.0;
/// Starts and ends snap to 5 minutes.
const STEP: f64 = 5.0 * MIN;
const MIN_LEN: f64 = 15.0 * MIN;
const MAX_LEN: f64 = 240.0 * MIN;
/// How far out you can book.
const AHEAD: f64 = 14.0 * 24.0 * 60.0 * MIN;
/// Upcoming bookings per person, across every room.
const PER_OWNER: usize = 12;
/// Upcoming bookings per room, so the schedule fits in the display.
const PER_ROOM: usize = 30;
/// Released if nobody turns up by then.
const GRACE: f64 = 10.0 * MIN;
/// The next booking counts as "next up" this close to the end.
const SOON: f64 = 15.0 * MIN;
/// Heads-up before the start and before the end.
const REMIND: f64 = 5.0 * MIN;
const DAY: f64 = 24.0 * 60.0 * MIN;
/// Finished bookings kept for the schedule ("earlier today").
const HISTORY: usize = 10;

/// One room's bookings. Field names as the room entity kept them, so its
/// state loads as is.
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
pub struct Rooms {
    pub bookings: Vec<Meeting>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub room: String,
    pub title: String,
    /// Epoch ms.
    pub start: f64,
    pub end: f64,
    /// The booker's key: their DID, or `agent:<name>`.
    pub owner: String,
    pub name: String,
    pub handle: Option<String>,
    /// Handles, DIDs or agent names.
    pub invitees: Vec<String>,
    /// Ignored: every booking keeps everyone but its holders out.
    pub lock: bool,
    pub auto_release: bool,
    /// A holder turned up.
    pub seen: bool,
    /// Keys let in at the door on the day.
    pub admitted: Vec<String>,
    pub sent: Sent,
    pub created: f64,
}

/// The notes already sent for a booking.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Sent {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub soon: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub start: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ending: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ended: bool,
}

/// Someone, as far as holding a booking goes.
struct Who<'a> {
    key: String,
    did: Option<&'a str>,
    handle: Option<&'a str>,
    kind: &'a str,
    name: &'a str,
}

impl<'a> Who<'a> {
    fn actor(a: &'a Actor) -> Self { Who { key: a.key(), did: a.did.as_deref(), handle: a.handle.as_deref(), kind: &a.kind, name: &a.name } }
    fn person(p: &'a Person) -> Self { Who { key: p.key(), did: p.did.as_deref(), handle: p.handle.as_deref(), kind: &p.kind, name: &p.name } }
}

/// Handles and names the way invitees are kept: no @, lowercase, no spaces.
fn norm(s: &str) -> String {
    s.trim().trim_start_matches('@').to_lowercase().split_whitespace().collect()
}

fn clip(s: &str, n: usize) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(n).collect()
}

fn snap(t: f64) -> f64 { (t / STEP).round() * STEP }

fn stamp_range(b: &Meeting) -> String { format!("{}–{}", stamp(b.start), stamp(b.end)) }

/// Up to 20 invitees, from a list or "a, b c".
fn parse_invitees(v: &Value) -> Vec<String> {
    let raw: Vec<String> = match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        Value::String(s) => s.split(|c: char| c.is_whitespace() || c == ',' || c == ';').map(String::from).collect(),
        _ => Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    for s in raw.iter().map(|s| norm(s)) {
        if !s.is_empty() && s.chars().count() <= 253 && !out.contains(&s) { out.push(s); }
    }
    out.truncate(20);
    out
}

impl Meeting {
    fn running(&self, now: f64) -> bool { self.start <= now && now < self.end }

    /// Invitees match a signed-in handle or DID. A plain name only matches
    /// an agent, since guests can call themselves anything.
    fn holds(&self, p: &Who) -> bool {
        if self.owner == p.key || self.admitted.contains(&p.key) { return true; }
        if p.did.is_some_and(|d| self.invitees.contains(&d.to_lowercase())) { return true; }
        if p.handle.is_some_and(|h| self.invitees.contains(&h.to_lowercase())) { return true; }
        p.kind == "agent" && self.invitees.contains(&norm(p.name))
    }

    /// Everyone in the meeting, as a note's `to`, leaving out `but`.
    fn holders(&self, but: Option<&Who>) -> Vec<String> {
        let mut out = vec![self.owner.clone()];
        out.extend(self.admitted.iter().cloned());
        out.extend(self.invitees.iter().cloned());
        if let Some(w) = but {
            let me = [Some(w.key.clone()), w.did.map(str::to_lowercase), w.handle.map(str::to_lowercase), (w.kind == "agent").then(|| norm(w.name))];
            out.retain(|x| !me.iter().flatten().any(|m| m == x));
        }
        out.dedup();
        out
    }

    fn note(&self, n: Note, kind: &str) -> Note { n.kind(kind).re(&self.id) }
}

/// A time from the office: a number (epoch ms), or anything else, which
/// isn't a time.
fn time(v: &Value) -> Option<f64> { v.as_f64().filter(|t| t.is_finite()) }

impl Rooms {
    fn room(req: &Request) -> String { req.object.zone.clone().unwrap_or_default() }

    /// Check a booking request: Err(why) or the snapped (start, end).
    /// `owned`: the owner's upcoming bookings in the other rooms.
    fn check_slot(&self, name: &str, start: f64, end: f64, owner: &str, id: Option<&str>, now: f64, owned: usize) -> Result<(f64, f64), String> {
        // A start that's already here rounds down, so "book it now" starts
        // now rather than at the next 5 minutes.
        let mut start = if start <= now { (start / STEP).floor() * STEP } else { snap(start) };
        let end = snap(end);
        if !start.is_finite() || !end.is_finite() { return Err("start and end must be times".into()); }
        if end - start < MIN_LEN { return Err("bookings are at least 15 minutes".into()); }
        if end - start > MAX_LEN { return Err("bookings are at most 4 hours".into()); }
        if end <= now { return Err("that time has already passed".into()); }
        if start < now - STEP && id.is_none() { start = snap(now); } // "book it now" for a slot that just began
        if start - now > AHEAD { return Err("you can book up to 14 days ahead".into()); }
        if let Some(c) = self.bookings.iter().find(|b| Some(b.id.as_str()) != id && b.start < end && start < b.end) {
            return Err(format!("{name} is booked {} ({})", stamp_range(c), c.title));
        }
        if id.is_none() {
            if owned + self.bookings.iter().filter(|b| b.owner == owner && b.end > now).count() >= PER_OWNER {
                return Err(format!("you already have {PER_OWNER} upcoming bookings"));
            }
            if self.bookings.iter().filter(|b| b.end > now).count() >= PER_ROOM {
                return Err(format!("{name} has {PER_ROOM} bookings coming up already"));
            }
        }
        Ok((start, end))
    }

    /// When the next reminder, announcement or release is due.
    fn next_event(&self, now: f64) -> Option<f64> {
        let mut t = f64::INFINITY;
        for b in &self.bookings {
            let s = &b.sent;
            for (due, when) in [(!s.soon, b.start - REMIND), (!s.start, b.start), (b.auto_release && !b.seen, b.start + GRACE), (!s.ending, b.end - REMIND), (!s.ended, b.end), (true, b.end + DAY)] {
                if due && when > now && when < t { t = when; }
            }
            // Look for a holder in the room every 30 s until one turns up.
            if b.running(now) && !b.seen { t = t.min(now + 30_000.0); }
        }
        t.is_finite().then_some(t)
    }

    /// Reminders, start and end announcements, and releasing rooms nobody
    /// turned up to. Safe to run as often as you like.
    fn tick(&mut self, req: &Request, notes: &mut Vec<Note>) {
        let (now, room, name) = (req.now, Self::room(req), req.object.name.clone());
        let here: Vec<Who> = req.nearby.iter().map(Who::person).collect();
        let mut keep = Vec::new();
        let all = std::mem::take(&mut self.bookings);
        for (i, mut b) in all.clone().into_iter().enumerate() {
            if b.end <= now {
                if !b.sent.ended {
                    b.sent.ended = true;
                    notes.push(b.note(Note::inside(&room, format!("📅 “{}” has ended. {name} is free unless it's booked next.", b.title)), "ended"));
                }
                keep.push(b);
                continue;
            }
            if !b.sent.soon && b.start > now && b.start - now <= REMIND {
                b.sent.soon = true;
                notes.push(b.note(Note::to(b.holders(None), format!("📅 “{}” in {name} starts at {}", b.title, stamp(b.start))).outside(&room), "soon"));
            }
            if b.start > now { keep.push(b); continue; }
            if !b.seen && here.iter().any(|p| b.holds(p)) { b.seen = true; }
            if !b.sent.start {
                b.sent.start = true;
                notes.push(b.note(Note::to(b.holders(None), format!("📅 “{}” in {name} is starting now", b.title)).outside(&room), "start"));
            }
            if b.auto_release && !b.seen && now - b.start >= GRACE {
                notes.push(b.note(Note::to([b.owner.clone()], format!("📅 Nobody turned up to “{}”, so {name} was released", b.title)).keep(), "released"));
                continue;
            }
            if !b.sent.ending && b.end - now <= REMIND {
                b.sent.ending = true;
                let next = all[i + 1..].iter().find(|x| x.start >= b.end && x.start - b.end < SOON);
                let next = next.map(|x| format!(". Next up: “{}” ({})", x.title, x.name)).unwrap_or_default();
                let left = ((b.end - now) / MIN).ceil();
                notes.push(b.note(Note::inside(&room, format!("⏳ {left} minutes left in {name}{next}")), "ending"));
            }
            keep.push(b);
        }
        // Keep a day of history (the last few) so "earlier today" still shows.
        keep.retain(|b| now - b.end < DAY);
        let done = keep.iter().filter(|b| b.end <= now).count();
        let mut drop = done.saturating_sub(HISTORY);
        keep.retain(|b| if b.end <= now && drop > 0 { drop -= 1; false } else { true });
        self.bookings = keep;
    }

    fn sort(&mut self) { self.bookings.sort_by(|a, b| a.start.total_cmp(&b.start)); }

    /// A booking change, from the office (`book` event): create, cancel,
    /// extend, end, update, or admit someone knocking.
    fn book(&mut self, req: &Request, m: &Value, notes: &mut Vec<Note>) -> Result<Meeting, String> {
        let (now, room, name) = (req.now, Self::room(req), req.object.name.clone());
        let me = Who::actor(&req.actor);
        let op = m["op"].as_str().unwrap_or("");
        let owned = m["owned"].as_u64().unwrap_or(0) as usize;
        let str_of = |k: &str| m[k].as_str().map(String::from);

        if op == "create" {
            if req.actor.did.is_none() && !req.actor.is_agent() { return Err("sign in to book a room".into()); }
            let start = match &m["start"] { Value::Null => now, Value::String(s) if s == "now" => now, v => time(v).unwrap_or(f64::NAN) };
            let end = match &m["end"] {
                Value::Null => start + m["minutes"].as_f64().unwrap_or(30.0).clamp(15.0, 240.0) * MIN,
                v => time(v).unwrap_or(f64::NAN),
            };
            let (start, end) = self.check_slot(&name, start, end, &me.key, None, now, owned)?;
            let title = clip(m["title"].as_str().unwrap_or(""), 80);
            let b = Meeting {
                id: format!("{:08x}", req.rng().next_u64() as u32), room: room.clone(),
                title: if title.is_empty() { format!("{}'s meeting", req.actor.name) } else { title },
                start, end, owner: me.key.clone(), name: req.actor.name.clone(), handle: req.actor.handle.clone(),
                invitees: parse_invitees(&m["invitees"]), lock: m["lock"].as_bool().unwrap_or(false),
                auto_release: m["autoRelease"].as_bool() != Some(false), seen: false, admitted: Vec::new(), sent: Sent::default(), created: now,
            };
            // Invited by DID and not here: kept for them.
            let invited = Note::to(b.holders(Some(&me)).into_iter().filter(|x| *x != b.owner), format!("📅 {} invited you to “{}” in {name}, {}", req.actor.name, b.title, stamp_range(&b)));
            if !invited.to.is_empty() { notes.push(b.note(invited.keep(), "invite")); }
            self.bookings.push(b.clone());
            self.sort();
            self.tick(req, notes);
            return Ok(self.bookings.iter().find(|x| x.id == b.id).cloned().unwrap_or(b));
        }

        let id = str_of("id").unwrap_or_default();
        let Some(i) = self.bookings.iter().position(|b| b.id == id) else { return Err("no such booking".into()) };
        let b = self.bookings[i].clone();
        if op == "admit" {
            // Anyone already holding the room can let a knocker in.
            if !b.holds(&me) || !b.running(now) { return Err("only people in the meeting can let others in".into()); }
            let Some(key) = m["to"]["key"].as_str().filter(|k| !k.is_empty()) else { return Err("they left".into()) };
            let b = &mut self.bookings[i];
            if !b.admitted.iter().any(|k| k == key) { b.admitted.push(key.into()); }
            notes.push(b.note(Note::to([key], format!("🔓 {} let you into {name}", req.actor.name)), "admit"));
            return Ok(b.clone());
        }
        // Moderators can cancel or end anyone's booking, not take it over.
        let override_ = b.owner != me.key && req.actor.is_moderator() && (op == "cancel" || op == "end");
        if b.owner != me.key && !override_ { return Err("only the person who booked it can change it".into()); }
        if override_ {
            let did = if op == "cancel" || b.start > now { "cancelled" } else { "ended" };
            notes.push(b.note(Note::to([b.owner.clone()], format!("📅 {} {did} “{}” in {name}", req.actor.name, b.title)).keep(), "override"));
        }
        match op {
            "cancel" | "end" if op == "cancel" || b.start > now => {
                self.bookings.remove(i);
                if b.end > now {
                    let to = b.holders(Some(&me));
                    if !to.is_empty() { notes.push(b.note(Note::to(to, format!("📅 “{}” in {name} was cancelled", b.title)), "cancel")); }
                }
                Ok(b)
            }
            "end" => {
                let b = &mut self.bookings[i];
                b.end = b.start.max(now);
                b.sent.ended = true;
                Ok(b.clone())
            }
            "extend" => {
                let more = m["minutes"].as_f64().unwrap_or(15.0).clamp(5.0, 120.0) * MIN;
                let (_, end) = self.check_slot(&name, b.start, b.end + more, &me.key, Some(&b.id), now, 0)?;
                let b = &mut self.bookings[i];
                b.end = end;
                b.sent.ending = false;
                Ok(b.clone())
            }
            "update" => {
                let mut nb = b.clone();
                if let Some(t) = m["title"].as_str() { let t = clip(t, 80); if !t.is_empty() { nb.title = t; } }
                if !m["invitees"].is_null() { nb.invitees = parse_invitees(&m["invitees"]); }
                if let Some(l) = m["lock"].as_bool() { nb.lock = l; }
                if !m["start"].is_null() || !m["end"].is_null() {
                    let start = if m["start"].is_null() { b.start } else { time(&m["start"]).unwrap_or(f64::NAN) };
                    let end = if m["end"].is_null() { start + (b.end - b.start) } else { time(&m["end"]).unwrap_or(f64::NAN) };
                    let (start, end) = self.check_slot(&name, start, end, &me.key, Some(&b.id), now, 0)?;
                    nb.start = start;
                    nb.end = end;
                    nb.sent = Sent::default();
                }
                self.bookings[i] = nb.clone();
                self.sort();
                Ok(nb)
            }
            _ => Err("unknown booking op".into()),
        }
    }

    /// The Skeleton Key (or another plugin with the unlock permission) let
    /// the actor in: they count as admitted to the meeting running now.
    fn unlock(&mut self, req: &Request, by: &str, notes: &mut Vec<Note>) -> Result<Meeting, String> {
        let (now, name) = (req.now, req.object.name.clone());
        let me = Who::actor(&req.actor);
        let Some(b) = self.bookings.iter_mut().find(|b| b.running(now)) else { return Err(format!("{name} isn't booked right now: just walk in")) };
        if b.holds(&me) { return Ok(b.clone()); }
        let to = b.holders(Some(&me));
        if !to.is_empty() { notes.push(b.note(Note::to(to, format!("🗝️ {} let themselves into {name} with {}", req.actor.name, clip(by, 40))), "unlock")); }
        b.admitted.push(me.key.clone());
        notes.push(b.note(Note::to([me.key.clone()], format!("🔓 {name} is open to you until “{}” ends at {}", b.title, stamp(b.end))), "unlock"));
        Ok(b.clone())
    }

    /// Every answer: the next wake-up, and the room's zone to hear people
    /// walk in.
    fn answer(&self, req: &Request, res: Response, notes: Vec<Note>) -> Response {
        let mut res = res.watch([Self::room(req)]);
        res.notify = notes;
        match self.next_event(req.now) { Some(t) => res.wake_at(t), None => res }
    }
}

fn result(r: Result<Meeting, String>, cancelled: bool) -> Value {
    match r {
        Ok(b) => {
            let mut v = json!(b);
            if cancelled { v["cancelled"] = json!(true); }
            json!({ "booking": v })
        }
        Err(e) => json!({ "error": e }),
    }
}

impl Plugin for Rooms {
    const MANIFEST: Manifest = Manifest::new("Meeting room panel")
        .doc("The panel by a meeting room's door: keeps the room's bookings, sends reminders and start/end notes, lets knockers in, and frees the room when nobody turns up. Book with the booking form, book_room or manage_booking.")
        .prompt("Check the room's schedule")
        .emoji("📅")
        .glow("#a78bfa")
        .permissions(&[Permission::Notify]);

    fn on_use(&mut self, req: &Request) -> Response {
        let mut notes = Vec::new();
        self.tick(req, &mut notes);
        self.answer(req, Response::new(), notes)
    }

    fn on_tick(&mut self, req: &Request) -> Response {
        let mut notes = Vec::new();
        self.tick(req, &mut notes);
        self.answer(req, Response::new(), notes)
    }

    fn on_action(&mut self, req: &Request) -> Response {
        let mut notes = Vec::new();
        let reply = if let Some(m) = req.office_event("book").filter(|_| req.is("book")) {
            let r = self.book(req, m, &mut notes);
            let cancelled = r.is_ok() && !self.bookings.iter().any(|b| Some(&b.id) == r.as_ref().ok().map(|x| &x.id));
            result(r, cancelled)
        } else if let Some(m) = req.office_event("unlock").filter(|_| req.is("unlock")) {
            result(self.unlock(req, m["by"].as_str().unwrap_or("a key"), &mut notes), false)
        } else {
            return Response::error("Book from the booking form (📅), or book_room / manage_booking.");
        };
        self.answer(req, Response::new().reply(reply), notes)
    }

    // A holder turning up keeps the booking from being released.
    fn on_enter(&mut self, zone: &str, req: &Request) -> Response {
        if zone == Self::room(req) {
            let me = Who::actor(&req.actor);
            if let Some(b) = self.bookings.iter_mut().find(|b| b.running(req.now) && !b.seen) {
                if b.holds(&me) { b.seen = true; }
            }
        }
        self.answer(req, Response::new(), Vec::new())
    }

    fn panel(&self, req: &Request) -> Option<Ui> {
        let name = &req.object.name;
        let now = req.now;
        let ahead: Vec<&Meeting> = self.bookings.iter().filter(|b| b.end > now).collect();
        let text = match ahead.first() {
            Some(b) if b.running(now) => format!("🔒 **“{}”** ({}) until {}. Knock to be let in.", b.title, b.name, stamp(b.end)),
            Some(b) => format!("Free until {}.", stamp(b.start)),
            None => format!("{name} is free."),
        };
        let ui = Ui::new(format!("📅 {name}")).text(format!("{text}\nBook from the booking form (📅), or book_room / manage_booking."));
        Some(if ahead.is_empty() { ui } else {
            ui.list("Coming up", ahead.iter().take(20).map(|b| format!("{}: {} ({})", stamp_range(b), b.title, b.name)))
        })
    }

    // The schedule, for every browser; the office reads it to keep the door.
    fn display(&self) -> Option<Display> {
        let list: Vec<Value> = self.bookings.iter().map(|b| {
            let mut v = json!(b);
            if let Some(o) = v.as_object_mut() { o.remove("sent"); }
            v
        }).collect();
        Some(Display::default().data(json!({ "bookings": list })))
    }
}

export_plugin!(Rooms);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;
    use agentoffice_plugin::Object;

    fn office() -> TestOffice<Rooms> {
        let mut o = TestOffice::<Rooms>::new();
        o.object = Object { id: "panel-board".into(), kind: "rooms".into(), name: "Boardroom".into(), zone: Some("board".into()) };
        o.now = 1_761_660_000_000.0; // on a 5 minute boundary
        o.sign_in("Ada", "ada.test").sign_in("Bob", "bob.test").sign_in("Cat", "cat.test");
        o.here(&[]);
        o
    }

    fn book(o: &mut TestOffice<Rooms>, who: &str, m: Value) -> Value {
        o.office_call(who, "book", "book", m).reply.expect("a reply")
    }

    fn create(o: &mut TestOffice<Rooms>, who: &str, start: f64, minutes: u32, extra: Value) -> Meeting {
        let mut m = json!({ "op": "create", "start": start, "minutes": minutes });
        if let (Some(a), Some(b)) = (m.as_object_mut(), extra.as_object()) { a.extend(b.clone()); }
        let r = book(o, who, m);
        serde_json::from_value(r["booking"].clone()).unwrap_or_else(|_| panic!("not booked: {r}"))
    }

    #[test]
    fn guests_cannot_book_people_and_agents_can() {
        let mut o = office();
        let t = o.now;
        assert_eq!(book(&mut o, "Guest", json!({ "op": "create", "start": t, "minutes": 30 }))["error"], "sign in to book a room");
        let b = create(&mut o, "Ada", t + 60.0 * MIN, 30, json!({ "title": "Design review" }));
        assert_eq!((b.title.as_str(), b.owner.as_str(), b.room.as_str()), ("Design review", "did:plc:adatest", "board"));
        o.agent("BuildBot");
        create(&mut o, "BuildBot", t + 2.0 * 60.0 * MIN, 30, json!({}));
        let shown = &o.display().unwrap().data.as_ref().unwrap()["bookings"];
        assert_eq!(shown.as_array().unwrap().len(), 2);
        assert!(shown[0].get("sent").is_none(), "what's been sent stays inside");
        o.assert_clean();
    }

    #[test]
    fn slots_snap_and_respect_the_rules() {
        let mut o = office();
        let t = o.now;
        let err = |o: &mut TestOffice<Rooms>, m: Value| book(o, "Ada", m)["error"].as_str().unwrap_or("").to_string();
        assert!(err(&mut o, json!({ "op": "create", "start": t + MIN, "end": t + 6.0 * MIN })).contains("at least 15"));
        assert!(err(&mut o, json!({ "op": "create", "start": t + MIN, "end": t + 300.0 * MIN })).contains("at most 4"));
        assert!(err(&mut o, json!({ "op": "create", "start": t + 20.0 * DAY, "minutes": 30 })).contains("14 days"));
        assert!(err(&mut o, json!({ "op": "create", "start": "half past", "minutes": 30 })).contains("must be times"));
        let b = create(&mut o, "Ada", t + 2.0 * MIN + 1000.0, 29, json!({}));
        assert_eq!((b.start, b.end), (t, t + 30.0 * MIN), "snapped to 5 minutes");
        assert!(err(&mut o, json!({ "op": "create", "start": b.start + 15.0 * MIN, "minutes": 30 })).contains("Boardroom is booked"));
        assert!(book(&mut o, "Bob", json!({ "op": "create", "start": b.end, "minutes": 30 }))["booking"].is_object(), "back to back is fine");
        assert!(err(&mut o, json!({ "op": "create", "start": t + DAY, "minutes": 30, "owned": 12 })).contains("12 upcoming"), "the limit counts the other rooms");
    }

    #[test]
    fn only_the_booker_changes_it_and_moderators_can_cancel() {
        let mut o = office();
        let t = o.now;
        let b = create(&mut o, "Ada", t + 10.0 * MIN, 30, json!({}));
        create(&mut o, "Bob", t + 55.0 * MIN, 30, json!({}));
        assert!(book(&mut o, "Bob", json!({ "op": "cancel", "id": b.id }))["error"].as_str().unwrap().contains("only the person"));
        assert_eq!(book(&mut o, "Ada", json!({ "op": "extend", "id": b.id, "minutes": 15 }))["booking"]["end"], b.end + 15.0 * MIN);
        assert!(book(&mut o, "Ada", json!({ "op": "extend", "id": b.id, "minutes": 15 }))["error"].as_str().unwrap().contains("booked"));
        o.role("Cat", "moderator").clear_notes();
        assert_eq!(book(&mut o, "Cat", json!({ "op": "cancel", "id": b.id }))["booking"]["cancelled"], true);
        let n = &o.notes()[0];
        assert_eq!((n.to.as_slice(), n.keep, n.kind.as_deref()), (&["did:plc:adatest".to_string()][..], true, Some("override")));
        assert_eq!(o.state().bookings.len(), 1);
    }

    #[test]
    fn invites_reminders_and_endings() {
        let mut o = office();
        let t = o.now;
        let b = create(&mut o, "Ada", t + 30.0 * MIN, 30, json!({ "invitees": "@Cat.test, did:plc:zed", "title": "Sync" }));
        let invite = o.notes().iter().find(|n| n.kind.as_deref() == Some("invite")).unwrap();
        assert_eq!(invite.to, ["cat.test", "did:plc:zed"]);
        assert!(invite.keep, "kept for invitees who aren't in");

        o.clear_notes();
        o.now = t + 26.0 * MIN;
        o.tick();
        o.tick();
        let soon: Vec<_> = o.notes().iter().filter(|n| n.kind.as_deref() == Some("soon")).collect();
        assert_eq!(soon.len(), 1, "once");
        assert_eq!(soon[0].outside.as_deref(), Some("board"));

        o.now = b.start - 1000.0;
        o.here(&["Ada"]);
        o.tick();
        assert!(o.state().bookings[0].seen, "a holder in the room");
        assert!(o.notes().iter().any(|n| n.kind.as_deref() == Some("start") && n.text.contains("starting now")));

        o.now = b.end - 5.0 * MIN - 1000.0;
        o.tick();
        let ending = o.notes().iter().find(|n| n.kind.as_deref() == Some("ending")).unwrap();
        assert!(ending.text.contains("5 minutes left in Boardroom"));
        assert_eq!(ending.inside.as_deref(), Some("board"));
        o.tick();
        assert!(o.notes().iter().any(|n| n.kind.as_deref() == Some("ended")));
        assert_eq!(o.state().bookings.len(), 1, "kept as history for a day");
        o.now += DAY;
        o.use_as("Ada");
        assert!(o.state().bookings.is_empty());
        o.assert_clean();
    }

    #[test]
    fn no_shows_are_released_and_turning_up_keeps_it() {
        let mut o = office();
        let t = o.now;
        create(&mut o, "Ada", t, 60, json!({}));
        o.now = t + 11.0 * MIN;
        o.use_as("Bob");
        assert!(o.state().bookings.is_empty());
        let n = o.notes().iter().find(|n| n.kind.as_deref() == Some("released")).unwrap();
        assert!(n.keep && n.text.contains("Nobody turned up"));

        let mut o = office();
        create(&mut o, "Ada", t, 60, json!({ "autoRelease": false }));
        o.now = t + 11.0 * MIN;
        o.use_as("Bob");
        assert_eq!(o.state().bookings.len(), 1, "kept: auto-release was off");

        let mut o = office();
        create(&mut o, "Ada", t, 60, json!({}));
        assert!(o.watching().contains(&"board".to_string()));
        o.now = t + 5.0 * MIN;
        o.walk_in("Ada", "board");
        o.now = t + 11.0 * MIN;
        o.use_as("Bob");
        assert_eq!(o.state().bookings.len(), 1, "walking in in time keeps it");
    }

    #[test]
    fn holders_admit_knockers_and_keys_let_people_in() {
        let mut o = office();
        let t = o.now;
        let b = create(&mut o, "Ada", t, 30, json!({ "invitees": ["cat.test"] }));
        let bob = json!({ "id": "bob", "key": "did:plc:bobtest", "name": "Bob" });
        assert!(book(&mut o, "Bob", json!({ "op": "admit", "id": b.id, "to": bob }))["error"].as_str().unwrap().contains("only people in the meeting"));
        o.clear_notes();
        book(&mut o, "Cat", json!({ "op": "admit", "id": b.id, "to": bob }));
        assert_eq!(o.state().bookings[0].admitted, ["did:plc:bobtest"]);
        assert!(o.notes()[0].text.contains("Cat let you into Boardroom"));

        o.agent("Dee");
        o.clear_notes();
        let r = o.office_call("Dee", "unlock", "unlock", json!({ "by": "Skeleton Key" })).reply.unwrap();
        assert!(r["booking"].is_object());
        assert!(o.state().bookings[0].admitted.contains(&"agent:Dee".to_string()));
        assert!(o.notes()[0].text.contains("Dee let themselves into Boardroom with Skeleton Key"));
        assert!(!o.notes()[0].to.contains(&"agent:Dee".to_string()));
        assert!(o.notes()[1].text.contains("open to you until"));

        // Nobody can do either from a panel.
        assert!(o.act("Eve", "book").toast.is_some());
        assert!(o.act("Eve", "unlock").reply.is_none());
        assert!(!o.state().bookings[0].admitted.iter().any(|k| k.contains("Eve")));
    }

    #[test]
    fn old_state_loads() {
        // A room:board entity's bookings, as the office hands them over.
        let r: Rooms = serde_json::from_str(r#"{"bookings":[{"id":"ab12cd34","room":"board","title":"Retro","start":1761660000000,"end":1761661800000,"owner":"did:plc:ada","name":"ada","handle":null,"invitees":["cat.test"],"lock":false,"autoRelease":true,"seen":false,"admitted":[],"sent":{"soon":true},"created":1761650000000}]}"#).unwrap();
        assert_eq!((r.bookings[0].title.as_str(), r.bookings[0].sent.soon, r.bookings[0].auto_release), ("Retro", true, true));
    }
}
