//! Office Rally: a checkpoint race around the office, as a WASM plugin built
//! with the agentoffice-plugin crate. It stands as a flag in the Lobby.
//!
//! Someone joins and a countdown starts; everyone who joins before it runs
//! out races. The rally picks three areas in a random order, then back to
//! the Lobby. Racers just walk there: the plugin answers `watch` with the
//! route's zones, the office subscribes the object's Durable Object to those
//! zones, and every time someone walks into one the plugin hears about it
//! ([`Plugin::on_enter`]). The first three home win medals (`give`), best
//! times stay on the board, and the office's alarm (`wake_at`) starts the
//! race, warns at one minute left and calls time.
//!
//! The type is the object's memory, kept as JSON in its entity (an ItemDO),
//! which also runs one call at a time, so every move is atomic.
//!
//! Build with `just plugin-build rally`, test with `just plugin-test rally`.

use agentoffice_plugin::prelude::*;

pub struct Zone { pub id: &'static str, pub name: &'static str, pub emoji: &'static str }

pub const CHECKPOINTS: [Zone; 5] = [
    Zone { id: "kitchen", name: "Kitchen", emoji: "☕" },
    Zone { id: "lounge", name: "Lounge", emoji: "🛋️" },
    Zone { id: "open", name: "Open Office", emoji: "💻" },
    Zone { id: "focus", name: "Deep Work Den", emoji: "🎧" },
    Zone { id: "booths", name: "Phone Booths", emoji: "📞" },
];
pub const HOME: Zone = Zone { id: "lobby", name: "Lobby", emoji: "🏁" };
pub const LEGS: usize = 3; // checkpoints per race, before the run home
pub const GATHER_MS: f64 = 20_000.0;
pub const RACE_MS: f64 = 180_000.0;
pub const WARN_MS: f64 = 60_000.0;
pub const MAX_RACERS: usize = 12;
const BOARD: usize = 10;
const KEEP_STATS: usize = 60; // the office keeps 32 KB of state
const KEEP_HISTORY: usize = 3;
const MEDALS: [(&str, &str, &str); 3] = [
    ("rally:gold", "Rally Gold Medal", "🥇"),
    ("rally:silver", "Rally Silver Medal", "🥈"),
    ("rally:bronze", "Rally Bronze Medal", "🥉"),
];

fn zone(id: &str) -> &'static Zone {
    CHECKPOINTS.iter().chain(std::iter::once(&HOME)).find(|z| z.id == id).unwrap_or(&HOME)
}
fn first(name: &str) -> String { name.split_whitespace().next().unwrap_or("someone").to_string() }
pub fn clock(ms: f64) -> String {
    let tenths = (ms.max(0.0) / 100.0).round() as u64;
    format!("{}:{:02}.{}", tenths / 600, (tenths / 10) % 60, tenths % 10)
}
fn ordinal(n: usize) -> String {
    let suffix = match (n % 10, n % 100) { (1, x) if x != 11 => "st", (2, x) if x != 12 => "nd", (3, x) if x != 13 => "rd", _ => "th" };
    format!("{n}{suffix}")
}
// Who someone is across rounds: their DID when signed in, else their name.
fn person_key(a: &Actor) -> String { a.did.clone().unwrap_or_else(|| format!("name:{}", a.name.to_lowercase())) }

#[derive(Serialize, Deserialize, Default, PartialEq, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase { #[default] Idle, Gathering, Racing }

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Racer {
    pub id: String,
    pub key: String,
    pub name: String,
    pub step: usize,
    pub splits: Vec<f64>,
    pub finished_at: Option<f64>,
    pub place: Option<usize>,
    pub gave_up: bool,
}

impl Racer { fn done(&self) -> bool { self.finished_at.is_some() || self.gave_up } }

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Stat { pub key: String, pub name: String, pub best: Option<f64>, pub wins: u32, pub podiums: u32, pub races: u32 }

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Result { pub name: String, pub ms: f64, pub place: usize }

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Round { pub n: u32, pub results: Vec<Result>, pub dnf: usize }

/// The whole rally: this round, the all-time board, the last few rounds.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Rally {
    pub n: u32,
    pub phase: Phase,
    pub starts_at: f64,
    pub ends_at: f64,
    pub route: Vec<String>,
    pub racers: Vec<Racer>,
    pub warned: bool,
    pub stats: Vec<Stat>,
    pub history: Vec<Round>,
}

