// The example interactive objects, as plain functions. The plugin Worker
// (index.js) wraps each one in a WorkerEntrypoint so the office can call it
// over a service binding; the office imports this same file as its built-in
// fallback, so the objects keep working when no binding is deployed (the
// Node server, `wrangler dev` without the plugin running, a failed deploy).
//
// Every handler gets one request and returns one result (see docs/plugins.md):
//   interact({ object, actor, action, input, state, nearby, now }, env)
//     → { state, say, ui, display, toast }
// Handlers must not keep anything in module scope: all memory goes in `state`,
// which the office stores in the object's own Durable Object.

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const firstName = (actor) => String(actor?.name || 'someone').split(/\s+/)[0];

// ---- jukebox ----------------------------------------------------------------
// Each track's `id` names a tune the browser synthesises (public/js/music.js),
// so people near the jukebox hear it, in sync, quieter as they walk away.
export const TRACKS = [
  { id: 'rain', title: 'Rain on the Skylight', artist: 'Lo-Fi Larks', mins: 3 },
  { id: 'standup', title: 'Standup at Nine', artist: 'The Async Five', mins: 4 },
  { id: 'deploy', title: 'Friday Deploy', artist: 'Rollback Rodeo', mins: 3 },
  { id: 'coffee', title: 'Second Espresso', artist: 'Bean Machine', mins: 2 },
  { id: 'focus', title: 'Deep Work (Extended Mix)', artist: 'Pomodoro Club', mins: 6 },
  { id: 'merge', title: 'Merge Conflict Blues', artist: 'Git Gud', mins: 4 },
];
const QUEUE_MAX = 8;

export async function jukebox({ actor, action, state, now }) {
  const st = { queue: [], playing: null, plays: 0, ...state };
  // Whatever was playing has finished: move the queue along.
  const advance = () => {
    while (st.playing && now >= st.playing.endsAt) {
      const next = st.queue.shift();
      const start = Math.max(st.playing.endsAt, now - 1000);
      st.playing = next ? { ...next, endsAt: start + next.mins * 60000 } : null;
    }
  };
  const before = st.playing?.endsAt;
  advance();
  let say = null;
  // The office wakes the jukebox when a song ends ('tick'): announce the next one.
  if (action === 'tick' && st.playing && st.playing.endsAt !== before) say = `♪ Now playing “${st.playing.title}” by ${st.playing.artist}, picked by ${st.playing.by}`;
  if (action.startsWith('play:')) {
    const t = TRACKS.find((x) => x.id === action.slice(5));
    if (!t) return { state: st, toast: 'That song isn\'t on this jukebox.' };
    if (st.queue.length >= QUEUE_MAX) return { state: st, toast: 'The queue is full. Wait for a song to finish.' };
    const entry = { id: t.id, title: t.title, artist: t.artist, mins: t.mins, by: firstName(actor) };
    st.plays++;
    if (!st.playing) { st.playing = { ...entry, endsAt: now + t.mins * 60000 }; say = `♪ Now playing “${t.title}” by ${t.artist}, picked by ${entry.by}`; }
    else { st.queue.push(entry); say = `♪ ${entry.by} queued “${t.title}”`; }
  } else if (action === 'skip' && st.playing) {
    say = `⏭ ${firstName(actor)} skipped “${st.playing.title}”`;
    st.playing.endsAt = now;
    advance();
  }
  return {
    state: st,
    say,
    display: st.playing
      ? { label: `♪ ${st.playing.title}`, glow: '#a78bfa', until: st.playing.endsAt, music: { id: st.playing.id, at: st.playing.endsAt - st.playing.mins * 60000 } }
      : { label: null },
    wakeAt: st.playing ? st.playing.endsAt : null,
    ui: {
      title: '🎵 Jukebox',
      text: st.playing ? `Now playing **${st.playing.title}** by ${st.playing.artist} (picked by ${st.playing.by}).\nPress N (or the ♪ button) to mute it for yourself.` : 'Nothing playing. Pick a song.',
      items: TRACKS.map((t) => ({ label: t.title, detail: `${t.artist} · ${t.mins} min`, action: `play:${t.id}` })),
      list: st.queue.length ? { title: 'Up next', rows: st.queue.map((q) => `${q.title} (${q.by})`) } : null,
      buttons: st.playing ? [{ label: 'Skip', action: 'skip' }] : [],
    },
  };
}

