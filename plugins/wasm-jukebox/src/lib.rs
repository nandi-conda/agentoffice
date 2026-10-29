//! The jukebox in the Lounge, as a WASM plugin built with the
//! agentoffice-plugin crate. People queue songs; each track's `id` names a
//! tune the browser synthesises (public/js/music.js), so everyone near the
//! jukebox hears it in sync (`display.music`), quieter as they walk away.
//! When a song ends the office wakes the jukebox (`wake_at`) and it moves on
//! to the next one.
//!
//! Build with `just plugin-build jukebox`, test with `just plugin-test jukebox`.

use agentoffice_plugin::prelude::*;

pub struct Track { pub id: &'static str, pub title: &'static str, pub artist: &'static str, pub mins: u32 }

/// A track's `id` must be a tune in public/js/music.js (TUNES).
pub const TRACKS: [Track; 6] = [
    Track { id: "rain", title: "Rain on the Skylight", artist: "Lo-Fi Larks", mins: 3 },
    Track { id: "standup", title: "Standup at Nine", artist: "The Async Five", mins: 4 },
    Track { id: "deploy", title: "Friday Deploy", artist: "Rollback Rodeo", mins: 3 },
    Track { id: "coffee", title: "Second Espresso", artist: "Bean Machine", mins: 2 },
    Track { id: "focus", title: "Deep Work (Extended Mix)", artist: "Pomodoro Club", mins: 6 },
    Track { id: "merge", title: "Merge Conflict Blues", artist: "Git Gud", mins: 4 },
];
pub const QUEUE_MAX: usize = 8;
const MIN: f64 = 60_000.0;

/// A song someone picked.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub mins: u32,
    pub by: String,
    /// Set while it plays: epoch ms when it ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<f64>,
}

impl Song {
    fn ends(&self) -> f64 { self.ends_at.unwrap_or(0.0) }
    fn started(&self) -> f64 { self.ends() - f64::from(self.mins) * MIN }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Jukebox {
    pub queue: Vec<Song>,
    pub playing: Option<Song>,
    pub plays: u32,
}

fn first_name(actor: &Actor) -> String {
    actor.name.split_whitespace().next().unwrap_or("someone").to_string()
}

fn now_playing(s: &Song) -> String {
    format!("♪ Now playing “{}” by {}, picked by {}", s.title, s.artist, s.by)
}

impl Jukebox {
    /// Whatever was playing has finished: move the queue along.
    fn advance(&mut self, now: f64) {
        while let Some(p) = &self.playing {
            if now < p.ends() { break; }
            let start = p.ends().max(now - 1000.0);
            self.playing = if self.queue.is_empty() { None } else {
                let mut next = self.queue.remove(0);
                next.ends_at = Some(start + f64::from(next.mins) * MIN);
                Some(next)
            };
        }
    }

    fn play(&mut self, id: &str, req: &Request) -> Response {
        let Some(t) = TRACKS.iter().find(|t| t.id == id) else { return Response::error("That song isn't on this jukebox.") };
        if self.queue.len() >= QUEUE_MAX { return Response::error("The queue is full. Wait for a song to finish."); }
        let mut song = Song { id: t.id.into(), title: t.title.into(), artist: t.artist.into(), mins: t.mins, by: first_name(&req.actor), ends_at: None };
        self.plays += 1;
        if self.playing.is_none() {
            song.ends_at = Some(req.now + f64::from(t.mins) * MIN);
            let say = now_playing(&song);
            self.playing = Some(song);
            Response::new().say(say)
        } else {
            let say = format!("♪ {} queued “{}”", song.by, song.title);
            self.queue.push(song);
            Response::new().say(say)
        }
    }

    /// Ask to be woken when the song ends.
    fn wake(&self, r: Response) -> Response {
        match &self.playing { Some(p) => r.wake_at(p.ends()), None => r }
    }
}

impl Plugin for Jukebox {
    const MANIFEST: Manifest = Manifest::new("Jukebox")
        .doc("Pick songs from a small catalogue; they queue and play one after another for everyone nearby, and the jukebox shows what's on.")
        .prompt("Pick a song on the jukebox")
        .emoji("🎵")
        .glow("#a78bfa")
        .look(Look::Jukebox)
        .actions(&[
            Action::new("play:<track>", "Play a track, or queue it if one is playing (rain, standup, deploy, coffee, focus, merge)"),
            Action::new("skip", "Skip the song that's playing"),
        ]);

    fn on_use(&mut self, req: &Request) -> Response {
        self.advance(req.now);
        self.wake(Response::new())
    }

