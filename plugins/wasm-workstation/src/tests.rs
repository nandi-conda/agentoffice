use super::*;
use agentoffice_plugin::handle_json;

const T0: f64 = 1_761_700_000_000.0;

// One call the way the Workstation entity makes it: returns the answer and
// keeps the state.
struct Desk { state: Value, now: f64, seed: u64 }

impl Desk {
    fn new() -> Self { Desk { state: Value::Null, now: T0, seed: 7 } }
    fn call(&mut self, action: &str, args: Value) -> Value {
        self.seed += 1;
        let req = json!({
            "object": { "id": "ws-desk", "kind": "workstation", "name": "Workstation" },
            "actor": { "id": "p1", "did": "did:plc:ada", "handle": "ada.test", "name": "ada", "kind": "human" },
            "action": action, "state": self.state, "now": self.now, "seed": self.seed, "data": args,
        });
        let out: Value = serde_json::from_slice(&handle_json::<Workstation>(&serde_json::to_vec(&req).unwrap())).unwrap();
        if let Some(s) = out.get("state") { self.state = s.clone(); }
        out
    }
    fn ok(&mut self, action: &str, args: Value) -> Value {
        let out = self.call(action, args);
        assert!(out.get("error").is_none(), "{action}: {out}");
        out["reply"].clone()
    }
    fn err(&mut self, action: &str, args: Value) -> String {
        self.call(action, args)["error"].as_str().expect("an error").to_string()
    }
    fn sh(&mut self, line: &str) -> Value {
        self.ok("run", json!({ "line": line, "key": "did:plc:ada", "apps": ["notes", "todo", "browser", "oracle"],
            "office": { "online": [{ "name": "ada", "kind": "human", "zone": "Lobby", "status": "", "note": "shipping" }],
                        "desks": [{ "id": "desk-1", "name": "ada", "goal": "ship it", "seen": T0 as i64 - 120_000 }],
                        "bookings": [{ "start": T0 as i64 + 3_600_000, "end": T0 as i64 + 7_200_000, "room": "Boardroom", "title": "Retro", "name": "bob" }] } }))
    }
    fn out(&mut self, line: &str) -> String { self.sh(line)["out"].as_str().unwrap().to_string() }
}

#[test]
fn notes_todos_and_links() {
    let mut d = Desk::new();
    let n = d.ok("noteSave", json!({ "text": "\n  Plan\n- ship it" }));
    assert_eq!(n["title"], "Plan", "the first line names it");
    let id = n["id"].as_str().unwrap().to_string();
    assert_eq!(id.len(), 8);
    d.now += 1000.0;
    let n2 = d.ok("noteSave", json!({ "id": id, "title": "Renamed", "text": "x" }));
    assert_eq!((n2["title"].as_str(), n2["updated"].as_i64()), (Some("Renamed"), Some(T0 as i64 + 1000)));
    assert_eq!(d.err("noteSave", json!({ "id": "nope", "text": "x" })), "no such note");
    assert_eq!(d.ok("noteDelete", json!({ "id": id })), json!({ "ok": true }));

    assert_eq!(d.err("todoAdd", json!({ "text": "  " })), "say what to do");
    let t = d.ok("todoAdd", json!({ "text": "write\ntests" }));
    assert_eq!(t["text"], "write tests");
    d.ok("todoSet", json!({ "id": t["id"], "done": true }));
    assert_eq!(d.ok("todoRemove", json!({ "id": "done" })), json!({ "removed": 1 }));

    let l = d.ok("linkAdd", json!({ "url": "Example.com" }));
    assert_eq!((l["url"].as_str(), l["title"].as_str()), (Some("https://example.com/"), Some("example.com/")));
    assert!(d.err("linkAdd", json!({ "url": "javascript:alert(1)" })).contains("only http(s)"));
    let desk = d.ok("desktop", Value::Null);
    assert_eq!(desk["links"].as_array().unwrap().len(), 1);
    assert_eq!(desk["timer"], Value::Null);
}

#[test]
fn limits_hold() {
    let mut d = Desk::new();
    for i in 0..NOTES { d.ok("noteSave", json!({ "text": format!("note {i}") })); }
    assert_eq!(d.err("noteSave", json!({ "text": "one more" })), "30 notes at most: delete one first");
    let n = d.ok("noteSave", json!({ "id": d.state["notes"][0]["id"], "text": "y".repeat(NOTE_TEXT + 50) }));
    assert_eq!(n["text"].as_str().unwrap().len(), NOTE_TEXT);
    // A big workstation still fits in one answer the office takes from its own modules.
    for i in 0..NOTES { let id = d.state["notes"][i]["id"].clone(); d.ok("noteSave", json!({ "id": id, "text": "z".repeat(NOTE_TEXT) })); }
    assert!(d.state.to_string().len() > 600_000);
}

#[test]
fn a_failed_call_keeps_the_state() {
    let mut d = Desk::new();
    d.ok("todoAdd", json!({ "text": "a" }));
    let out = d.call("todoSet", json!({ "id": "nope", "done": true }));
    assert_eq!(out["error"], "no such todo");
    assert!(out.get("state").is_none());
    assert!(d.call("format", Value::Null)["error"].as_str().unwrap().contains("no method format"));
}

