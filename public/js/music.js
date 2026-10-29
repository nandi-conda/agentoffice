// Music from objects (the jukebox): small chiptune songs synthesised with
// WebAudio, so there are no audio files and no licences. A plugin object puts
// { music: { id, at } } in its display; everyone near it plays tune `id` from
// `at` (server time), so they all hear the same bar, quieter with distance.
//
// A tune is a few numbers (tempo, key, scale, chords, voices) and a seed; the
// melody, bass and drums are generated from them the same way in every
// browser, bar by bar, forever.

// Scales as semitones above the root.
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  pentatonic: [0, 3, 5, 7, 10, 12, 15],
  blues: [0, 3, 5, 6, 7, 10, 12],
};

// chords: scale degrees (0-based) of each bar's root, looping.
// swing: 0..0.33 delays the off-beat 16ths. density: how busy the melody is.
export const TUNES = {
  rain: { bpm: 72, root: 57, scale: 'pentatonic', chords: [0, 3, 4, 2], lead: 'triangle', pad: 'sine', density: 0.35, swing: 0.12, drums: 'soft', seed: 11 },
  standup: { bpm: 116, root: 60, scale: 'major', chords: [0, 4, 5, 3], lead: 'square', pad: 'triangle', density: 0.6, swing: 0, drums: 'four', seed: 23 },
  deploy: { bpm: 138, root: 52, scale: 'minor', chords: [0, 5, 2, 6], lead: 'sawtooth', pad: 'square', density: 0.75, swing: 0, drums: 'drive', seed: 37, arp: true },
  coffee: { bpm: 96, root: 62, scale: 'dorian', chords: [0, 3, 1, 4], lead: 'triangle', pad: 'sine', density: 0.5, swing: 0.25, drums: 'brush', seed: 41 },
  focus: { bpm: 70, root: 55, scale: 'major', chords: [0, 5, 3, 4], lead: 'sine', pad: 'triangle', density: 0.2, swing: 0, drums: 'none', seed: 53 },
  merge: { bpm: 84, root: 52, scale: 'blues', chords: [0, 0, 3, 0, 4, 3, 0, 4], lead: 'square', pad: 'triangle', density: 0.5, swing: 0.3, drums: 'shuffle', seed: 67 },
};

// Deterministic randomness: the same tune, bar and voice give the same notes everywhere.
function rng(...keys) {
  let h = 2166136261;
  for (const k of keys) { h ^= k; h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

const DRUMS = {
  none: { kick: [], snare: [], hat: [] },
  soft: { kick: [0, 10], snare: [8], hat: [4, 12], vol: 0.5 },
  four: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14] },
  drive: { kick: [0, 3, 8, 11], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
  brush: { kick: [0, 8], snare: [4, 12], hat: [0, 3, 6, 8, 11, 14], vol: 0.6 },
  shuffle: { kick: [0, 6, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], vol: 0.8 },
};

// The notes of one 16-step bar: [{ step, len (steps), midi, voice }] plus drum hits.
export function bar(tune, n) {
  const sc = SCALES[tune.scale];
  const deg = (d) => tune.root + sc[((d % sc.length) + sc.length) % sc.length] + 12 * Math.floor(d / sc.length);
  const chord = tune.chords[n % tune.chords.length];
  const notes = [];
  // Pad: the chord, held for the bar.
  for (const d of [0, 2, 4]) notes.push({ step: 0, len: 16, midi: deg(chord + d) - 12, voice: 'pad' });
  // Bass: root on the beat, fifth on the "and" of 3.
  notes.push({ step: 0, len: 4, midi: deg(chord) - 24, voice: 'bass' });
  notes.push({ step: 6, len: 2, midi: deg(chord) - 24, voice: 'bass' });
  notes.push({ step: 10, len: 4, midi: deg(chord + 4) - 24, voice: 'bass' });
  // Lead: a phrase per 2 bars, repeated with a variation every 8, walking the scale near the chord.
  const phrase = Math.floor(n / 2) % 4, variant = Math.floor(n / 8) % 3;
  const r = rng(tune.seed, phrase, variant, n % 2);
  let d = chord + 7 + Math.floor(r() * 3);
  for (let s = 0; s < 16; s += 2) {
    if (tune.arp) { notes.push({ step: s, len: 1, midi: deg(chord + [0, 2, 4, 7][(s / 2) % 4]), voice: 'lead' }); continue; }
    if (r() > tune.density) continue;
    d += Math.round((r() - 0.5) * 4);
    d = Math.max(chord + 3, Math.min(chord + 12, d));
    notes.push({ step: s, len: r() < 0.3 ? 4 : 2, midi: deg(d), voice: 'lead' });
  }
  const dr = DRUMS[tune.drums] || DRUMS.none;
  for (const k of ['kick', 'snare', 'hat']) for (const s of dr[k]) notes.push({ step: s, len: 1, voice: k });
  return notes;
}

const noises = new WeakMap();
function noiseBuf(ctx) {
  let b = noises.get(ctx);
  if (b) return b;
  b = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noises.set(ctx, b);
  return b;
}

// One note (or drum hit) of a tune, at time t on ctx.
function voice(ctx, note, t, dur, tune, out) {
  if (note.voice === 'kick' || note.voice === 'snare' || note.voice === 'hat') {
    const vol = (DRUMS[tune.drums]?.vol ?? 1);
    const g = ctx.createGain(); g.connect(out);
    if (note.voice === 'kick') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.5 * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g); o.start(t); o.stop(t + 0.2);
    } else {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf(ctx);
      const f = ctx.createBiquadFilter();
      f.type = note.voice === 'hat' ? 'highpass' : 'bandpass';
      f.frequency.value = note.voice === 'hat' ? 7000 : 1800;
      const len = note.voice === 'hat' ? 0.04 : 0.12;
      g.gain.setValueAtTime((note.voice === 'hat' ? 0.07 : 0.2) * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.connect(f); f.connect(g); src.start(t); src.stop(t + len + 0.02);
    }
    return;
  }
  const o = ctx.createOscillator();
  o.type = note.voice === 'lead' ? tune.lead : note.voice === 'bass' ? 'triangle' : tune.pad;
  o.frequency.value = hz(note.midi);
  const g = ctx.createGain();
  const peak = note.voice === 'lead' ? (tune.lead === 'sine' || tune.lead === 'triangle' ? 0.12 : 0.05) : note.voice === 'bass' ? 0.16 : (tune.pad === 'sine' ? 0.035 : 0.02);
  const attack = note.voice === 'pad' ? 0.3 : 0.01;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setTargetAtTime(0, t + Math.max(attack, dur * 0.8), note.voice === 'pad' ? 0.25 : 0.05);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + dur + 1);
}


