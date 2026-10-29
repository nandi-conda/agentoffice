//! The Boardroom whiteboard, as a WASM plugin built with the
//! agentoffice-plugin crate. Anyone can draw on it and anyone can wipe it.
//!
//! The strokes are far more than the 32 KB of state a plugin keeps, so they
//! go in the object's feed ([`Permission::Feed`]): the office stores the
//! last 3000 and every browser gets them, drawing the board on the wall and
//! in its full-size editor. The plugin checks each stroke, signs it with
//! who drew it, and keeps only a count.
//!
//! Browsers and the MCP `wb` tool send the `wb` protocol message, which the
//! office turns into action `stroke` (the stroke as `data`) or `clear`.
//!
//! Build with `just plugin-build whiteboard`, test with `just plugin-test whiteboard`.

use agentoffice_plugin::prelude::*;

pub const MAX_POINTS: usize = 400;
pub const INK: &str = "#1f2937";
/// What the office keeps of the feed.
pub const MAX_STROKES: u32 = 3000;

/// One stroke, coordinates 0..1 across the board, origin top-left.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Stroke {
    pub points: Vec<[f64; 2]>,
    /// `#rrggbb`
    pub color: String,
    /// Line width at the editor's 1200 px, 1–40.
    pub size: f64,
    /// Who drew it.
    pub by: String,
}

/// What a browser or agent sends: points, and optionally colour and size.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Drawn {
    pub points: Vec<Value>,
    pub color: Option<String>,
    pub size: Option<f64>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Whiteboard {
    /// Strokes on the board since it was last wiped (at most what the office keeps).
    pub on_board: u32,
    /// Strokes ever drawn.
    pub drawn: u64,
    pub last_by: Option<String>,
    pub cleared_by: Option<String>,
    pub cleared_at: Option<f64>,
}

fn coord(v: &Value) -> Option<f64> {
    let n = v.as_f64().filter(|n| n.is_finite())?;
    // Four decimals is a tenth of a pixel on the editor; it keeps strokes small.
    Some((n.clamp(0.0, 1.0) * 10_000.0).round() / 10_000.0)
}

fn colour(c: Option<&str>) -> String {
    match c {
        Some(c) if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()) => c.to_ascii_lowercase(),
        _ => INK.to_string(),
    }
}

/// The stroke as it goes on the board, or `None` when it isn't one.
pub fn stroke(d: Drawn, by: &str) -> Option<Stroke> {
    let points: Vec<[f64; 2]> = d.points.iter().take(MAX_POINTS)
        .filter_map(|p| Some([coord(p.get(0)?)?, coord(p.get(1)?)?]))
        .collect();
    if points.len() < 2 { return None; }
    let size = d.size.filter(|s| s.is_finite()).unwrap_or(3.0).clamp(1.0, 40.0);
    Some(Stroke { points, color: colour(d.color.as_deref()), size, by: by.to_string() })
}

impl Plugin for Whiteboard {
    const MANIFEST: Manifest = Manifest::new("Whiteboard")
        .doc("The shared Boardroom whiteboard. Everyone in the office sees it live; it's drawn on the boardroom wall too.")
        .prompt("Open the whiteboard")
        .emoji("🖍️")
        .glow("#2563eb")
        .look(Look::Whiteboard)
        .permissions(&[Permission::Feed])
        .actions(&[
            Action::new("stroke", "Draw a stroke: data { points: [[x, y], …] (2–400, 0..1 across the board, origin top-left), color: \"#rrggbb\", size: 1–40 }"),
            Action::new("clear", "Wipe the board for everyone"),
        ]);

    fn on_action(&mut self, req: &Request) -> Response {
        if req.is("stroke") {
            let Some(s) = req.data_as::<Drawn>().and_then(|d| stroke(d, &req.actor.name)) else {
                return Response::error("A stroke needs at least two [x, y] points between 0 and 1.");
            };
            self.on_board = (self.on_board + 1).min(MAX_STROKES);
            self.drawn += 1;
            self.last_by = Some(req.actor.name.clone());
            // Drawing is quiet: the stroke itself is the answer.
            return Response::new().append(s);
        }
        if req.is("clear") {
            self.on_board = 0;
            self.cleared_by = Some(req.actor.name.clone());
            self.cleared_at = Some(req.now);
            return Response::new().clear_feed().toast("🧽 Wiped the whiteboard.");
        }
        Response::error(format!("The whiteboard doesn't know how to {}", req.action))
    }

