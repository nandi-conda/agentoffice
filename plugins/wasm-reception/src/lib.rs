//! The reception desk in the Lobby, as a WASM plugin built with the
//! agentoffice-plugin crate. Its sign reads ☕ coffees · 🍅 pomodoros · 👋
//! waves: the cups and rounds come from the coffee machine and the pomodoro,
//! the waves are counted here. Every wave or knock anyone sends is the
//! office's `wave` event (server/office.js); people can't send that one.
//!
//! Pressing E rings the bell on the desk, at most once every few seconds.
//!
//! Build with `just plugin-build reception`, test with `just plugin-test reception`.

use agentoffice_plugin::prelude::*;

/// How long the bell rings before it can be rung again.
pub const BELL_MS: f64 = 10_000.0;

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Reception {
    /// Waves and knocks, ever (the World counted them before the desk did).
    pub waves: u32,
    /// Times the bell was rung, and when it last was.
    pub rings: u32,
    pub rang_at: f64,
}

impl Plugin for Reception {
    const MANIFEST: Manifest = Manifest::new("Reception desk")
        .doc("The front desk in the Lobby. Its sign counts the office's waves; ring the bell to say you're here.")
        .prompt("Ring the bell")
        .emoji("🛎️")
        .glow("#fbbf24")
        .actions(&[Action::new("ring", "Ring the bell on the desk (what pressing E does)")]);

    fn on_use(&mut self, req: &Request) -> Response { self.ring(req) }

    fn on_action(&mut self, req: &Request) -> Response {
        if req.office_event("wave").is_some() {
            self.waves += 1;
            return Response::new();
        }
        match req.action.as_str() {
            "ring" => self.ring(req),
            "wave" => Response::error("Waves are counted when you wave at someone."),
            other => Response::error(format!("The reception desk doesn't know how to {other}")),
        }
    }

    fn display(&self) -> Option<Display> {
        Some(Display::default().data(json!({ "waves": self.waves })))
    }
}

impl Reception {
    fn ring(&mut self, req: &Request) -> Response {
        if req.now - self.rang_at < BELL_MS { return Response::new().toast("🛎️ The bell is still ringing."); }
        self.rings += 1;
        self.rang_at = req.now;
        let who = req.actor.name.split_whitespace().next().unwrap_or("someone");
        Response::new().say(format!("🛎️ Ding! {who} rings the bell at reception.")).toast("🛎️ Ding! Everyone in the Lobby hears it.")
    }
}

export_plugin!(Reception);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn counts_the_offices_waves() {
        let mut o = TestOffice::<Reception>::new();
        o.office_call("Ada", "wave", "wave", json!({ "kind": "wave" }));
        o.office_call("Grace", "wave", "wave", json!({ "kind": "knock" }));
        assert_eq!(o.state().waves, 2);
        assert_eq!(o.display().unwrap().data, Some(json!({ "waves": 2 })));
        o.assert_clean();
    }

    #[test]
    fn people_cant_wave_at_the_desk() {
        let mut o = TestOffice::<Reception>::new();
        assert!(o.act("Ada", "wave").toast.is_some());
        assert_eq!(o.state().waves, 0);
    }

    #[test]
    fn the_bell_rings_then_rests() {
        let mut o = TestOffice::<Reception>::new();
        let r = o.use_as("Ada Lovelace");
        assert!(r.ui.is_none(), "no panel: pressing E just rings");
        assert_eq!(r.say.as_deref(), Some("🛎️ Ding! Ada rings the bell at reception."));
        assert!(o.act("Grace", "ring").say.is_none(), "still ringing");
        o.advance(BELL_MS);
        assert!(o.act("Grace", "ring").say.is_some());
        assert_eq!(o.state().rings, 2);
    }

    #[test]
    fn old_state_loads() {
        // What the office adopts from the World's own count.
        let r: Reception = serde_json::from_str(r#"{"waves":9}"#).unwrap();
        assert_eq!(r.waves, 9);
    }
}
