//! The desk computer, as a WASM plugin built with the agentoffice-plugin
//! crate. Walk up to any desk, press E, and your own workstation comes up:
//! notes, a todo list, bookmarks, a personal focus timer and a small office
//! shell. The office runs this module as a program: the Workstation entity
//! (server/entities/workstation.js) keeps one per identity, checks it's
//! yours and that you're at a desk, and calls one method per request
//! (`action` the method, `data` its params), answering with `reply` or
//! `error`. What the shell prints about the office (who's in, desks,
//! bookings) comes in with the `run` call; WASM sees nothing else.
//!
//! The timer rings on the office's wake-up call (`wake_at`): the answer's
//! toast goes to the owner, even if they've left by then.
//!
//! Build with `just plugin-build workstation`, test with `just plugin-test workstation`.

use agentoffice_plugin::prelude::*;

pub const NOTES: usize = 30;
pub const NOTE_TEXT: usize = 20_000;
pub const TODOS: usize = 100;
pub const LINKS: usize = 40;
pub const TIMER_MIN: i64 = 240;
const MIN: i64 = 60_000;

/// Field names as the JS entity kept them, so saved workstations load as is.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct Note { pub id: String, pub title: String, pub text: String, pub updated: i64 }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct Todo { pub id: String, pub text: String, pub done: bool, pub at: i64 }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct Link { pub id: String, pub title: String, pub url: String }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Timer { pub label: String, pub minutes: i64, pub ends_at: i64 }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct Workstation {
    pub notes: Vec<Note>,
    pub todos: Vec<Todo>,
    pub links: Vec<Link>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timer: Option<Timer>,
}

// ---- text ---------------------------------------------------------------------

/// Control characters (but tabs and newlines) to spaces, cut to `n`.
pub fn clip(s: &str, n: usize) -> String {
    s.chars().map(|c| if (c as u32) < 0x20 && c != '\t' && c != '\n' { ' ' } else { c }).take(n).collect()
}

/// One line: clipped, newlines to spaces, trimmed.
pub fn line(s: &str, n: usize) -> String { clip(s, n).replace('\n', " ").trim().to_string() }

fn pad(s: &str, n: usize) -> String {
    let len = s.chars().count();
    if len >= n { s.to_string() } else { format!("{s}{}", " ".repeat(n - len)) }
}

fn ago(ms: i64) -> String {
    let r = |d: f64| (ms as f64 / d).round() as i64;
    if ms < MIN { "just now".into() } else if ms < 60 * MIN { format!("{} min ago", r(MIN as f64)) } else { format!("{} h ago", r((60 * MIN) as f64)) }
}