// ---- vending machine ----------------------------------------------------------
export const SNACKS = [
  { id: 'chips', label: 'Salt & Vinegar Chips', emoji: '🥔' },
  { id: 'choc', label: 'Dark Chocolate Bar', emoji: '🍫' },
  { id: 'gum', label: 'Mint Gum', emoji: '🍬' },
  { id: 'soda', label: 'Sparkling Water', emoji: '🥤' },
  { id: 'cookie', label: 'Giant Cookie', emoji: '🍪' },
];
const STOCK = 4;
const RESTOCK_MS = 30 * 60000;

export async function vending({ actor, action, state, now }) {
  const st = { stock: Object.fromEntries(SNACKS.map((s) => [s.id, STOCK])), sold: 0, restockAt: 0, ...state };
  if (st.restockAt && now >= st.restockAt) { for (const s of SNACKS) st.stock[s.id] = STOCK; st.restockAt = 0; }
  let say = null, toast = null;
  if (action.startsWith('buy:')) {
    const s = SNACKS.find((x) => x.id === action.slice(4));
    if (!s) return { state: st, toast: 'No such button.' };
    if (!st.stock[s.id]) toast = `${s.label} is sold out.`;
    // One in twenty gets stuck behind the glass, as is tradition.
    else if (Math.random() < 0.05) say = `*clunk*… ${firstName(actor)}'s ${s.label.toLowerCase()} is stuck. Classic.`;
    else {
      st.stock[s.id]--; st.sold++;
      say = `${s.emoji} *clunk* ${firstName(actor)} got ${s.label.toLowerCase()}`;
      if (Object.values(st.stock).every((n) => n === 0)) st.restockAt = now + RESTOCK_MS;
    }
  }
  const empty = Object.values(st.stock).every((n) => n === 0);
  return {
    state: st,
    say,
    toast,
    display: { label: empty ? 'sold out' : null, glow: empty ? '#ef4444' : '#38bdf8' },
    ui: {
      title: '🥤 Vending machine',
      text: empty ? 'Everything is sold out. A restock is on its way.' : `Snacks are on the house. ${st.sold} sold so far.`,
      items: SNACKS.map((s) => ({ label: `${s.emoji} ${s.label}`, detail: st.stock[s.id] ? `${st.stock[s.id]} left` : 'sold out', action: `buy:${s.id}`, disabled: !st.stock[s.id] })),
    },
  };
}

// ---- magic 8-ball ---------------------------------------------------------------
export const ANSWERS = [
  'It is certain.', 'Without a doubt.', 'Yes, definitely.', 'Ship it.', 'Most likely.', 'Outlook good.',
  'Signs point to yes.', 'Reply hazy, try again.', 'Ask again after standup.', 'Better not tell you now.',
  'Cannot predict now.', 'Concentrate and ask again.', 'Don\'t count on it.', 'My reply is no.',
  'Outlook not so good.', 'Very doubtful.', 'Only if the tests pass.', 'Put it in the backlog.',
];

export async function eightball({ actor, action, input, state }) {
  const st = { asked: 0, ...state };
  const ask = { title: '🎱 Magic 8-ball', text: 'Ask a yes-or-no question, then shake.', input: { placeholder: 'Will the deploy go smoothly?', action: 'ask', button: 'Shake', maxLength: 140 } };
  if (action !== 'ask') return { state: st, ui: ask };
  const q = String(input || '').trim();
  if (!q) return { state: st, ui: ask, toast: 'Ask it something first.' };
  st.asked++;
  const a = pick(ANSWERS);
  st.last = { q, a };
  return {
    state: st,
    say: `🎱 ${firstName(actor)} asked “${q}” … ${a}`,
    ui: { ...ask, text: `“${q}”\n\n**${a}**` },
  };
}

