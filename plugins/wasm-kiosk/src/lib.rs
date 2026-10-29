//! The help kiosk in the Lobby (and the 💁 app on the workstations), as a
//! WASM plugin built with the agentoffice-plugin crate.
//!
//! The sandbox has no network, so the kiosk asks the office: it answers a
//! question with [`Response::ask`], the office runs its language model
//! (Workers AI on Cloudflare) and calls straight back with the reply. When
//! there's no model, or it fails, the kiosk answers from [`HELP`], so it
//! never just breaks.
//!
//! To change what it knows or how it talks, edit [`PERSONA`] and [`HELP`],
//! then `just plugin-build kiosk`. The model is the office's choice
//! (AI_MODEL, server/plugins.js).

use agentoffice_plugin::prelude::*;

pub const PERSONA: &str = "You are the friendly help kiosk in a virtual coworking office. Answer in at most two short sentences. If you don't know, say so and suggest asking someone nearby.";

/// Facts for the model, and the offline answers (by keyword).
pub const HELP: [(&str, &str); 8] = [
    ("rooms", "The office has the Deep Work Den, Phone Booths, Lobby, Open Office, Boardroom, Huddle Room, Kitchen and Lounge."),
    ("book", "Walk up to a meeting room door and press E to book it, or use the Rooms button."),
    ("desk", "Walk up to any free desk in the Open Office and claim it. Your name stays on it between visits."),
    ("coffee", "The coffee machine is in the Kitchen. Grab a mug and people nearby will know you're up for a chat."),
    ("focus", "The Deep Work Den has a shared pomodoro timer. Chat there only reaches people right next to you."),
    ("arcade", "Byte Snake lives in the Lounge, top right. High scores go on the board."),
    ("snack", "The vending machine in the Kitchen has free snacks while stock lasts."),
    ("music", "The jukebox in the Lounge plays whatever people queue on it."),
];
pub const OFFLINE: &str = "I'm running in offline mode, so I only know the basics: try asking about rooms, booking, desks, coffee, focus, snacks, music or the arcade.";
pub const MAX_QUESTION: usize = 300;

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Kiosk {
    pub questions: u32,
}

fn ui(text: impl Into<String>) -> Ui {
    Ui::new("🤖 Help kiosk").text(text)
        .input(Input::new("ask").placeholder("Ask the office anything…").button("Ask").max_length(MAX_QUESTION as u32))
}

/// What the kiosk says without a model.
pub fn offline_answer(q: &str) -> &'static str {
    let q = q.to_lowercase();
    HELP.iter().find(|(k, _)| q.contains(k)).map_or(OFFLINE, |(_, a)| a)
}

fn system(req: &Request) -> String {
    let zone = req.object.zone.as_deref().unwrap_or("office");
    let nearby: Vec<&str> = req.nearby.iter().map(|p| p.name.as_str()).collect();
    let nearby = if nearby.is_empty() { "nobody".to_string() } else { nearby.join(", ") };
    let facts: Vec<&str> = HELP.iter().map(|(_, a)| *a).collect();
    format!("{PERSONA} You stand in the {zone}. People near you: {nearby}. Facts: {}", facts.join(" "))
}

impl Plugin for Kiosk {
    const MANIFEST: Manifest = Manifest::new("Help kiosk")
        .doc("Ask where things are or how the office works. It answers with the office's language model, or from what it knows when there's none.")
        .prompt("Ask the help kiosk")
        .emoji("🤖")
        .glow("#22d3ee")
        .look(Look::Kiosk)
        .actions(&[Action::new("ask", "Ask it something").input("A question (≤ 300 characters)")]);

    fn on_action(&mut self, req: &Request) -> Response {
        if !req.is("ask") { return Response::error(format!("The kiosk doesn't know how to {}", req.action)); }
        let q = req.text_clipped(MAX_QUESTION);
        if q.is_empty() { return Response::new().ui(ui("Type a question first.")); }
        // First call: ask the office's model. It calls back with req.reply.
        let Some(reply) = &req.reply else {
            self.questions += 1;
            return Response::new().ask(Ask::new(q.clone()).system(system(req)).max_tokens(200));
        };
        let answer = reply.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or_else(|| offline_answer(&q));
        // Only the asker sees why it's offline; everyone nearby hears the answer.
        let why = reply.error.as_deref().map(|e| format!("\n\n(offline: {})", e.chars().take(300).collect::<String>())).unwrap_or_default();
        Response::new().say(format!("🤖 {answer}")).ui(ui(format!("**You:** {q}\n\n**Kiosk:** {answer}{why}")))
    }

    fn panel(&self, req: &Request) -> Option<Ui> {
        let who = req.actor.name.split_whitespace().next().unwrap_or("there");
        Some(ui(format!("Hi {who}! Ask me where things are or how the office works.")))
    }
}

export_plugin!(Kiosk);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn asks_the_office_model() {
        let mut o = TestOffice::<Kiosk>::new();
        o.model(|ask| {
            assert!(ask.system.as_deref().unwrap().contains("You stand in the lobby"));
            Ok(format!("In the kitchen, friend. ({})", ask.prompt))
        });
        let r = o.type_in("Ada Lovelace", "ask", "where is the coffee?");
        assert_eq!(r.say.as_deref(), Some("🤖 In the kitchen, friend. (where is the coffee?)"));
        assert!(!r.ui.unwrap().text.contains("offline"));
        assert_eq!(o.asked().len(), 1);
        assert_eq!(o.state().questions, 1, "the first call's state is kept");
        o.assert_clean();
    }

    #[test]
    fn without_a_model_it_answers_from_what_it_knows() {
        let mut o = TestOffice::<Kiosk>::new();
        let r = o.type_in("Ada", "ask", "Where is the coffee?");
        assert!(r.say.unwrap().contains("Kitchen"));
        assert!(r.ui.unwrap().text.contains("(offline: this office has no model)"));
        let r = o.type_in("Ada", "ask", "what's the meaning of life");
        assert_eq!(r.say.unwrap(), format!("🤖 {OFFLINE}"));
        o.model(|_| Err("Workers AI failed".into()));
        assert!(o.type_in("Ada", "ask", "any snacks?").say.unwrap().contains("vending machine"));
    }

    #[test]
    fn empty_questions_dont_ask() {
        let mut o = TestOffice::<Kiosk>::new();
        assert!(o.use_as("Ada").ui.unwrap().text.starts_with("Hi Ada!"));
        assert_eq!(o.type_in("Ada", "ask", " ").ui.unwrap().text, "Type a question first.");
        assert!(o.asked().is_empty());
    }
}
