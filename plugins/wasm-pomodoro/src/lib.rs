//! The shared pomodoro timer in the Deep Work Den, as a WASM plugin built
//! with the agentoffice-plugin crate. One timer for everyone in the den:
//! focus, break, focus… until someone stops it. Phases turn over on the
//! office's wake-up call (`wake_at`), and the phase goes out with the display
//! (`display.data`) so every browser draws the clock and the den's HUD.
//!
//! Build with `just plugin-build pomodoro`, test with `just plugin-test pomodoro`.

use agentoffice_plugin::prelude::*;

const MIN: f64 = 60_000.0;

/// Field names as the pomodoro entity kept them, so its state loads as is.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Pomodoro {
    /// `idle`, `focus` or `break`.
    pub phase: String,
    /// Epoch ms the phase ends (0 when idle).
    pub ends_at: f64,
    pub round: u32,
    pub focus_min: u32,
    pub break_min: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_by: Option<String>,
    /// Focus sessions finished, ever.
    pub count: u32,
}

impl Default for Pomodoro {
    fn default() -> Self {
        Pomodoro { phase: "idle".into(), ends_at: 0.0, round: 0, focus_min: 25, break_min: 5, started_by: None, count: 0 }
    }
}

impl Pomodoro {
    fn running(&self) -> bool { self.phase == "focus" || self.phase == "break" }

    fn begin(&mut self, phase: &str, from: f64) {
        self.phase = phase.into();
        self.ends_at = from + f64::from(if phase == "focus" { self.focus_min } else { self.break_min }) * MIN;
    }

    // Turn over every phase that has ended by `now` (normally one, more if
    // the office slept through a wake-up).
    fn catch_up(&mut self, now: f64) {
        for _ in 0..1000 {
            if !self.running() || now < self.ends_at { return; }
            let from = self.ends_at;
            if self.phase == "focus" { self.count += 1; self.begin("break", from); } else { self.round += 1; self.begin("focus", from); }
        }
    }

    fn wake(&self, res: Response) -> Response {
        if self.running() { res.wake_at(self.ends_at) } else { res }
    }
}

fn minutes(n: f64) -> String {
    let m = (n / MIN).ceil().max(1.0) as u64;
    format!("{m} min")
}

impl Plugin for Pomodoro {
    const MANIFEST: Manifest = Manifest::new("Pomodoro timer")
        .doc("A shared focus timer for everyone in the Deep Work Den: focus, break, focus… until someone stops it.")
        .prompt("Use the focus timer")
        .emoji("🍅")
        .glow("#ef4444")
        .look(Look::Pomodoro)
        .actions(&[
            Action::new("start", "Start focusing: 25 minutes, then a 5 minute break, and round again"),
            Action::new("start:<focus>:<break>", "Start with your own lengths in minutes (focus 1–90, break 1–30), e.g. start:50:10"),
            Action::new("stop", "Stop the timer for everyone"),
        ]);

    fn on_use(&mut self, req: &Request) -> Response {
        self.catch_up(req.now);
        self.wake(Response::new())
    }

    fn on_tick(&mut self, req: &Request) -> Response {
        self.catch_up(req.now);
        self.wake(Response::new())
    }

    fn on_action(&mut self, req: &Request) -> Response {
        self.catch_up(req.now);
        if req.is("stop") {
            if !self.running() { return Response::error("The timer isn't running."); }
            self.phase = "idle".into();
            self.ends_at = 0.0;
            self.round = 0;
            return Response::new();
        }
        let lengths = if req.is("start") { Some((25, 5)) } else {
            req.arg("start").and_then(|a| a.split_once(':')).and_then(|(f, b)| Some((f.parse::<u32>().ok()?, b.parse::<u32>().ok()?)))
        };
        let Some((focus, rest)) = lengths else { return Response::error(format!("The timer doesn't know how to {}", req.action)) };
        self.focus_min = focus.clamp(1, 90);
        self.break_min = rest.clamp(1, 30);
        self.round = 1;
        self.started_by = Some(req.actor.name.clone());
        self.begin("focus", req.now);
        self.wake(Response::new())
    }

