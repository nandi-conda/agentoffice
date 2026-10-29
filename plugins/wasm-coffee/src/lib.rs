//! The coffee machine in the Kitchen, as a WASM plugin built with the
//! agentoffice-plugin crate. Every cup it pours goes in your inventory
//! (`give`; the office knows how to drink one, see public/js/items.js) and
//! onto its count, which the notice board shows (`display.data`).
//!
//! The office does the social part itself: your avatar holds the mug for a
//! few minutes and people nearby get a coffee-chat nudge (the `coffee`
//! message, server/office.js), which also calls this plugin.
//!
//! Build with `just plugin-build coffee`, test with `just plugin-test coffee`.

use agentoffice_plugin::prelude::*;

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
pub struct Coffee {
    /// Cups poured, ever.
    pub count: u32,
}

impl Coffee {
    fn cup(&mut self, req: &Request) -> Option<String> {
        self.count += 1;
        let who = req.actor.name.split_whitespace().next().unwrap_or("someone");
        (self.count % 100 == 0).then(|| format!("☕ Cup number {} from this machine, poured for {who}!", self.count))
    }
}

impl Plugin for Coffee {
    const MANIFEST: Manifest = Manifest::new("Coffee machine")
        .doc("Pours you a coffee: the cup goes in your inventory. Counts every cup.")
        .prompt("Grab a coffee")
        .emoji("☕")
        .glow("#f59e0b")
        .actions(&[
            Action::new("pour", "Pour a coffee into your inventory (what pressing E does)"),
            Action::new("brew", "Count a cup without taking one (the office's coffee message, away from the machine)"),
        ]);

    fn on_use(&mut self, req: &Request) -> Response { self.on_action(req) }

    fn on_action(&mut self, req: &Request) -> Response {
        match req.action.as_str() {
            "use" | "pour" => Response::new()
                .say_opt(self.cup(req))
                .toast("☕ Fresh coffee. Your mug shows for a few minutes, so people nearby know you're up for a chat. The cup is in your things.")
                .give(Give::new("coffee")),
            "brew" => Response::new().say_opt(self.cup(req)),
            other => Response::error(format!("The coffee machine doesn't know how to {other}")),
        }
    }

    fn display(&self) -> Option<Display> {
        Some(Display::default().data(json!({ "count": self.count })))
    }
}

export_plugin!(Coffee);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn pours_a_cup_into_your_things() {
        let mut o = TestOffice::<Coffee>::new();
        let r = o.use_as("Ada");
        assert!(r.ui.is_none(), "no panel: pressing E just pours");
        assert!(r.toast.unwrap().contains("Fresh coffee"));
        assert_eq!(o.inventory("Ada")[0].kind, "coffee");
        o.act("Ada", "pour");
        assert_eq!(o.inventory("Ada")[0].qty, 2);
        assert_eq!(o.state().count, 2);
        assert_eq!(o.display().unwrap().data, Some(json!({ "count": 2 })));
        o.assert_clean();
    }

    #[test]
    fn brew_counts_without_a_cup() {
        let mut o = TestOffice::<Coffee>::new();
        o.act("Ada", "brew");
        assert!(o.inventory("Ada").is_empty());
        assert_eq!(o.state().count, 1);
    }

    #[test]
    fn the_hundredth_cup_is_news() {
        let mut o = TestOffice::<Coffee>::new().with_state(Coffee { count: 99 });
        assert!(o.act("Ada Lovelace", "brew").say.unwrap().contains("Cup number 100 from this machine, poured for Ada"));
    }

    #[test]
    fn old_state_loads() {
        // What the coffee:main entity kept before the machine was a plugin.
        let c: Coffee = serde_json::from_str(r#"{"count":412}"#).unwrap();
        assert_eq!(c.count, 412);
    }
}