// Play song seconds [from, to) of a tune into `out`, starting at ctx time t0.
// Used live (a slice at a time) and to render a preview offline.
export function schedule(ctx, tune, from, to, t0, out) {
  const stepDur = 60 / tune.bpm / 4;
  for (let s = Math.max(0, Math.ceil(from / stepDur)); s * stepDur < to; s++) {
    const n = Math.floor(s / 16), step = s % 16;
    const t = t0 + (s * stepDur - from) + (step % 2 ? tune.swing * stepDur : 0);
    for (const note of bar(tune, n)) if (note.step === step) voice(ctx, note, t, note.len * stepDur, tune, out);
  }
}

export function createMusic() {
  let ctx = null, master = null, playing = null, muted = false;
  try { muted = localStorage.getItem('musicMuted') === '1'; } catch { /* private window */ }

  // Browsers only start audio after a click or key press.
  const unlock = () => {
    if (!ctx) {
      try { ctx = new AudioContext(); } catch { return; }
      master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  };
  addEventListener('pointerdown', unlock, { capture: true });
  addEventListener('keydown', unlock, { capture: true });

  // Schedule whatever falls in the next ~0.3 s of the song.
  function pump(serverNow) {
    if (!playing || !ctx || ctx.state !== 'running') return;
    const songNow = (serverNow - playing.at) / 1000;
    // Fresh start, or the tab slept: pick up where the song is now.
    if (playing.until == null || playing.until < songNow - 0.5) playing.until = songNow;
    if (playing.until < songNow + 0.3) {
      schedule(ctx, playing.tune, playing.until, songNow + 0.4, ctx.currentTime + (playing.until - songNow), playing.out);
      playing.until = songNow + 0.4;
    }
  }

  function stop() {
    if (!playing) return;
    const out = playing.out;
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    setTimeout(() => out.disconnect(), 1500);
    playing = null;
  }

  return {
    get muted() { return muted; },
    get playing() { return playing ? { id: playing.id, at: playing.at, volume: playing.volume } : null; },
    setMuted(m) {
      muted = !!m;
      try { localStorage.setItem('musicMuted', muted ? '1' : ''); } catch { /* private window */ }
    },
    // Call every frame with what should be heard: { id, at, volume } or null.
    update(want, serverNow) {
      if (!ctx) return;
      if (!want || !TUNES[want.id] || want.volume <= 0) { stop(); master.gain.setTargetAtTime(0, ctx.currentTime, 0.3); return; }
      if (!playing || playing.id !== want.id || playing.at !== want.at) {
        stop();
        const out = ctx.createGain(); out.gain.value = 1; out.connect(master);
        playing = { id: want.id, at: want.at, tune: TUNES[want.id], out, until: null };
      }
      playing.volume = want.volume;
      master.gain.setTargetAtTime(muted ? 0 : want.volume * 0.8, ctx.currentTime, 0.25);
      pump(serverNow);
    },
  };
}
