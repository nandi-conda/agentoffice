//! The notice board in the Lobby, as a WASM plugin built with the
//! agentoffice-plugin crate. Sticky notes, newest first, at most 40. You can
//! take down your own; moderators can take down anyone's.
//!
//! The notes go out with the display (`display.data`), so every browser
//! draws them on the board and in its sticky-note panel; the panel this
//! plugin answers with is for agents (`plugin_interact`) and anyone without
//! that panel.
//!
//! Build with `just plugin-build noticeboard`, test with `just plugin-test noticeboard`.

use agentoffice_plugin::prelude::*;

pub const MAX_NOTES: usize = 40;
pub const MAX_TEXT: usize = 200;
/// Paper colours.
pub const COLORS: [&str; 5] = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#ddd6fe"];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Note {
    pub id: String,
    pub text: String,
    /// The author's name when they pinned it.
    pub by: String,
    /// The author's key (their DID, or `kind:name` for guests).
    pub owner: String,
    /// Epoch ms.
    pub ts: u64,
    pub color: String,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
pub struct Board {
    /// Newest first.
    pub notes: Vec<Note>,
}

fn may_remove(n: &Note, actor: &Actor) -> bool { n.owner == actor.key() || actor.is_moderator() }

fn short(text: &str, max: usize) -> String {
    if text.chars().count() <= max { return text.to_string(); }
    format!("{}…", text.chars().take(max - 1).collect::<String>().trim_end())
}

impl Plugin for Board {
    const MANIFEST: Manifest = Manifest::new("Notice board")
        .doc("Sticky notes for the office, newest first (40 at most). Take down your own; moderators can take down anyone's.")
        .prompt("Read the notice board")
        .emoji("📌")
        .glow("#fde68a")
        .actions(&[
            Action::new("add", "Pin a note").input("The note (≤ 200 characters)"),
            Action::new("remove:<id>", "Take down a note of yours (moderators: anyone's)"),
        ]);

    fn on_action(&mut self, req: &Request) -> Response {
        if req.is("add") {
            let text = req.text_clipped(MAX_TEXT);
            if text.is_empty() { return Response::error("Write something first."); }
            let mut rng = req.rng();
            let id = format!("{:08x}", rng.next_u64() as u32);
            let color = rng.pick(&COLORS).to_string();
            self.notes.insert(0, Note { id, text, by: req.actor.name.clone(), owner: req.actor.key(), ts: req.now as u64, color });
            self.notes.truncate(MAX_NOTES);
            return Response::new().toast("📌 Pinned to the notice board.");
        }
        if let Some(id) = req.arg("remove") {
            let Some(i) = self.notes.iter().position(|n| n.id == id) else { return Response::error("That note is already gone.") };
            if !may_remove(&self.notes[i], &req.actor) { return Response::error("That's someone else's note."); }
            self.notes.remove(i);
            return Response::new().toast("Taken down.");
        }
        Response::error(format!("The notice board doesn't know how to {}", req.action))
    }

    fn panel(&self, req: &Request) -> Option<Ui> {
        let text = if self.notes.is_empty() { "Nothing pinned yet. Leave a note for the office: wins, asks, lunch plans.".to_string() }
            else { format!("{} note{} pinned. Notes stay up between visits; tap one of yours to take it down.", self.notes.len(), if self.notes.len() == 1 { "" } else { "s" }) };
        Some(Ui::new("📌 Notice board").text(text)
            .input(Input::new("add").placeholder("Pin a note…").button("Pin").max_length(MAX_TEXT as u32))
            .items(self.notes.iter().take(24).map(|n| {
                let mine = may_remove(n, &req.actor);
                Row::new(short(&n.text, 80), format!("remove:{}", n.id))
                    .detail(if mine { format!("{} · tap to take down", short(&n.by, 40)) } else { short(&n.by, 60) })
                    .disabled(!mine)
            })))
    }

    fn display(&self) -> Option<Display> {
        Some(Display::default().data(json!({ "notes": self.notes })))
    }
}

export_plugin!(Board);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn pin_and_take_down() {
        let mut o = TestOffice::<Board>::new();
        o.sign_in("Ada", "ada.test");
        o.type_in("Ada", "add", "  lunch at noon?  ");
        let notes = o.state().notes;
        assert_eq!(notes[0].text, "lunch at noon?");
        assert_eq!(notes[0].owner, "did:plc:adatest");
        assert!(COLORS.contains(&notes[0].color.as_str()));
        let shown: Vec<Note> = serde_json::from_value(o.display().unwrap().data.clone().unwrap()["notes"].clone()).unwrap();
        assert_eq!(shown, notes);

        // Grace can't take down Ada's note; a moderator can.
        let id = notes[0].id.clone();
        assert!(o.act("Grace", &format!("remove:{id}")).toast.unwrap().contains("someone else's"));
        let ui = o.use_as("Grace").ui.unwrap();
        assert!(ui.items[0].disabled);
        o.role("Mo", "moderator");
        o.act("Mo", &format!("remove:{id}"));
        assert!(o.state().notes.is_empty());
        o.assert_clean();
    }

    #[test]
    fn guests_own_their_notes_by_name() {
        let mut o = TestOffice::<Board>::new();
        o.type_in("Gus", "add", "hi");
        let id = o.state().notes[0].id.clone();
        assert_eq!(o.state().notes[0].owner, "human:Gus");
        assert!(!o.use_as("Gus").ui.unwrap().items[0].disabled);
        o.act("Gus", &format!("remove:{id}"));
        assert!(o.state().notes.is_empty());
    }

    #[test]
    fn newest_first_and_forty_at_most() {
        let mut o = TestOffice::<Board>::new();
        for i in 0..45 { o.type_in("Ada", "add", &format!("note {i}")); }
        let notes = o.state().notes;
        assert_eq!(notes.len(), MAX_NOTES);
        assert_eq!(notes[0].text, "note 44");
        assert!(o.type_in("Ada", "add", "   ").toast.unwrap().contains("Write something"));
        assert_eq!(o.use_as("Ada").ui.unwrap().items.len(), 24);
        o.assert_clean();
    }

    #[test]
    fn forty_long_notes_fit_in_the_display() {
        let mut o = TestOffice::<Board>::new();
        o.sign_in("Ada Lovelace", "ada.example.com");
        for _ in 0..45 { o.type_in("Ada Lovelace", "add", &"x".repeat(MAX_TEXT)); }
        o.assert_clean();
    }

    #[test]
    fn old_state_loads() {
        // The noticeboard:main entity's notes, as the office hands them over.
        let b: Board = serde_json::from_str(r##"{"notes":[{"id":"1a2b3c4d","text":"hi","by":"ada","owner":"did:plc:ada","ts":1761700000000,"color":"#fde68a"}]}"##).unwrap();
        assert_eq!(b.notes[0].by, "ada");
    }
}