    fn panel(&self, req: &Request) -> Option<Ui> {
        // Drawing happens in the browser's editor; this is for agents
        // (plugin_interact) and anyone without it.
        if req.is("stroke") { return None; }
        let mut text = match self.on_board {
            0 => "The board is clean.".to_string(),
            1 => "**1** stroke on the board".to_string(),
            n => format!("**{n}** strokes on the board"),
        };
        if self.on_board > 0 { if let Some(by) = &self.last_by { text.push_str(&format!(", the last by {by}.")); } }
        if let (Some(by), Some(at)) = (&self.cleared_by, self.cleared_at) { text.push_str(&format!("\nLast wiped by {by} at {}.", stamp(at))); }
        text.push_str("\nDraw with action `stroke` and the stroke as data (or the `wb` tool).");
        Some(Ui::new("🖍️ Whiteboard").text(text).button("Wipe the board", "clear"))
    }
}

export_plugin!(Whiteboard);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn draw_and_wipe() {
        let mut o = TestOffice::<Whiteboard>::new();
        let r = o.send("Ada", "stroke", json!({ "points": [[0.1, 0.2], [0.3, 0.40000001]], "color": "#EF4444", "size": 6 }));
        assert!(r.toast.is_none() && r.ui.is_none());
        let s: Stroke = serde_json::from_value(o.feed()[0].clone()).unwrap();
        assert_eq!(s, Stroke { points: vec![[0.1, 0.2], [0.3, 0.4]], color: "#ef4444".into(), size: 6.0, by: "Ada".into() });
        assert_eq!(o.state().on_board, 1);
        assert!(o.use_as("Grace").ui.unwrap().text.contains("**1** stroke on the board, the last by Ada."));

        o.act("Grace", "clear");
        assert!(o.feed().is_empty());
        assert_eq!(o.state().on_board, 0);
        assert!(o.use_as("Ada").ui.unwrap().text.contains("Last wiped by Grace"));
        o.assert_clean();
    }

    #[test]
    fn strokes_are_checked() {
        let mut o = TestOffice::<Whiteboard>::new();
        // Off the board is clamped, bad colours are ink, sizes are kept in range.
        o.send("Ada", "stroke", json!({ "points": [[-1, 2], [0.5, "x"], [0.5, 0.5]], "color": "red", "size": 99 }));
        let s: Stroke = serde_json::from_value(o.feed()[0].clone()).unwrap();
        assert_eq!((s.points, s.color.as_str(), s.size), (vec![[0.0, 1.0], [0.5, 0.5]], INK, 40.0));
        // Too few points, or no data at all.
        assert!(o.send("Ada", "stroke", json!({ "points": [[0.1, 0.1]] })).toast.unwrap().contains("two"));
        assert!(o.act("Ada", "stroke").toast.unwrap().contains("two"));
        assert_eq!(o.feed().len(), 1);
        // At most 400 points, and the longest stroke a browser sends fits a feed entry.
        let long: Vec<[f64; 2]> = (0..500).map(|i| [i as f64 / 500.0 + 0.000123456789, 0.987654321]).collect();
        o.send("Ada", "stroke", json!({ "points": long, "color": "#1f2937", "size": 4 }));
        assert_eq!(serde_json::from_value::<Stroke>(o.feed()[1].clone()).unwrap().points.len(), MAX_POINTS);
        o.assert_clean();
    }

    #[test]
    fn without_the_feed_permission_nothing_is_drawn() {
        let mut o = TestOffice::<Whiteboard>::new();
        o.grant_only(&[]);
        o.send("Ada", "stroke", json!({ "points": [[0.1, 0.1], [0.2, 0.2]] }));
        assert!(o.feed().is_empty());
        assert!(o.warnings()[0].contains("feed permission"));
    }

    #[test]
    fn old_state_loads() {
        // What the office hands over from the old whiteboard:main entity.
        let b: Whiteboard = serde_json::from_str(r#"{"onBoard":12}"#).unwrap();
        assert_eq!(b.on_board, 12);
    }
}