    fn panel(&self, req: &Request) -> Option<Ui> {
        let ui = Ui::new("🍅 Focus timer");
        Some(if self.running() {
            let what = if self.phase == "focus" { "**Focus**" } else { "**Break**" };
            let by = self.started_by.as_deref().map(|n| format!(" Started by {n}.")).unwrap_or_default();
            ui.text(format!("{what}, round {}: {} left ({} / {}).{by}\nIt's shared: stopping it stops it for everyone in the den.",
                self.round, minutes(self.ends_at - req.now), self.focus_min, self.break_min))
                .button("Stop for everyone", "stop")
        } else {
            ui.text(format!("One timer for everyone in the Deep Work Den: focus, then a break, round after round. {} focus session{} so far.",
                self.count, if self.count == 1 { "" } else { "s" }))
                .primary("Focus 25 / 5", "start")
                .button("Focus 50 / 10", "start:50:10")
                .button("Focus 15 / 3", "start:15:3")
        })
    }

    fn display(&self) -> Option<Display> {
        let glow = match self.phase.as_str() { "focus" => "#ef4444", "break" => "#22c55e", _ => "#94a3b8" };
        Some(Display::default().glow(glow).data(self))
    }
}

export_plugin!(Pomodoro);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn focus_break_focus() {
        let mut o = TestOffice::<Pomodoro>::new();
        o.act("Ada", "start");
        let t = o.state();
        assert_eq!((t.phase.as_str(), t.round, t.focus_min, t.break_min), ("focus", 1, 25, 5));
        assert_eq!(t.started_by.as_deref(), Some("Ada"));
        assert_eq!(o.wake_at(), Some(t.ends_at));
        assert_eq!(t.ends_at, o.now + 25.0 * MIN);

        o.tick();
        assert_eq!(o.state().phase, "break");
        assert_eq!(o.state().count, 1);
        o.tick();
        assert_eq!((o.state().phase.as_str(), o.state().round), ("focus", 2));
        assert_eq!(o.display().unwrap().data.as_ref().unwrap()["phase"], "focus");

        o.act("Grace", "stop");
        assert_eq!(o.state().phase, "idle");
        assert_eq!(o.state().count, 1, "finished sessions stay counted");
        o.assert_clean();
    }

    #[test]
    fn own_lengths_clamped() {
        let mut o = TestOffice::<Pomodoro>::new();
        o.act("Ada", "start:500:0");
        assert_eq!((o.state().focus_min, o.state().break_min), (90, 1));
        assert!(o.act("Ada", "start:x:5").toast.is_some());
    }

    #[test]
    fn a_late_wake_up_catches_up() {
        let mut o = TestOffice::<Pomodoro>::new();
        o.act("Ada", "start:1:1");
        o.advance(3.5 * MIN);
        o.use_as("Ada");
        let t = o.state();
        // focus (1) → break (2) → focus (3) → break, finished focus twice.
        assert_eq!((t.phase.as_str(), t.count, t.round), ("break", 2, 2));
        assert!(o.wake_at().unwrap() > o.now);
    }

    #[test]
    fn a_stale_wake_up_does_nothing() {
        let mut o = TestOffice::<Pomodoro>::new();
        o.act("Ada", "start");
        o.act("Ada", "stop");
        o.tick();
        assert_eq!(o.state().phase, "idle");
        assert_eq!(o.state().count, 0);
    }

    #[test]
    fn panel_shows_whats_running() {
        let mut o = TestOffice::<Pomodoro>::new();
        assert!(o.use_as("Ada").ui.unwrap().buttons.iter().any(|b| b.action == "start:50:10"));
        let ui = o.act("Ada", "start").ui.unwrap();
        assert!(ui.text.contains("**Focus**, round 1: 25 min left"));
        assert_eq!(ui.buttons[0].action, "stop");
        o.assert_clean();
    }

    #[test]
    fn old_state_loads() {
        // The pomodoro:focus entity's state, as the office hands it over.
        let p: Pomodoro = serde_json::from_str(r#"{"phase":"focus","endsAt":1761700060000,"round":2,"focusMin":25,"breakMin":5,"startedBy":"ada","count":7}"#).unwrap();
        assert_eq!((p.round, p.count, p.ends_at), (2, 7, 1_761_700_060_000.0));
        let idle: Pomodoro = serde_json::from_str(r#"{"count":3}"#).unwrap();
        assert_eq!((idle.phase.as_str(), idle.focus_min), ("idle", 25));
    }
}