    fn on_action(&mut self, req: &Request) -> Response {
        self.advance(req.now);
        let r = if let Some(id) = req.arg("play") {
            self.play(id, req)
        } else if req.is("skip") {
            match &mut self.playing {
                Some(p) => {
                    let say = format!("⏭ {} skipped “{}”", first_name(&req.actor), p.title);
                    p.ends_at = Some(req.now);
                    self.advance(req.now);
                    Response::new().say(say)
                }
                None => Response::new(),
            }
        } else {
            Response::error(format!("The jukebox doesn't know how to {}", req.action))
        };
        self.wake(r)
    }

    // The office wakes it when a song ends: announce the next one.
    fn on_tick(&mut self, req: &Request) -> Response {
        let before = self.playing.as_ref().map(Song::ends);
        self.advance(req.now);
        let r = match &self.playing {
            Some(p) if Some(p.ends()) != before => Response::new().say(now_playing(p)),
            _ => Response::new(),
        };
        self.wake(r)
    }

    fn panel(&self, _req: &Request) -> Option<Ui> {
        let text = match &self.playing {
            Some(p) => format!("Now playing **{}** by {} (picked by {}).\nPress N (or the ♪ button) to mute it for yourself.", p.title, p.artist, p.by),
            None => "Nothing playing. Pick a song.".into(),
        };
        let mut ui = Ui::new("🎵 Jukebox").text(text)
            .items(TRACKS.iter().map(|t| Row::new(t.title, format!("play:{}", t.id)).detail(format!("{} · {} min", t.artist, t.mins))));
        if !self.queue.is_empty() {
            ui = ui.list("Up next", self.queue.iter().map(|q| format!("{} ({})", q.title, q.by)));
        }
        if self.playing.is_some() { ui = ui.button("Skip", "skip"); }
        Some(ui)
    }

    fn display(&self) -> Option<Display> {
        Some(match &self.playing {
            Some(p) => Display::label(format!("♪ {}", p.title)).glow("#a78bfa").until(p.ends()).music(&p.id, p.started()),
            None => Display::default(),
        })
    }
}

export_plugin!(Jukebox);

#[cfg(test)]
mod tests {
    use super::*;
    use agentoffice_plugin::testing::TestOffice;

    #[test]
    fn plays_queues_skips_and_moves_on() {
        let mut office = TestOffice::<Jukebox>::new();
        let r = office.act("Ada Lovelace", "play:rain");
        assert_eq!(r.say.as_deref(), Some("♪ Now playing “Rain on the Skylight” by Lo-Fi Larks, picked by Ada"));
        let d = office.display().unwrap();
        assert_eq!(d.label.as_deref(), Some("♪ Rain on the Skylight"));
        assert_eq!(d.music.as_ref().unwrap().id, "rain");
        let r = office.act("Grace", "play:deploy");
        assert_eq!(r.say.as_deref(), Some("♪ Grace queued “Friday Deploy”"));
        assert_eq!(r.ui.unwrap().list.unwrap().rows, vec!["Friday Deploy (Grace)"]);

        // The song ends: the office's wake-up call starts the next one.
        let r = office.tick();
        assert!(r.say.unwrap().contains("Friday Deploy"));
        assert_eq!(office.state().playing.unwrap().id, "deploy");
        assert!(office.wake_at().is_some());

        let r = office.act("Ada Lovelace", "skip");
        assert!(r.say.unwrap().starts_with("⏭ Ada skipped"));
        assert!(office.state().playing.is_none());
        assert_eq!(office.display().unwrap().label, None);
        office.assert_clean();
    }

    #[test]
    fn unknown_songs_and_a_full_queue() {
        let mut office = TestOffice::<Jukebox>::new();
        assert!(office.act("Ada", "play:nope").toast.is_some());
        for _ in 0..=QUEUE_MAX { office.act("Ada", "play:focus"); }
        assert_eq!(office.act("Ada", "play:focus").toast.as_deref(), Some("The queue is full. Wait for a song to finish."));
    }

    #[test]
    fn every_track_is_in_the_manifest_and_old_state_loads() {
        let mut office = TestOffice::<Jukebox>::new();
        let ui = office.use_as("Ada").ui.unwrap();
        assert_eq!(ui.items.len(), TRACKS.len());
        office.assert_clean();
        // State saved by the JavaScript jukebox it replaces.
        let old: Jukebox = serde_json::from_str(r#"{"queue":[],"playing":{"id":"rain","title":"Rain on the Skylight","artist":"Lo-Fi Larks","mins":3,"by":"Ada","endsAt":5}, "plays":4}"#).unwrap();
        assert_eq!(old.playing.unwrap().ends_at, Some(5.0));
    }
}
