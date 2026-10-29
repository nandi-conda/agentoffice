//! The magic 8-ball in the Lounge (and the 🎱 app on the workstations), as a
//! WASM plugin built with the agentoffice-plugin crate. Ask a yes-or-no
//! question; the answer comes from the office's random seed, since WASM has
//! no randomness of its own.
//!
//! Build with `just plugin-build eightball`, test with `just plugin-test eightball`.

use agentoffice_plugin::prelude::*;

pub const ANSWERS: [&str; 18] = [
    "It is certain.", "Without a doubt.", "Yes, definitely.", "Ship it.", "Most likely.", "Outlook good.",
    "Signs point to yes.", "Reply hazy, try again.", "Ask again after standup.", "Better not tell you now.",
    "Cannot predict now.", "Concentrate and ask again.", "Don't count on it.", "My reply is no.",
    "Outlook not so good.", "Very doubtful.", "Only if the tests pass.", "Put it in the backlog.",
];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Shake { pub q: String, pub a: String }

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct EightBall {
    pub asked: u32,
    pub last: Option<Shake>,
}

fn ask_ui(text: impl Into<String>) -> Ui {
    Ui::new("🎱 Magic 8-ball").text(text)
        .input(Input::new("ask").placeholder("Will the deploy go smoothly?").button("Shake").max_length(140))
}

impl Plugin for EightBall {
    const MANIFEST: Manifest = Manifest::new("Magic 8-ball")
        .doc("Ask a yes-or-no question and shake it. Everyone nearby hears the answer.")
        .prompt("Ask the magic 8-ball")
        .emoji("🎱")
        .glow("#6366f1")
        .look(Look::EightBall)
        .actions(&[Action::new("ask", "Ask it a question").input("A yes-or-no question (≤ 140 characters)")]);

    fn on_action(&mut self, req: &Request) -> Response {
        if !req.is("ask") { return Response::error(format!("The 8-ball doesn't know how to {}", req.action)); }
        let q = req.text_clipped(140);
        if q.is_empty() { return Response::error("Ask it something first."); }
        let a = *req.pick(&ANSWERS);
        self.asked += 1;
        let who = req.actor.name.split_whitespace().next().unwrap_or("someone");
        let r = Response::new().say(format!("🎱 {who} asked “{q}” … {a}")).ui(ask_ui(format!("“{q}”\n\n**{a}**")));
        self.last = Some(Shake { q, a: a.into() });
        r
    }

    fn panel(&self, _req: &Request) -> Option<Ui> {
        Some(ask_ui("Ask a yes-or-no question, then shake."))
    }
}

export_plugin!(EightBall);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn needs_a_question_then_answers() {
        let mut o = TestOffice::<EightBall>::new();
        assert_eq!(o.use_as("Ada").ui.unwrap().input.unwrap().action, "ask");
        assert_eq!(o.type_in("Ada", "ask", "   ").toast.as_deref(), Some("Ask it something first."));
        let r = o.type_in("Ada Lovelace", "ask", "Ship it?");
        assert!(r.say.unwrap().starts_with("🎱 Ada asked “Ship it?” … "));
        let last = o.state().last.unwrap();
        assert!(ANSWERS.contains(&last.a.as_str()));
        assert_eq!(o.state().asked, 1);
        o.assert_clean();
    }

    #[test]
    fn the_seed_picks_the_answer() {
        let mut seen = std::collections::HashSet::new();
        let mut o = TestOffice::<EightBall>::new();
        for _ in 0..60 { o.type_in("Ada", "ask", "Again?"); seen.insert(o.state().last.unwrap().a); }
        assert!(seen.len() > 5, "different seeds, different answers");
    }
}
