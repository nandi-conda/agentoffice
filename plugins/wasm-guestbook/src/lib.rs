//! A guestbook for Agent Office, as an uploadable WASM plugin built with the
//! agentoffice-plugin crate. Build it with `just plugin-build guestbook`,
//! try it with `just plugin-test guestbook`.

use agentoffice_plugin::prelude::*;

const MAX_NOTE: usize = 120;
const KEEP: usize = 20;

/// The guestbook is its own memory: the notes, newest first.
#[derive(Serialize, Deserialize, Default)]
struct Guestbook {
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    name: String,
    text: String,
    at: f64,
}

impl Plugin for Guestbook {
    const MANIFEST: Manifest = Manifest::new("Guestbook")
        .doc("Leave a note for the office; the last 20 stay up.")
        .prompt("Sign the guestbook")
        .emoji("📖")
        .glow("#f59e0b")
        .look(Look::Plinth)
        .actions(&[Action::new("sign", "Sign the guestbook with a note").input("Your note, up to 120 characters")]);

    fn on_action(&mut self, req: &Request) -> Response {
        let note = req.text_clipped(MAX_NOTE);
        if !req.is("sign") || note.is_empty() {
            return Response::new();
        }
        let say = format!("✍️ {} signed the guestbook: “{note}”", req.actor.name);
        self.entries.insert(0, Entry { name: req.actor.name.clone(), text: note, at: req.now });
        self.entries.truncate(KEEP);
        Response::new().say(say)
    }

    fn panel(&self, _req: &Request) -> Option<Ui> {
        let text = match self.entries.len() {
            0 => "Nobody has signed yet. Be the first!".to_string(),
            n => format!("**{n}** signed so far."),
        };
        Some(Ui::new("📖 Guestbook")
            .text(text)
            .list("Latest", self.entries.iter().map(|e| format!("{}: {}", e.name, e.text)))
            .input(Input::new("sign").placeholder("Leave a note…").button("Sign").max_length(MAX_NOTE as u32)))
    }

    fn display(&self) -> Option<Display> {
        let label = match self.entries.len() {
            1 => "1 signature".to_string(),
            n => format!("{n} signatures"),
        };
        Some(Display::label(label).glow("#f59e0b"))
    }
}

export_plugin!(Guestbook);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn opens_empty() {
        let mut office = TestOffice::<Guestbook>::new();
        let ui = office.use_as("Ada").ui.unwrap();
        assert_eq!(ui.title, "📖 Guestbook");
        assert!(ui.text.contains("Nobody"));
        assert_eq!(ui.input.unwrap().action, "sign");
        office.assert_clean();
    }

    #[test]
    fn signing_keeps_the_newest_first() {
        let mut office = TestOffice::<Guestbook>::new();
        let r = office.type_in("Ada", "sign", "hello office");
        assert_eq!(r.say.as_deref(), Some("✍️ Ada signed the guestbook: “hello office”"));
        office.type_in("Grace", "sign", "  hi  ");
        let book = office.state();
        assert_eq!(book.entries.len(), 2);
        assert_eq!(book.entries[0].text, "hi");
        assert_eq!(office.display().unwrap().label.as_deref(), Some("2 signatures"));
        office.assert_clean();
    }

    #[test]
    fn empty_notes_and_long_ones() {
        let mut office = TestOffice::<Guestbook>::new();
        assert!(office.type_in("Ada", "sign", "   ").say.is_none());
        office.type_in("Ada", "sign", &"x".repeat(300));
        assert_eq!(office.state().entries[0].text.len(), MAX_NOTE);
        for i in 0..25 {
            office.type_in("Ada", "sign", &format!("note {i}"));
        }
        assert_eq!(office.state().entries.len(), KEEP);
        office.assert_clean();
    }

    #[test]
    fn manifest_describes_it() {
        let m: Value = serde_json::from_str(&Guestbook::MANIFEST.to_json()).unwrap();
        assert_eq!(m["name"], "Guestbook");
        assert_eq!(m["look"], "plinth");
        assert!(m["api"]["sign"]["params"]["input"].is_object());
    }
}
