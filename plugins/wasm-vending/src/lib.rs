//! The vending machine in the Kitchen, as a WASM plugin built with the
//! agentoffice-plugin crate. Snacks are free while stock lasts and land in
//! your inventory (`give`; the office knows how to eat them, see
//! public/js/items.js). Once everything is gone it restocks 30 minutes later.
//!
//! Build with `just plugin-build vending`, test with `just plugin-test vending`.

use std::collections::BTreeMap;

use agentoffice_plugin::prelude::*;

pub struct Snack { pub id: &'static str, pub label: &'static str, pub emoji: &'static str }

/// The ids are item kinds the office knows (public/js/items.js).
pub const SNACKS: [Snack; 5] = [
    Snack { id: "chips", label: "Salt & Vinegar Chips", emoji: "🥔" },
    Snack { id: "choc", label: "Dark Chocolate Bar", emoji: "🍫" },
    Snack { id: "gum", label: "Mint Gum", emoji: "🍬" },
    Snack { id: "soda", label: "Sparkling Water", emoji: "🥤" },
    Snack { id: "cookie", label: "Giant Cookie", emoji: "🍪" },
];
pub const STOCK: u32 = 4;
pub const RESTOCK_MS: f64 = 30.0 * 60_000.0;
/// One in twenty gets stuck behind the glass, as is tradition.
pub const STUCK: f64 = 0.05;

#[derive(Serialize, Deserialize, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Vending {
    pub stock: BTreeMap<String, u32>,
    pub sold: u32,
    /// Epoch ms of the next restock, 0 when none is due.
    pub restock_at: f64,
}

impl Default for Vending {
    fn default() -> Self { Vending { stock: full(), sold: 0, restock_at: 0.0 } }
}

fn full() -> BTreeMap<String, u32> { SNACKS.iter().map(|s| (s.id.to_string(), STOCK)).collect() }

fn first_name(actor: &Actor) -> String {
    actor.name.split_whitespace().next().unwrap_or("someone").to_string()
}

impl Vending {
    fn left(&self, id: &str) -> u32 { self.stock.get(id).copied().unwrap_or(0) }
    fn empty(&self) -> bool { SNACKS.iter().all(|s| self.left(s.id) == 0) }
    fn restock(&mut self, now: f64) {
        if self.restock_at > 0.0 && now >= self.restock_at { self.stock = full(); self.restock_at = 0.0; }
    }
}

impl Plugin for Vending {
    const MANIFEST: Manifest = Manifest::new("Vending machine")
        .doc("Free snacks while stock lasts; they go in your inventory. Restocks 30 minutes after it sells out.")
        .prompt("Get a snack")
        .emoji("🥤")
        .glow("#38bdf8")
        .look(Look::Vending)
        .actions(&[Action::new("buy:<snack>", "Get a snack (chips, choc, gum, soda, cookie)")]);

    fn on_use(&mut self, req: &Request) -> Response {
        self.restock(req.now);
        Response::new()
    }

    fn on_action(&mut self, req: &Request) -> Response {
        self.restock(req.now);
        let Some(id) = req.arg("buy") else { return Response::error(format!("The vending machine doesn't know how to {}", req.action)) };
        let Some(s) = SNACKS.iter().find(|s| s.id == id) else { return Response::error("No such button.") };
        if self.left(s.id) == 0 { return Response::error(format!("{} is sold out.", s.label)); }
        let who = first_name(&req.actor);
        if req.chance(STUCK) {
            return Response::new().say(format!("*clunk*… {who}'s {} is stuck. Classic.", s.label.to_lowercase()));
        }
        *self.stock.entry(s.id.into()).or_default() -= 1;
        self.sold += 1;
        if self.empty() { self.restock_at = req.now + RESTOCK_MS; }
        Response::new()
            .say(format!("{} *clunk* {who} got {}", s.emoji, s.label.to_lowercase()))
            .give(Give::new(s.id).name(s.label).emoji(s.emoji))
    }

    fn panel(&self, _req: &Request) -> Option<Ui> {
        let text = if self.empty() { "Everything is sold out. A restock is on its way.".to_string() } else { format!("Snacks are on the house. {} sold so far.", self.sold) };
        Some(Ui::new("🥤 Vending machine").text(text).items(SNACKS.iter().map(|s| {
            let n = self.left(s.id);
            Row::new(format!("{} {}", s.emoji, s.label), format!("buy:{}", s.id))
                .detail(if n > 0 { format!("{n} left") } else { "sold out".into() })
                .disabled(n == 0)
        })))
    }

    fn display(&self) -> Option<Display> {
        Some(if self.empty() { Display::label("sold out").glow("#ef4444") } else { Display::default().glow("#38bdf8") })
    }
}

export_plugin!(Vending);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    // A seed whose first draw doesn't get the snack stuck.
    fn office() -> TestOffice<Vending> {
        let mut o = TestOffice::<Vending>::new();
        o.seed(7);
        o
    }

    #[test]
    fn a_snack_goes_in_your_pocket() {
        let mut o = office();
        let mut got = 0;
        for _ in 0..20 {
            let r = o.act("Ada Lovelace", "buy:cookie");
            if r.give.is_empty() { assert!(r.toast.is_some() || r.say.unwrap().contains("stuck")); } else { got += 1; }
        }
        assert_eq!(got, STOCK as usize, "four cookies, then sold out");
        assert_eq!(o.inventory("Ada Lovelace")[0].kind, "cookie");
        assert_eq!(o.inventory("Ada Lovelace")[0].qty, STOCK);
        let ui = o.use_as("Ada Lovelace").ui.unwrap();
        assert!(ui.items.iter().find(|r| r.action == "buy:cookie").unwrap().disabled);
        o.assert_clean();
    }

    #[test]
    fn sells_out_and_restocks() {
        let mut o = office();
        for s in SNACKS { for _ in 0..12 { o.act("Ada", &format!("buy:{}", s.id)); if o.state().left(s.id) == 0 { break; } } }
        // Hands hold 20 stacks, so everything fits.
        assert!(o.state().empty());
        assert_eq!(o.display().unwrap().label.as_deref(), Some("sold out"));
        assert!(o.act("Ada", "buy:gum").toast.unwrap().contains("sold out"));
        o.advance(RESTOCK_MS);
        o.use_as("Ada");
        assert_eq!(o.state().left("gum"), STOCK);
    }

    #[test]
    fn sometimes_it_sticks() {
        let stuck = (0..400).filter(|i| {
            let mut o = TestOffice::<Vending>::new();
            o.seed(*i);
            o.act("Ada", "buy:gum").say.unwrap().contains("stuck")
        }).count();
        assert!((5..60).contains(&stuck), "about one in twenty seeds stick ({stuck} of 400)");
    }

    #[test]
    fn old_state_loads() {
        let v: Vending = serde_json::from_str(r#"{"stock":{"chips":1,"choc":0,"gum":4,"soda":4,"cookie":4},"sold":3,"restockAt":0}"#).unwrap();
        assert_eq!(v.left("chips"), 1);
    }
}
