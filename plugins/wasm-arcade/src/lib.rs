//! The two Byte Snake cabinets in the Lounge share one leaderboard, kept by
//! this WASM plugin built with the agentoffice-plugin crate: the top 20, best
//! first. The game itself runs in your browser (public/js/snake.js); when it
//! ends, the office turns its `score` message into this plugin's
//! `score:<points>` action.
//!
//! The top 10 go out with the display (`display.data`), so every browser
//! shows them next to the game; the panel this plugin answers with is for
//! agents (`plugin_interact`), who can't play.
//!
//! Build with `just plugin-build arcade`, test with `just plugin-test arcade`.

use agentoffice_plugin::prelude::*;

pub const MAX_SCORES: usize = 20;
pub const SHOWN: usize = 10;
pub const MAX_SCORE: u32 = 10_000;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Score {
    /// The player's name when they played.
    pub name: String,
    pub score: u32,
    /// Epoch ms.
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
pub struct Arcade {
    /// Best first, at most 20.
    pub scores: Vec<Score>,
}

fn ordinal(n: usize) -> String {
    let suffix = match (n % 10, n % 100) { (1, x) if x != 11 => "st", (2, x) if x != 12 => "nd", (3, x) if x != 13 => "rd", _ => "th" };
    format!("{n}{suffix}")
}

impl Arcade {
    fn score(&mut self, req: &Request, points: &str) -> Response {
        if req.actor.is_system() { return Response::error("Only players get on the leaderboard."); }
        let Ok(score) = points.trim().parse::<u32>() else { return Response::error("A score is a whole number of points.") };
        if score == 0 { return Response::new(); }
        if score > MAX_SCORE { return Response::error(format!("Nobody scores more than {MAX_SCORE}.")); }
        let entry = Score { name: req.actor.name.clone(), score, ts: req.now as u64 };
        // After any equal scores already there: the first to get it keeps the place.
        let at = self.scores.iter().position(|s| s.score < score).unwrap_or(self.scores.len());
        self.scores.insert(at, entry);
        self.scores.truncate(MAX_SCORES);
        match at {
            0 => Response::new()
                .toast(format!("🏆 {score}: the best Byte Snake score in the office!"))
                .say(format!("🕹️ New Byte Snake high score: {} got {score}!", req.actor.name.split_whitespace().next().unwrap_or("someone"))),
            n if n < SHOWN => Response::new().toast(format!("🕹️ {score}: {} on the office leaderboard.", ordinal(n + 1))),
            _ => Response::new(),
        }
    }
}

impl Plugin for Arcade {
    const MANIFEST: Manifest = Manifest::new("Arcade cabinet")
        .doc("Byte Snake and the office leaderboard: the top 20 scores, best first. The game runs in browsers; a score lands here when a game ends.")
        .prompt("Play Byte Snake")
        .emoji("🕹️")
        .glow("#a78bfa")
        .actions(&[
            Action::new("score:<points>", "Put a finished game's score on the leaderboard (1–10000; what the office's score message does)"),
        ]);

    fn on_action(&mut self, req: &Request) -> Response {
        match req.arg("score") {
            Some(points) => self.score(req, points),
            None => Response::error(format!("The arcade doesn't know how to {}", req.action)),
        }
    }

    fn panel(&self, _req: &Request) -> Option<Ui> {
        let text = if self.scores.is_empty() { "No scores yet. Byte Snake is played in a browser: arrow keys or WASD, eat the bugs, don't bite your tail.".to_string() }
            else { "Office high scores. Byte Snake is played in a browser; scores land here when a game ends.".to_string() };
        let ui = Ui::new("🕹️ Byte Snake").text(text);
        if self.scores.is_empty() { return Some(ui); }
        Some(ui.list("Office high scores", self.scores.iter().take(SHOWN).enumerate().map(|(i, s)| format!("{}. {} · {}", i + 1, s.name, s.score))))
    }

    fn display(&self) -> Option<Display> {
        let top: Vec<&Score> = self.scores.iter().take(SHOWN).collect();
        Some(Display::default().data(json!({ "scores": top })))
    }
}

export_plugin!(Arcade);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    fn names(o: &TestOffice<Arcade>) -> Vec<(String, u32)> { o.state().scores.into_iter().map(|s| (s.name, s.score)).collect() }

    #[test]
    fn scores_go_on_the_board_best_first() {
        let mut o = TestOffice::<Arcade>::new();
        let r = o.act("Ada Lovelace", "score:120");
        assert!(r.toast.unwrap().contains("best Byte Snake score"));
        assert!(r.say.unwrap().contains("Ada got 120"));
        let r = o.act("Grace", "score:80");
        assert!(r.toast.unwrap().contains("2nd on the office leaderboard"));
        assert!(r.say.is_none());
        o.advance(1000.0);
        o.act("Linus", "score:120");
        assert_eq!(names(&o), [("Ada Lovelace".into(), 120), ("Linus".into(), 120), ("Grace".into(), 80)], "ties keep the first to get there on top");
        let shown: Vec<Score> = serde_json::from_value(o.display().unwrap().data.clone().unwrap()["scores"].clone()).unwrap();
        assert_eq!(shown, o.state().scores);
        o.assert_clean();
    }

    #[test]
    fn keeps_the_top_twenty_and_shows_ten() {
        let mut o = TestOffice::<Arcade>::new();
        for i in 1..=25 { o.advance(1000.0); o.act(&format!("P{i}"), &format!("score:{}", i * 10)); }
        let s = o.state().scores;
        assert_eq!(s.len(), MAX_SCORES);
        assert_eq!((s[0].score, s[19].score), (250, 60));
        assert_eq!(o.display().unwrap().data.as_ref().unwrap()["scores"].as_array().unwrap().len(), SHOWN);
        // Off the shown board: no fanfare.
        o.advance(1000.0);
        let r = o.act("Slow", "score:70");
        assert!(r.toast.is_none() && r.say.is_none());
    }

    #[test]
    fn bad_scores_dont_count() {
        let mut o = TestOffice::<Arcade>::new();
        assert!(o.act("Ada", "score:lots").toast.unwrap().contains("whole number"));
        assert!(o.act("Ada", "score:10001").toast.unwrap().contains("Nobody scores more"));
        assert!(o.act("Ada", "score:0").toast.is_none());
        assert!(o.state().scores.is_empty());
    }

    #[test]
    fn agents_read_the_board() {
        let mut o = TestOffice::<Arcade>::new();
        assert!(o.use_as("Bot").ui.unwrap().text.contains("No scores yet"));
        o.act("Ada", "score:42");
        let ui = o.use_as("Bot").ui.unwrap();
        assert_eq!(ui.list.unwrap().rows, ["1. Ada · 42"]);
        o.assert_clean();
    }

    #[test]
    fn old_state_loads() {
        // What arcade:main kept before the cabinets were a plugin (its view, adopted as { scores }).
        let a: Arcade = serde_json::from_str(r#"{"scores":[{"name":"ada","score":300,"ts":1700000000000}]}"#).unwrap();
        assert_eq!(a.scores[0], Score { name: "ada".into(), score: 300, ts: 1_700_000_000_000 });
    }
}