#[test]
fn the_timer_rings_on_the_wake_up_call() {
    let mut d = Desk::new();
    assert_eq!(d.err("timerStart", json!({ "minutes": 0 })), "1 to 240 minutes");
    let out = d.call("timerStart", json!({ "minutes": "25", "label": "Deep work" }));
    let ends = T0 as i64 + 25 * 60_000;
    assert_eq!(out["reply"], json!({ "label": "Deep work", "minutes": 25, "endsAt": ends }));
    assert_eq!(out["wakeAt"].as_f64(), Some(ends as f64), "the office wakes it when it's due");
    // Woken early: nothing yet.
    d.now += 60_000.0;
    let early = d.call("tick", Value::Null);
    assert!(early.get("toast").is_none());
    assert_eq!(early["wakeAt"].as_f64(), Some(ends as f64));
    d.now = ends as f64;
    let rang = d.call("tick", Value::Null);
    assert_eq!(rang["toast"], "⏰ Deep work: your 25-minute timer is up.");
    assert!(rang.get("wakeAt").is_none());
    assert_eq!(d.ok("desktop", Value::Null)["timer"], Value::Null);
    assert_eq!(d.ok("timerStop", Value::Null), json!({ "ok": false }));
}

#[test]
fn the_shell() {
    let mut d = Desk::new();
    assert!(d.out("help").contains("todo add"));
    assert!(d.out("who").contains("ada") && d.out("who").contains("Lobby") && d.out("who").contains("“shipping”"));
    assert!(d.out("desks").contains("ship it  (2 min ago)"));
    assert!(d.out("rooms").contains(&format!("<t:{}>–<t:{}>\tBoardroom      Retro  (bob)", T0 as i64 + 3_600_000, T0 as i64 + 7_200_000)));
    assert_eq!(d.out("whoami"), "ada (@ada.test)\ndid:plc:ada");
    assert_eq!(d.out("echo  hi  there"), "hi  there");
    assert!(d.out("todo add buy milk").contains("1.  [ ] buy milk"));
    assert!(d.out("todo done 1").contains("[x] buy milk"));
    assert_eq!(d.out("todo done 9"), "todo: no #9 (see the numbers in the list)");
    assert_eq!(d.out("todo frob"), "todo: unknown \"frob\" (add, done, undo, rm, clear)");
    assert_eq!(d.out("todo clear"), "Nothing to do. todo add <text> to add something.");
    d.out("jot remember the standup");
    d.now += 1000.0;
    d.out("jot and the retro");
    let cat = d.out("cat 1");
    assert!(cat.starts_with("# Scratch\n<t:") && cat.contains("remember the standup\n<t:") && cat.ends_with("and the retro"), "{cat}");
    assert_eq!(d.state["notes"].as_array().unwrap().len(), 1, "one Scratch note");
    assert_eq!(d.sh("open notes"), json!({ "out": "Opening notes…", "open": "notes" }));
    assert_eq!(d.sh("open example.com")["url"], "https://example.com/");
    assert_eq!(d.out("open ftp://x"), "open: no app or page \"ftp://x\"");
    assert_eq!(d.out("rm -rf /"), "rm: command not found (try help)");
    assert_eq!(d.sh("clear"), json!({ "out": "", "open": "clear" }));
    assert_eq!(d.sh(""), json!({ "out": "" }));
    assert!(d.out("timer 10 tea").starts_with("tea: 10 min, rings at <t:"));
    assert_eq!(d.out("timer"), "tea: 10 min left");
    assert_eq!(d.out("timer stop"), "Timer stopped.");
    assert_eq!(d.out("bookmark docs.rs Rust docs"), "Bookmarked Rust docs.");
    assert!(d.out("links").contains("https://docs.rs/"));
    assert_eq!(d.out("bookmark"), "bookmark: only http(s) links or office paths like /docs");
}

#[test]
fn urls() {
    assert_eq!(clean_url("example.com/a").as_deref(), Some("https://example.com/a"));
    assert_eq!(clean_url("HTTP://Example.COM").as_deref(), Some("http://example.com/"));
    assert_eq!(clean_url("/docs/").as_deref(), Some("/docs/"));
    assert_eq!(clean_url("example.com/a b?q=1#x").as_deref(), Some("https://example.com/a%20b?q=1#x"));
    for bad in ["", "javascript:alert(1)", "data:text/html,hi", "https://", "https://exa mple.com", "mailto:a@b.c"] {
        assert_eq!(clean_url(bad), None, "{bad}");
    }
}

#[test]
fn dates_print_like_javascript() {
    assert_eq!(utc(0), "Thu, 01 Jan 1970 00:00:00 GMT");
    assert_eq!(utc(1_793_292_910_000), "Thu, 29 Oct 2026 16:55:10 GMT");
    assert_eq!(utc(951_782_400_000), "Tue, 29 Feb 2000 00:00:00 GMT");
}

#[test]
fn saved_js_state_loads() {
    let mut d = Desk::new();
    d.state = json!({ "notes": [{ "id": "a1b2c3d4", "title": "Old", "text": "kept", "updated": 5 }], "todos": [{ "id": "t1", "text": "x", "done": true, "at": 1 }],
                      "links": [], "timer": { "label": "Focus", "minutes": 5, "endsAt": 9 } });
    let desk = d.ok("desktop", Value::Null);
    assert_eq!(desk["notes"][0]["text"], "kept");
    assert_eq!(desk["timer"]["endsAt"], 9);
}