impl Plugin for Rally {
    const MANIFEST: Manifest = Manifest::new("Office Rally")
        .doc("A checkpoint race around the office. Join at the flag in the Lobby; 20 s later it picks 3 areas in a random order, then back to the Lobby (3 minutes max). Just walk the route: the rally watches those zones. First three home get medals.")
        .prompt("Join the rally")
        .emoji("🏁")
        .glow("#f59e0b")
        .look(Look::Flag)
        .actions(&[
            Action::new("join", "Join the next race (the first to join starts a 20-second countdown)"),
            Action::new("leave", "Leave the next race, or give up mid-race"),
            Action::new("start", "Start the race now, if you're in it"),
            Action::new("board", "All-time best times"),
        ]);

    fn on_action(&mut self, req: &Request) -> Response {
        match req.action.as_str() {
            "join" => self.join(req),
            "leave" => self.leave(req),
            "start" if self.phase == Phase::Gathering && self.racer(&req.actor.id).is_some() => self.start(req.now),
            "start" => Response::error("Only someone in the next race can start it."),
            "board" => Response::new().ui(self.board()),
            _ => Response::error(format!("The rally doesn't know how to {}", req.action)),
        }.wake(self)
    }

    fn on_use(&mut self, _req: &Request) -> Response { Response::new().wake(self) }

    fn on_tick(&mut self, req: &Request) -> Response {
        let now = req.now;
        let r = match self.phase {
            Phase::Gathering if now >= self.starts_at => self.start(now),
            Phase::Racing if now >= self.ends_at => self.finish(),
            Phase::Racing if !self.warned && now >= self.ends_at - WARN_MS => {
                self.warned = true;
                Response::new().say("⏱ One minute left in the rally!")
            }
            _ => Response::new(),
        };
        r.wake(self)
    }

    // A racer walked into one of the route's areas.
    fn on_enter(&mut self, zone_id: &str, req: &Request) -> Response {
        if self.phase != Phase::Racing { return Response::new(); }
        let (starts_at, legs) = (self.starts_at, self.route.len());
        let Some(i) = self.racers.iter().position(|r| r.id == req.actor.id) else { return Response::new() };
        let me = &self.racers[i];
        if me.done() || self.route.get(me.step).map(String::as_str) != Some(zone_id) { return Response::new(); }
        let place = self.racers.iter().filter(|r| r.finished_at.is_some()).count() + 1;
        let me = &mut self.racers[i];
        me.step += 1;
        me.splits.push(req.now - starts_at);
        if me.step < legs {
            let next = zone(&self.route[me.step]);
            let home = if next.id == HOME.id { ", back to the flag!" } else { "" };
            return Response::new().toast(format!("✓ {} ({}/{legs}). Next: {} {}{home}", zone(zone_id).name, me.step, next.emoji, next.name));
        }
        me.finished_at = Some(req.now);
        me.place = Some(place);
        let ms = req.now - starts_at;
        let (name, key) = (me.name.clone(), me.key.clone());
        let best = self.stats.iter().find(|s| s.key == key).and_then(|s| s.best);
        let pb = if best.is_some_and(|b| ms < b) { ", a personal best!" } else { "" };
        let medal = MEDALS.get(place - 1);
        let mut r = Response::new()
            .say(format!("{} {} finished the rally {} in {}{pb}", medal.map_or("🏁", |m| m.2), first(&name), ordinal(place), clock(ms)))
            .toast(format!("Finished {} in {}.", ordinal(place), clock(ms)));
        if let Some((kind, mname, emoji)) = medal {
            r = r.give(Give::new(*kind).name(*mname).emoji(*emoji).verb("shows off").data(json!({ "rally": self.n, "ms": ms })));
        }
        if self.racers.iter().all(Racer::done) {
            let end = self.finish();
            r.say = Some(format!("{}\n{}", r.say.unwrap_or_default(), end.say.unwrap_or_default()));
            r.watch = end.watch;
        }
        r.wake(self)
    }