// ---- kiosk (agent-backed) ---------------------------------------------------------
// With a Workers AI binding (env.AI) the kiosk answers with a model; without one,
// or when the model call fails, it answers from KIOSK_HELP, so it never just breaks.
//
// To change what it knows or how it talks, edit KIOSK_PERSONA and KIOSK_HELP
// below, then `just plugins-deploy objects`. To try another model without a
// code change, set KIOSK_MODEL under [vars] in plugins/objects/wrangler.toml.
// Workers AI retires models now and then (llama-3.1-8b-instruct went on
// 2026-05-30), which is why there's a list: the first that answers wins.
export const KIOSK_MODELS = ['@cf/meta/llama-3.1-8b-instruct-fast', '@cf/zai-org/glm-4.7-flash', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
export const KIOSK_PERSONA = 'You are the friendly help kiosk in a virtual coworking office. Answer in at most two short sentences. If you don\'t know, say so and suggest asking someone nearby.';
export const KIOSK_HELP = {
  rooms: 'The office has the Deep Work Den, Phone Booths, Lobby, Open Office, Boardroom, Huddle Room, Kitchen and Lounge.',
  book: 'Walk up to a meeting room door and press E to book it, or use the Rooms button.',
  desk: 'Sit at any free desk in the Open Office and claim it. Your name stays on it between visits.',
  coffee: 'The coffee machine is in the Kitchen. Grab a mug and people nearby will know you\'re up for a chat.',
  focus: 'The Deep Work Den has a shared pomodoro timer. Chat there only reaches people right next to you.',
  arcade: 'Byte Snake lives in the Lounge, top right. High scores go on the board.',
  snack: 'The vending machine in the Kitchen has free snacks while stock lasts.',
  music: 'The jukebox in the Lounge plays whatever people queue on it.',
};

// Workers AI models answer in one of two shapes.
const replyText = (out) => String(out?.response ?? out?.choices?.[0]?.message?.content ?? '').trim();

async function askModel(env, messages) {
  const models = env.KIOSK_MODEL ? [env.KIOSK_MODEL, ...KIOSK_MODELS] : KIOSK_MODELS;
  const errors = [];
  for (const model of models) {
    try {
      const text = replyText(await env.AI.run(model, { messages, max_tokens: 200 }));
      if (text) return { text, model };
      errors.push(`${model}: empty answer`);
    } catch (e) { errors.push(`${model}: ${e?.message || e}`); }
  }
  console.error('kiosk AI failed:', errors.join(' | '));
  return { error: errors.join('; ') };
}

export async function kiosk({ object, actor, action, input, state, nearby }, env = {}) {
  const st = { questions: 0, ...state };
  const ui = (text) => ({ title: '🤖 Help kiosk', text, input: { placeholder: 'Ask the office anything…', action: 'ask', button: 'Ask', maxLength: 300 } });
  if (action !== 'ask') return { state: st, ui: ui(`Hi ${firstName(actor)}! Ask me where things are or how the office works.`) };
  const q = String(input || '').trim().slice(0, 300);
  if (!q) return { state: st, ui: ui('Type a question first.') };
  st.questions++;
  let answer = null, why = env.AI ? null : 'no Workers AI binding';
  if (env.AI) {
    const r = await askModel(env, [
      { role: 'system', content: `${KIOSK_PERSONA} You stand in the ${object?.zone || 'office'}. People near you: ${(nearby || []).map((p) => p.name).join(', ') || 'nobody'}. Facts: ${Object.values(KIOSK_HELP).join(' ')}` },
      { role: 'user', content: q },
    ]);
    answer = r.text || null;
    if (r.error) why = `Workers AI failed: ${r.error}`;
  }
  if (!answer) {
    const key = Object.keys(KIOSK_HELP).find((k) => q.toLowerCase().includes(k));
    answer = key ? KIOSK_HELP[key] : 'I\'m running in offline mode, so I only know the basics: try asking about rooms, booking, desks, coffee, focus, snacks, music or the arcade.';
  }
  // Only the asker sees why it's offline; everyone nearby hears the answer.
  return { state: st, say: `🤖 ${answer}`, ui: ui(`**You:** ${q}\n\n**Kiosk:** ${answer}${why ? `\n\n(offline: ${why.slice(0, 300)})` : ''}`) };
}

export const OBJECTS = { jukebox, vending, eightball, kiosk };