/// A bookmark: http(s), or a page of the office itself (`/docs…`). Bare
/// hosts get https; the scheme and host are lowercased and an empty path
/// becomes `/`, as a browser would.
pub fn clean_url(u: &str) -> Option<String> {
    let u = u.trim();
    if u.is_empty() { return None; }
    if u.starts_with('/') { return Some(u.chars().take(500).collect()); }
    let has_scheme = u.find(':').is_some_and(|i| {
        let s = &u[..i];
        s.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let u = if has_scheme { u.to_string() } else { format!("https://{u}") };
    let (scheme, rest) = u.split_once(':')?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" { return None; }
    let rest = rest.trim_start_matches(['/', '\\']);
    let cut = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (auth, tail) = rest.split_at(cut);
    let host = auth.rsplit('@').next().unwrap_or("");
    if host.is_empty() || auth.chars().any(|c| c.is_whitespace() || c.is_control() || "<>\"^`{|}\\".contains(c)) { return None; }
    let auth = match auth.rsplit_once('@') { Some((user, h)) => format!("{user}@{}", h.to_ascii_lowercase()), None => auth.to_ascii_lowercase() };
    let mut tail: String = tail.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect::<String>().replace(' ', "%20");
    if !tail.starts_with('/') { tail.insert(0, '/'); }
    let href = format!("{scheme}://{auth}{tail}");
    Some(href.chars().take(500).collect())
}

/// `Thu, 29 Oct 2026 16:55:10 GMT`, as `Date.toUTCString` prints it.
pub fn utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MO: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{}, {d:02} {} {y} {:02}:{:02}:{:02} GMT", WD[days.rem_euclid(7) as usize], MO[(m - 1) as usize], sod / 3600, sod / 60 % 60, sod % 60)
}

fn stamp_ms(ms: i64) -> String { stamp(ms as f64) }

// A number the way JS's Number() reads one: numbers, numeric strings.
fn number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str { v.get(k).and_then(Value::as_str).unwrap_or("") }

type R<T> = Result<T, String>;

// ---- the methods ----------------------------------------------------------------

/// What `run` gets besides the line: who's asking and the office as it is.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RunArgs {
    pub line: String,
    /// The caller's key (their DID, or agent:name).
    pub key: String,
    pub office: Office,
    /// App ids `open` knows (the browser's built-ins and the plugin apps).
    pub apps: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Office {
    pub online: Vec<Online>,
    pub desks: Vec<Desk>,
    pub bookings: Vec<Booking>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Online { pub name: String, pub kind: String, pub zone: String, pub status: String, pub note: String }

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Desk { pub id: String, pub name: String, pub goal: String, pub seen: i64 }

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Booking { pub start: i64, pub end: i64, pub room: String, pub title: String, pub name: String }

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Printed {
    pub out: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

fn out(s: impl Into<String>) -> R<Printed> { Ok(Printed { out: s.into(), ..Default::default() }) }

impl Workstation {
    fn new_id(rng: &mut Rng) -> String { format!("{:08x}", rng.next_u64() as u32) }

    pub fn sorted_notes(&self) -> Vec<Note> {
        let mut n = self.notes.clone();
        n.sort_by(|a, b| b.updated.cmp(&a.updated));
        n
    }

    pub fn note_save(&mut self, args: &Value, now: i64, rng: &mut Rng) -> R<Note> {
        let id = s(args, "id");
        let i = match (!id.is_empty()).then(|| self.notes.iter().position(|n| n.id == id)) {
            Some(None) => return Err("no such note".into()),
            Some(Some(i)) => i,
            None => {
                if self.notes.len() >= NOTES { return Err(format!("{NOTES} notes at most: delete one first")); }
                self.notes.push(Note { id: Self::new_id(rng), ..Default::default() });
                self.notes.len() - 1
            }
        };
        let n = &mut self.notes[i];
        n.text = clip(s(args, "text"), NOTE_TEXT);
        let title = args.get("title").and_then(Value::as_str).map(String::from).unwrap_or_else(|| n.title.clone());
        n.title = Some(line(&title, 80)).filter(|t| !t.is_empty())
            .unwrap_or_else(|| line(n.text.split('\n').find(|l| !l.trim().is_empty()).unwrap_or("Untitled"), 80));
        n.updated = now;
        Ok(n.clone())
    }

    pub fn todo_add(&mut self, text: &str, now: i64, rng: &mut Rng) -> R<Todo> {
        let text = line(text, 200);
        if text.is_empty() { return Err("say what to do".into()); }
        if self.todos.len() >= TODOS { return Err(format!("{TODOS} todos at most: clear some first")); }
        let t = Todo { id: Self::new_id(rng), text, done: false, at: now };
        self.todos.push(t.clone());
        Ok(t)
    }

    pub fn todo_set(&mut self, args: &Value) -> R<Todo> {
        let id = s(args, "id");
        let t = self.todos.iter_mut().find(|t| t.id == id).ok_or("no such todo")?;
        if let Some(d) = args.get("done").filter(|d| !d.is_null()) { t.done = d.as_bool().unwrap_or(number(d) != 0.0); }
        if let Some(text) = args.get("text").and_then(Value::as_str) {
            let text = line(text, 200);
            if !text.is_empty() { t.text = text; }
        }
        Ok(t.clone())
    }

    /// One todo, or every finished one with id `done`.
    pub fn todo_remove(&mut self, id: &str) -> usize {
        let before = self.todos.len();
        self.todos.retain(|t| if id == "done" { !t.done } else { t.id != id });
        before - self.todos.len()
    }

    pub fn link_add(&mut self, url: &str, title: &str, rng: &mut Rng) -> R<Link> {
        let href = clean_url(url).ok_or("only http(s) links or office paths like /docs")?;
        if self.links.len() >= LINKS { return Err(format!("{LINKS} bookmarks at most")); }
        let title = Some(line(title, 80)).filter(|t| !t.is_empty())
            .unwrap_or_else(|| href.trim_start_matches("https://").trim_start_matches("http://").chars().take(80).collect());
        let l = Link { id: Self::new_id(rng), url: href, title };
        self.links.push(l.clone());
        Ok(l)
    }

    pub fn timer_start(&mut self, minutes: &Value, label: &str, now: i64) -> R<Timer> {
        let m = number(minutes).round();
        if !(m >= 1.0 && m <= TIMER_MIN as f64) { return Err(format!("1 to {TIMER_MIN} minutes")); }
        let m = m as i64;
        let label = Some(line(label, 60)).filter(|l| !l.is_empty()).unwrap_or_else(|| "Focus".into());
        let t = Timer { label, minutes: m, ends_at: now + m * MIN };
        self.timer = Some(t.clone());
        Ok(t)
    }

    /// The office's wake-up call: ring if it's time (the toast for the owner).
    pub fn ring(&mut self, now: i64) -> Option<String> {
        let t = self.timer.as_ref()?;
        if t.ends_at > now + 1000 { return None; }
        let t = self.timer.take()?;
        Some(format!("⏰ {}: your {}-minute timer is up.", t.label, t.minutes))
    }

    pub fn call(&mut self, req: &Request) -> R<Value> {
        let a = &req.data.clone().unwrap_or(Value::Null);
        let now = req.now as i64;
        let mut rng = req.rng();
        Ok(match req.action.as_str() {
            "desktop" => json!({ "notes": self.sorted_notes(), "todos": self.todos, "links": self.links, "timer": self.timer }),
            "noteSave" => v(&self.note_save(a, now, &mut rng)?),
            "noteDelete" => {
                let before = self.notes.len();
                self.notes.retain(|n| n.id != s(a, "id"));
                json!({ "ok": self.notes.len() < before })
            }
            "todoAdd" => v(&self.todo_add(s(a, "text"), now, &mut rng)?),
            "todoSet" => v(&self.todo_set(a)?),
            "todoRemove" => json!({ "removed": self.todo_remove(s(a, "id")) }),
            "linkAdd" => v(&self.link_add(s(a, "url"), s(a, "title"), &mut rng)?),
            "linkRemove" => {
                let before = self.links.len();
                self.links.retain(|l| l.id != s(a, "id"));
                json!({ "ok": self.links.len() < before })
            }
            "timerStart" => v(&self.timer_start(a.get("minutes").unwrap_or(&Value::Null), s(a, "label"), now)?),
            "timerStop" => json!({ "ok": self.timer.take().is_some() }),
            "run" => { let p = self.run(&req.data_as::<RunArgs>().ok_or("bad arguments for run")?, req, &mut rng); v(p) }
            other => return Err(format!("the workstation has no method {other}")),
        })
    }

    // ---- the shell -----------------------------------------------------------------

    pub fn run(&mut self, args: &RunArgs, req: &Request, rng: &mut Rng) -> Printed {
        let raw = line(&args.line, 500);
        let cmd = raw.split_whitespace().next().unwrap_or("").to_string();
        let arg = raw[cmd.len()..].trim().to_string();
        let words: Vec<&str> = arg.split_whitespace().collect();
        if cmd.is_empty() { return Printed::default(); }
        match self.command(&cmd.to_lowercase(), &arg, &words, args, req, rng) {
            Some(Ok(p)) => p,
            Some(Err(e)) => Printed { out: format!("{cmd}: {e}"), ..Default::default() },
            None => Printed { out: format!("{cmd}: command not found (try help)"), ..Default::default() },
        }
    }

    fn command(&mut self, cmd: &str, arg: &str, words: &[&str], args: &RunArgs, req: &Request, rng: &mut Rng) -> Option<R<Printed>> {
        let now = req.now as i64;
        let first = words.first().copied().unwrap_or("");
        Some(match cmd {
            "help" => out(HELP),
            "whoami" => {
                let h = req.actor.handle.as_deref().filter(|h| !h.is_empty()).map(|h| format!(" (@{h})")).unwrap_or_default();
                out(format!("{}{h}\n{}", req.actor.name, args.key))
            }
            "date" => out(utc(now)),
            "echo" => out(arg),
            "clear" => Ok(Printed { open: Some("clear".into()), ..Default::default() }),
            "who" => {
                let o = &args.office.online;
                if o.is_empty() { return Some(out("Nobody is in.")); }
                out(o.iter().map(|p| {
                    let note = if p.note.is_empty() { String::new() } else { format!("  “{}”", p.note) };
                    format!("{} {} {} {}{note}", pad(&p.name, 20), pad(&p.kind, 6), pad(&p.zone, 16), p.status)
                }).collect::<Vec<_>>().join("\n"))
            }
            "desks" => {
                let d = &args.office.desks;
                if d.is_empty() { return Some(out("No desks claimed.")); }
                out(d.iter().map(|d| format!("{} {} {}  ({})", pad(&d.id, 12), pad(&d.name, 20), d.goal, ago(now - d.seen))).collect::<Vec<_>>().join("\n"))
            }
            "rooms" => {
                let day_end = now.div_euclid(86_400_000) * 86_400_000 + 86_400_000 - 1;
                let until = match first { "all" => i64::MAX, "today" => day_end, _ => now + 86_400_000 };
                let list: Vec<_> = args.office.bookings.iter().filter(|b| b.end > now && b.start < until).collect();
                if list.is_empty() { return Some(out("No bookings coming up. Book a room from its door or the Calendar app.")); }
                out(list.iter().map(|b| format!("{} {}–{}\t{} {}  ({})", if b.start <= now { '▶' } else { ' ' }, stamp_ms(b.start), stamp_ms(b.end), pad(&b.room, 14), b.title, b.name))
                    .collect::<Vec<_>>().join("\n"))
            }
            "todo" => {
                let sub = first.to_lowercase();
                let rest = arg[first.len()..].trim();
                let done = match sub.as_str() {
                    "add" => self.todo_add(rest, now, rng).map(|_| ()),
                    "done" | "undo" => pick(&self.todos, rest).map(|t| t.id.clone())
                        .and_then(|id| self.todo_set(&json!({ "id": id, "done": sub == "done" })).map(|_| ())),
                    "rm" => pick(&self.todos, rest).map(|t| t.id.clone()).map(|id| { self.todo_remove(&id); }),
                    "clear" => { self.todo_remove("done"); Ok(()) }
                    "" => Ok(()),
                    s => Err(format!("unknown \"{s}\" (add, done, undo, rm, clear)")),
                };
                if let Err(e) = done { return Some(Err(e)); }
                if self.todos.is_empty() { return Some(out("Nothing to do. todo add <text> to add something.")); }
                out(self.todos.iter().enumerate().map(|(i, t)| format!("{}[{}] {}", pad(&format!("{}.", i + 1), 4), if t.done { 'x' } else { ' ' }, t.text)).collect::<Vec<_>>().join("\n"))
            }
            "notes" => {
                let list = self.sorted_notes();
                if list.is_empty() { return Some(out("No notes yet. jot <text>, or open notes.")); }
                out(list.iter().enumerate().map(|(i, n)| format!("{}{} {} chars, {}", pad(&format!("{}.", i + 1), 4), pad(&n.title, 40), n.text.encode_utf16().count(), ago(now - n.updated)))
                    .collect::<Vec<_>>().join("\n"))
            }
            "cat" => pick(&self.sorted_notes(), first).map(|n| Printed { out: format!("# {}\n{}", n.title, n.text), ..Default::default() }),
            "jot" => {
                if arg.is_empty() { return Some(Err("jot <text>".into())); }
                let n = self.notes.iter().find(|n| n.title == "Scratch").cloned();
                let text = format!("{}{} {arg}", n.as_ref().map(|n| format!("{}\n", n.text)).unwrap_or_default(), stamp_ms(now));
                let id = n.map(|n| n.id).unwrap_or_default();
                self.note_save(&json!({ "id": id, "title": "Scratch", "text": text }), now, rng).map(|_| Printed { out: "Jotted down in Scratch.".into(), ..Default::default() })
            }
            "timer" => match first {
                "stop" => { self.timer = None; out("Timer stopped.") }
                "" => out(match &self.timer {
                    Some(t) => format!("{}: {} min left", t.label, ((t.ends_at - now) as f64 / MIN as f64).ceil().max(0.0)),
                    None => "No timer. timer <minutes> [label]".into(),
                }),
                m => self.timer_start(&Value::String(m.into()), &words[1..].join(" "), now)
                    .map(|t| Printed { out: format!("{}: {} min, rings at {}.", t.label, t.minutes, stamp_ms(t.ends_at)), ..Default::default() }),
            },
            "links" => {
                if self.links.is_empty() { return Some(out("No bookmarks. bookmark <url> [title]")); }
                out(self.links.iter().enumerate().map(|(i, l)| format!("{}{} {}", pad(&format!("{}.", i + 1), 4), pad(&l.title, 32), l.url)).collect::<Vec<_>>().join("\n"))
            }
            "bookmark" => {
                let words = if words.is_empty() { &[""][..] } else { words };
                self.link_add(words[0], &words[1..].join(" "), rng).map(|l| Printed { out: format!("Bookmarked {}.", l.title), ..Default::default() })
            }
            "open" => {
                let what = first.to_lowercase();
                if what.is_empty() { return Some(Err("open <app|url>".into())); }
                if args.apps.iter().any(|a| *a == what) {
                    Ok(Printed { out: format!("Opening {what}…"), open: Some(what), url: None })
                } else {
                    match clean_url(first) {
                        Some(url) => Ok(Printed { out: format!("Opening {url}…"), open: Some("browser".into()), url: Some(url) }),
                        None => Err(format!("no app or page \"{first}\"")),
                    }
                }
            }
            _ => return None,
        })
    }
}

const HELP: &str = "Office shell. Commands:
  who                     who is in, and where
  desks                   claimed desks and their goals
  rooms [today|all]       meeting room bookings
  todo                    your todo list
  todo add <text>         add one        todo done <n>   tick #n
  todo rm <n>             remove #n      todo clear      drop finished ones
  notes                   your notes     cat <n>         print note #n
  jot <text>              add a line to your \"Scratch\" note
  timer <min> [label]     focus timer    timer stop
  links                   bookmarks      bookmark <url> [title]
  open <app|url>          open an app (notes, todo, browser, calendar, timer…) or a page
  whoami, date, echo, clear";

/// Item #n (1-based) of a numbered list.
fn pick<'a, T>(list: &'a [T], n: &str) -> R<&'a T> {
    let i = number(&Value::String(n.into())) - 1.0;
    if i.fract() == 0.0 && i >= 0.0 && (i as usize) < list.len() { Ok(&list[i as usize]) } else { Err(format!("no #{n} (see the numbers in the list)")) }
}

fn v(x: impl Serialize) -> Value { serde_json::to_value(x).unwrap_or(Value::Null) }

impl Plugin for Workstation {
    const MANIFEST: Manifest = Manifest::new("Workstation")
        .doc("The program on the desk computers: your notes, todo list, bookmarks, a focus timer and the office shell. The office runs it for whoever sits at a desk; placed on the floor it only says so.")
        .prompt("Look at the screen")
        .emoji("🖥️");

    fn interact(&mut self, req: &Request) -> Response {
        let res = match req.action.as_str() {
            // Someone found a copy on the floor: it's the desks' program.
            "use" => Response::new().ui(Ui::new("🖥️ Workstation").text("This is the program the desk computers run. Sit at any desk and press **E** to open your own: notes, todos, bookmarks, a focus timer and the office shell.")),
            "tick" => match self.ring(req.now as i64) { Some(t) => Response::new().toast(t), None => Response::new() },
            _ => match self.call(req) { Ok(v) => Response::new().reply(v), Err(e) => Response::fail(e) },
        };
        // Wake the office when the timer is due to ring.
        match &self.timer { Some(t) => res.wake_at(t.ends_at as f64), None => res }
    }
}

export_plugin!(Workstation);

#[cfg(test)]
mod tests;