    fn panel(&self, req: &Request) -> Option<Ui> {
        let now = req.now;
        let me = self.racer(&req.actor.id);
        let ui = Ui::new("🏁 Office Rally");
        let ui = match self.phase {
            Phase::Idle => {
                let ui = ui.text(format!("Race around the office! Hit {LEGS} checkpoints in the order the rally picks, then get back to the Lobby. Just walk there: the rally sees you arrive. The first three home win medals, and best times stay on the board."))
                    .primary("Join the next race", "join");
                match self.history.first() {
                    Some(last) if last.results.is_empty() => ui.list(format!("Last race (#{})", last.n), ["Nobody made it back in time."]),
                    Some(last) => ui.list(format!("Last race (#{})", last.n), last.results.iter().map(|r| format!("{}: {}", r.name, clock(r.ms)))),
                    None => ui,
                }
            }
            Phase::Gathering => {
                let secs = ((self.starts_at - now).max(0.0) / 1000.0).ceil();
                let ui = ui.text(format!("Rally #{} starts in **{secs} s**. {}", self.n, if me.is_some() { "You're in! Stay close: the route is announced at the start." } else { "Join to race." }));
                let ui = if me.is_some() { ui.button("Leave", "leave").primary("Start now", "start") } else { ui.primary("Join", "join") };
                ui.list(format!("Racers ({}/{MAX_RACERS})", self.racers.len()), self.racers.iter().map(|r| r.name.clone()))
            }
            Phase::Racing => {
                let left = clock(self.ends_at - now);
                let left = left.split('.').next().unwrap_or("0:00");
                match me {
                    Some(m) if !m.done() => {
                        let next = zone(&self.route[m.step]);
                        ui.text(format!("Rally #{}, {left} left. Next: **{} {}**.", self.n, next.emoji, next.name))
                            .button("Give up", "leave")
                            .list("Your route", self.route_rows(m))
                    }
                    Some(m) if m.finished_at.is_some() => ui
                        .text(format!("You finished **{}** in {}. {left} left for the others.", ordinal(m.place.unwrap_or(0)), clock(m.finished_at.unwrap_or(0.0) - self.starts_at)))
                        .list("Your route", self.route_rows(m)),
                    _ => ui
                        .text(format!("Rally #{} is on: {} racing, {left} left. Join the next one when it's over.", self.n, self.racers.len()))
                        .list("Standings", self.standings()),
                }
            }
        };
        Some(ui.button("Leaderboard", "board"))
    }

    fn display(&self) -> Option<Display> {
        Some(match self.phase {
            Phase::Gathering => Display::label(format!("🏁 Rally #{}: join now!", self.n)).glow("#f59e0b").until(self.starts_at),
            Phase::Racing => Display::label(format!("🏁 Rally #{} racing", self.n)).glow("#ef4444").until(self.ends_at),
            Phase::Idle => Display::default(),
        })
    }
}

trait Wake { fn wake(self, rally: &Rally) -> Self; }
impl Wake for Response {
    // Every answer asks for the next wake-up the round needs.
    fn wake(mut self, rally: &Rally) -> Self {
        if self.wake_at.is_none() {
            self.wake_at = match rally.phase {
                Phase::Gathering => Some(rally.starts_at),
                Phase::Racing if rally.warned => Some(rally.ends_at),
                Phase::Racing => Some(rally.ends_at - WARN_MS),
                Phase::Idle => None,
            };
        }
        self
    }
}

impl Rally {
    pub fn racer(&self, id: &str) -> Option<&Racer> { self.racers.iter().find(|r| r.id == id) }

    fn join(&mut self, req: &Request) -> Response {
        let a = &req.actor;
        if self.racer(&a.id).is_some() {
            return Response::error(if self.phase == Phase::Racing { "You're already racing! Go go go." } else { "You're in. Wait for the countdown." });
        }
        if self.phase == Phase::Racing { return Response::error("A race is on. Join the next one when it's over."); }
        if self.racers.len() >= MAX_RACERS { return Response::error(format!("The next race is full ({MAX_RACERS} racers).")); }
        let say = if self.phase == Phase::Idle {
            self.n += 1;
            self.phase = Phase::Gathering;
            self.starts_at = req.now + GATHER_MS;
            self.route.clear();
            self.warned = false;
            format!("🏁 {} wants to race! Join at the flag in the Lobby: the rally starts in {} seconds.", first(&a.name), GATHER_MS / 1000.0)
        } else {
            format!("🏁 {} joined the rally ({} racing).", first(&a.name), self.racers.len() + 1)
        };
        self.racers.push(Racer { id: a.id.clone(), key: person_key(a), name: a.name.clone(), ..Default::default() });
        Response::new().say(say)
    }

    fn leave(&mut self, req: &Request) -> Response {
        let Some(i) = self.racers.iter().position(|r| r.id == req.actor.id) else { return Response::error("You're not in this race.") };
        if self.phase != Phase::Racing {
            self.racers.remove(i);
            if self.racers.is_empty() { self.phase = Phase::Idle; }
            return Response::new().toast("You left the next race.");
        }
        if self.racers[i].finished_at.is_some() { return Response::error("You already finished!"); }
        self.racers[i].gave_up = true;
        let say = format!("🏳️ {} gave up.", first(&req.actor.name));
        if !self.racers.iter().all(Racer::done) { return Response::new().say(say); }
        let mut end = self.finish();
        end.say = Some(format!("{say}\n{}", end.say.unwrap_or_default()));
        end
    }

