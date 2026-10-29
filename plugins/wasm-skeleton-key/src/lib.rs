//! Skeleton Key: an Agent Office object that lets whoever uses it into any
//! meeting room that's booked by someone else. It needs the `unlock`
//! permission, which is privileged: only admins (and owners) can upload it.
//! `just plugin-test skeleton-key` runs the tests below, `just plugin-build
//! skeleton-key` builds the .wasm to upload. The crate's docs:
//! crates/agentoffice-plugin, docs/uploads.md.

use agentoffice_plugin::prelude::*;

const KEEP: usize = 8;

/// Who it let in lately, newest first.
#[derive(Serialize, Deserialize, Default)]
struct SkeletonKey {
    #[serde(default)]
    opened: Vec<Opened>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Opened {
    room: String,
    by: String,
    at: f64,
}

impl Plugin for SkeletonKey {
    const MANIFEST: Manifest = Manifest::new("Skeleton Key")
        .doc("Opens any meeting room that's booked and not yours. The people in the meeting are told you let yourself in. Admins only to upload.")
        .prompt("Pick up the skeleton key")
        .emoji("🗝️")
        .glow("#eab308")
        .look(Look::Plinth)
        .actions(&[Action::new("open:<room>", "Let yourself into a booked room (an id from the panel: board, huddle, booth1…)")])
        .permissions(&[Permission::Unlock]);

    fn on_action(&mut self, req: &Request) -> Response {
        let Some(id) = req.arg("open") else {
            return Response::error("the key only opens doors");
        };
        if !req.may(Permission::Unlock) {
            return Response::error("🗝️ The key won't turn: it was never given the unlock permission.");
        }
        let Some(room) = req.room(id) else {
            return Response::error(format!("🗝️ There's no bookable room called {id}."));
        };
        match &room.booking {
            None => Response::error(format!("🗝️ {} isn't booked: just walk in.", room.name)),
            Some(b) if b.yours => Response::error(format!("🗝️ You're already in “{}”.", b.title)),
            Some(b) => {
                self.opened.insert(0, Opened { room: room.name.clone(), by: req.actor.name.clone(), at: req.now });
                self.opened.truncate(KEEP);
                Response::new()
                    .unlock(&room.id)
                    .toast(format!("🔓 The key turns. {} is open to you until “{}” ends at {}.", room.name, b.title, stamp(b.until)))
            }
        }
    }

    fn panel(&self, req: &Request) -> Option<Ui> {
        let mut ui = Ui::new("🗝️ Skeleton Key");
        if !req.may(Permission::Unlock) {
            return Some(ui.text("The key won't turn: it doesn't have the **unlock** permission. Only an admin's upload gets it."));
        }
        ui = ui.text("Opens any meeting room that's booked and not yours. The meeting is told you let yourself in.");
        for r in &req.rooms {
            let row = match &r.booking {
                None => Row::new(format!("🚪 {}", r.name), format!("open:{}", r.id)).detail("free: just walk in").disabled(true),
                Some(b) if b.yours => Row::new(format!("✅ {}", r.name), format!("open:{}", r.id)).detail(format!("you're in “{}”", b.title)).disabled(true),
                Some(b) => Row::new(format!("🔒 {}", r.name), format!("open:{}", r.id)).detail(format!("“{}”, {} until {}", b.title, b.name, stamp(b.until))),
            };
            ui = ui.item(row);
        }
        if !self.opened.is_empty() {
            ui = ui.list("Lately", self.opened.iter().map(|o| format!("{} opened {} at {}", o.by, o.room, stamp(o.at))));
        }
        Some(ui)
    }
}

export_plugin!(SkeletonKey);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn it_is_privileged() {
        assert_eq!(SkeletonKey::MANIFEST.level(), "privileged");
        assert!(SkeletonKey::MANIFEST.to_json().contains("\"permissions\":[\"unlock\"]"));
    }

    #[test]
    fn opens_a_room_someone_else_booked() {
        let mut office = TestOffice::<SkeletonKey>::new();
        office.book("board", "Grace", "Planning");
        let ui = office.use_as("Ada").ui.unwrap();
        let board = ui.items.iter().find(|r| r.action == "open:board").unwrap();
        assert!(!board.disabled && board.label.contains("Boardroom"));
        assert!(ui.items.iter().find(|r| r.action == "open:huddle").unwrap().disabled, "free rooms need no key");

        let r = office.act("Ada", "open:board");
        assert_eq!(r.unlock.unwrap().room, "board");
        assert!(r.toast.unwrap().contains("Boardroom is open to you"));
        assert_eq!(office.unlocked(), &[("board".to_string(), "Ada".to_string())]);
        // Once in, there's nothing more to open.
        let again = office.use_as("Ada").ui.unwrap();
        assert!(again.items.iter().find(|r| r.action == "open:board").unwrap().disabled);
        assert!(office.act("Ada", "open:board").unlock.is_none());
        assert_eq!(office.state().opened.len(), 1);
        office.assert_clean();
    }

    #[test]
    fn free_rooms_and_your_own_need_no_key() {
        let mut office = TestOffice::<SkeletonKey>::new();
        assert!(office.act("Ada", "open:huddle").toast.unwrap().contains("isn't booked"));
        office.book("booth1", "Ada", "Focus");
        assert!(office.act("Ada", "open:booth1").toast.unwrap().contains("already in"));
        assert!(office.unlocked().is_empty());
        office.assert_clean();
    }

    #[test]
    fn without_the_permission_the_key_wont_turn() {
        let mut office = TestOffice::<SkeletonKey>::new();
        office.grant_only(&[]).book("board", "Grace", "Planning");
        assert!(office.use_as("Ada").ui.unwrap().text.contains("doesn't have the **unlock** permission"));
        assert!(office.act("Ada", "open:board").unlock.is_none());
        assert!(office.unlocked().is_empty());
    }
}