    // A random route: three checkpoints, shuffled from the clock, then home.
    fn start(&mut self, now: f64) -> Response {
        if self.racers.is_empty() {
            self.phase = Phase::Idle;
            return Response::new().say("🏁 Nobody turned up for the rally.");
        }
        let mut seed = (now as u64) ^ (u64::from(self.n) << 40) ^ 0x9e37_79b9_7f4a_7c15;
        let mut ids: Vec<&str> = CHECKPOINTS.iter().map(|z| z.id).collect();
        for i in (1..ids.len()).rev() {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
            ids.swap(i, (seed % (i as u64 + 1)) as usize);
        }
        self.route = ids.into_iter().take(LEGS).chain(std::iter::once(HOME.id)).map(String::from).collect();
        self.phase = Phase::Racing;
        self.starts_at = now;
        self.ends_at = now + RACE_MS;
        self.warned = false;
        let route = self.route.iter().map(|z| { let z = zone(z); format!("{} {}", z.emoji, z.name) }).collect::<Vec<_>>().join(" → ");
        let names = self.racers.iter().map(|r| first(&r.name)).collect::<Vec<_>>().join(", ");
        let mut watch = self.route.clone();
        watch.dedup();
        // Tell the office which areas to report people walking into.
        Response::new().say(format!("🏁 GO! Rally #{}: {route}. Racing: {names}.", self.n)).watch(watch)
    }

    // Call time: results into the board and the history, stop watching.
    fn finish(&mut self) -> Response {
        let mut results = Vec::new();
        let raced = self.racers.len();
        for r in std::mem::take(&mut self.racers) {
            let i = match self.stats.iter().position(|s| s.key == r.key) {
                Some(i) => i,
                None => { self.stats.push(Stat { key: r.key.clone(), ..Default::default() }); self.stats.len() - 1 }
            };
            let s = &mut self.stats[i];
            s.name = r.name.clone();
            s.races += 1;
            if let (Some(at), Some(place)) = (r.finished_at, r.place) {
                let ms = at - self.starts_at;
                if s.best.is_none_or(|b| ms < b) { s.best = Some(ms); }
                if place <= 3 { s.podiums += 1; }
                if place == 1 { s.wins += 1; }
                results.push(Result { name: r.name.clone(), ms, place });
            }
        }
        results.sort_by_key(|r| r.place);
        self.sort_stats();
        self.stats.truncate(KEEP_STATS);
        let podium = results.iter().take(3).map(|r| format!("{} {} {}", MEDALS[r.place - 1].2, first(&r.name), clock(r.ms))).collect::<Vec<_>>().join("  ");
        let say = format!("🏁 Rally #{} is over. {}", self.n, if podium.is_empty() { "Nobody made it back in time!".to_string() } else { podium });
        let dnf = raced - results.len();
        self.history.insert(0, Round { n: self.n, results, dnf });
        self.history.truncate(KEEP_HISTORY);
        self.phase = Phase::Idle;
        self.route.clear();
        Response::new().say(say).unwatch()
    }

    fn sort_stats(&mut self) {
        self.stats.sort_by(|a, b| a.best.unwrap_or(f64::MAX).total_cmp(&b.best.unwrap_or(f64::MAX)).then(b.wins.cmp(&a.wins)));
    }

    fn route_rows(&self, m: &Racer) -> Vec<String> {
        self.route.iter().enumerate().map(|(i, z)| {
            let z = zone(z);
            let mark = if m.step > i { "✓" } else if m.step == i && !m.done() { "➜" } else { "·" };
            let split = m.splits.get(i).map(|s| format!(" ({})", clock(*s))).unwrap_or_default();
            format!("{mark} {} {}{split}", z.emoji, z.name)
        }).collect()
    }

    fn standings(&self) -> Vec<String> {
        let mut rs: Vec<&Racer> = self.racers.iter().collect();
        rs.sort_by(|a, b| a.place.unwrap_or(99).cmp(&b.place.unwrap_or(99)).then(b.step.cmp(&a.step)));
        rs.iter().map(|r| match (r.finished_at, r.place) {
            (Some(at), Some(p)) => format!("{}: {}, {}", r.name, ordinal(p), clock(at - self.starts_at)),
            _ if r.gave_up => format!("{}: gave up", r.name),
            _ => format!("{}: {}/{}", r.name, r.step, self.route.len()),
        }).collect()
    }

    fn board(&self) -> Ui {
        let top: Vec<&Stat> = self.stats.iter().filter(|s| s.best.is_some()).take(BOARD).collect();
        let ui = Ui::new("🏆 Rally leaderboard").text(if top.is_empty() { "No times yet. Be the first!" } else { "Best times, all time." });
        let ui = if top.is_empty() { ui } else {
            ui.list("Best times", top.iter().map(|s| format!("{}: {} · {} win{}, {} race{}", s.name, clock(s.best.unwrap_or(0.0)), s.wins, if s.wins == 1 { "" } else { "s" }, s.races, if s.races == 1 { "" } else { "s" })))
        };
        ui.primary("Back", "use")
    }
}

export_plugin!(Rally);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    fn racing() -> (TestOffice<Rally>, Vec<String>) {
        let mut office = TestOffice::<Rally>::new();
        office.sign_in("Ada Lovelace", "ada.test");
        let r = office.act("Ada Lovelace", "join");
        assert!(r.say.unwrap().contains("Ada wants to race"));
        assert!(office.wake_at().is_some(), "the countdown is an alarm");
        office.act("Bob", "join");
        let go = office.tick();
        assert!(go.say.unwrap().starts_with("🏁 GO! Rally #1"));
        let route = office.state().route;
        assert_eq!(route.len(), LEGS + 1);
        assert_eq!(route.last().map(String::as_str), Some("lobby"));
        (office, route)
    }

    #[test]
    fn a_race_watches_the_route_and_hands_out_medals() {
        let (mut office, route) = racing();
        let mut want = route.clone();
        want.sort();
        let mut got = office.watching().to_vec();
        got.sort();
        assert_eq!(got, want, "asks the office to watch the route");
        assert!(office.act("Cy", "join").toast.unwrap().contains("A race is on"));

        // Out of order doesn't count; in order does.
        assert!(office.walk_in("Ada Lovelace", &route[1]).unwrap().toast.is_none());
        let r = office.walk_in("Ada Lovelace", &route[0]).unwrap();
        assert!(r.toast.unwrap().contains("(1/4)"));
        assert!(r.ui.is_none(), "an event opens no panel");
        for z in &route[1..LEGS] { office.walk_in("Ada Lovelace", z); }
        let r = office.walk_in("Ada Lovelace", "lobby").unwrap();
        assert!(r.say.unwrap().contains("Ada finished the rally 1st"));
        assert_eq!(office.inventory("Ada Lovelace")[0].kind, "rally:gold");
        assert!(r.watch.is_none(), "Bob is still racing");

        // Bob gives up: the round ends and stops watching.
        let r = office.act("Bob", "leave");
        let say = r.say.unwrap();
        assert!(say.contains("Bob gave up") && say.contains("Rally #1 is over. 🥇 Ada"), "{say}");
        assert!(office.watching().is_empty());
        assert_eq!(office.state().phase, Phase::Idle);
        assert!(office.walk_in("Ada Lovelace", "kitchen").is_none(), "not watching any more");

        let board = office.act("Bob", "board").ui.unwrap();
        let rows = board.list.unwrap().rows;
        assert_eq!(rows.len(), 1, "only finishers have a time");
        assert!(rows[0].starts_with("Ada Lovelace: ") && rows[0].ends_with("1 win, 1 race"), "{}", rows[0]);
        assert_eq!(office.state().stats.iter().find(|s| s.key == "name:bob").unwrap().races, 1);
        assert!(office.use_as("Bob").ui.unwrap().list.unwrap().title.contains("Last race (#1)"));
        office.assert_clean();
    }

    #[test]
    fn it_warns_at_a_minute_left_then_calls_time() {
        let (mut office, _) = racing();
        assert!(office.tick().say.unwrap().contains("One minute left"));
        let r = office.tick();
        assert!(r.say.unwrap().contains("Nobody made it back in time"));
        assert_eq!(r.watch, Some(vec![]));
        assert_eq!(office.wake_at(), None);
        assert_eq!(office.state().history[0].dnf, 2);
        office.assert_clean();
    }

    #[test]
    fn start_now_and_leaving_before_the_start() {
        let mut office = TestOffice::<Rally>::new();
        assert!(office.act("Ada", "start").toast.is_some());
        office.act("Ada", "join");
        assert_eq!(office.act("Ada", "leave").toast.as_deref(), Some("You left the next race."));
        assert_eq!(office.state().phase, Phase::Idle);
        office.act("Ada", "join");
        assert!(office.act("Ada", "start").say.unwrap().contains("GO!"));
        office.assert_clean();
    }

    #[test]
    fn clocks_and_places() {
        assert_eq!(clock(83_400.0), "1:23.4");
        assert_eq!(clock(5_049.0), "0:05.0");
        assert_eq!(ordinal(1), "1st");
        assert_eq!(ordinal(12), "12th");
        assert_eq!(ordinal(23), "23rd");
    }
}
