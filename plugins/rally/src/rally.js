// Office Rally: a checkpoint race around the office, and the example of a
// plugin with real Durable Object logic behind it.
//
// Someone joins at the flag in the Lobby and a countdown starts; everyone who
// joins before it runs out races. The race picks a route of three areas
// (Kitchen, Lounge, Open Office…) in a random order, then back to the Lobby.
// Racers just walk there: the plugin answers `watch` with the route's zones,
// the office subscribes the object to those zones' enter events, and every
// time someone walks into one the plugin is called with `enter:<zone>`. The
// first three home win medals (inventory `give`), best times stay on the
// board forever, and the office's alarm (`wakeAt`) starts the race, warns
// at one minute left, and calls time.
//
// The game is written against a tiny key-value store with the Durable Object
// storage shape (get / put / delete / list({ prefix })), one key per thing:
//
//   round          { n, phase: idle|gathering|racing, startsAt, endsAt, route, racers, warned }
//   racer:<id>     { id, key, name, step, splits, finishedAt, place }   this round's racers
//   stats:<key>    { key, name, best, wins, podiums, races }            all-time, one per person
//   history        the last few rounds' results
//
// On Cloudflare that store is the plugin's own Durable Object (RallyRoom in
// index.js, one per object on the map), so the all-time board can grow past
// the 32 KB the office keeps for a plugin. A Durable Object runs one call at
// a time while it only touches its own storage, so each interact() is atomic
// without locks. Without the plugin Worker (the Node server, local dev) the
// office runs `rally()` below instead, which keeps the same keys in the
// object's `state`.

export const CHECKPOINTS = [
  { id: 'kitchen', name: 'Kitchen', emoji: '☕' },
  { id: 'lounge', name: 'Lounge', emoji: '🛋️' },
  { id: 'open', name: 'Open Office', emoji: '💻' },
  { id: 'focus', name: 'Deep Work Den', emoji: '🎧' },
  { id: 'booths', name: 'Phone Booths', emoji: '📞' },
];
export const HOME = { id: 'lobby', name: 'Lobby', emoji: '🏁' };
export const LEGS = 3; // checkpoints per race, before the run home
export const GATHER_MS = 20_000; // the countdown after the first racer joins
export const RACE_MS = 3 * 60_000; // time limit
export const WARN_MS = 60_000; // "one minute left"
export const MAX_RACERS = 12;
const BOARD = 10, HISTORY = 5;
const MEDALS = [
  { kind: 'rally:gold', name: 'Rally Gold Medal', emoji: '🥇' },
  { kind: 'rally:silver', name: 'Rally Silver Medal', emoji: '🥈' },
  { kind: 'rally:bronze', name: 'Rally Bronze Medal', emoji: '🥉' },
];
const GLOW = '#f59e0b';

const ZONE = Object.fromEntries([...CHECKPOINTS, HOME].map((z) => [z.id, z]));
const first = (name) => String(name || 'someone').split(/\s+/)[0];
// Who someone is across rounds: their DID when signed in, else their name.
const personKey = (a) => a.did || `name:${String(a.name || '').toLowerCase()}`;
export const clock = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const shuffle = (list, rand) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

export class Rally {
  // store: Durable Object storage, or anything with its get/put/delete/list.
  // maxStats caps the all-time board (the in-state fallback has 32 KB).
  constructor(store, { rand = Math.random, maxStats = Infinity } = {}) {
    this.store = store;
    this.rand = rand;
    this.maxStats = maxStats;
  }

  async round() { return (await this.store.get('round')) || { n: 0, phase: 'idle', route: [], racers: [] }; }
  async racers(round) {
    const all = await this.store.list({ prefix: 'racer:' });
    return round.racers.map((id) => all.get(`racer:${id}`)).filter(Boolean);
  }

  // One call from the office (docs/plugins.md). Returns the plugin answer.
  async interact({ actor, action = 'use', now }) {
    const round = await this.round();
    const me = round.racers.includes(actor.id) ? await this.store.get(`racer:${actor.id}`) : null;
    let out = {};
    if (action === 'tick') out = await this.tick(round, now);
    else if (action.startsWith('enter:')) out = await this.reached(round, me, action.slice(6), now);
    else if (action.startsWith('exit:')) out = {};
    else if (action === 'join') out = await this.join(round, me, actor, now);
    else if (action === 'leave') out = await this.leave(round, me, actor, now);
    else if (action === 'start') out = round.phase === 'gathering' && me ? await this.start(round, now) : { toast: 'Only someone in the next race can start it.' };
    else if (action === 'board') return { ui: await this.boardPanel() };
    // Events and ticks come from the office, not from a panel: no panel back.
    const event = action === 'tick' || action.startsWith('enter:') || action.startsWith('exit:');
    const after = await this.round();
    const ui = event ? undefined : await this.panel(after, actor, now);
    return { ...out, ui, display: this.display(after), wakeAt: this.wakeAt(after) };
  }

  // ---- phases ---------------------------------------------------------------------
  async join(round, me, actor, now) {
    if (me) return { toast: round.phase === 'racing' ? 'You\'re already racing! Go go go.' : 'You\'re in. Wait for the countdown.' };
    if (round.phase === 'racing') return { toast: 'A race is on. Join the next one when it\'s over.' };
    if (round.racers.length >= MAX_RACERS) return { toast: `The next race is full (${MAX_RACERS} racers).` };
    const say = round.phase === 'idle'
      ? `🏁 ${first(actor.name)} wants to race! Join at the flag in the Lobby: the rally starts in ${GATHER_MS / 1000} seconds.`
      : `🏁 ${first(actor.name)} joined the rally (${round.racers.length + 1} racing).`;
    if (round.phase === 'idle') Object.assign(round, { n: round.n + 1, phase: 'gathering', startsAt: now + GATHER_MS, endsAt: null, route: [], racers: [], warned: false });
    round.racers.push(actor.id);
    await this.store.put(`racer:${actor.id}`, { id: actor.id, key: personKey(actor), name: actor.name, step: 0, splits: [], finishedAt: null, place: null });
    await this.store.put('round', round);
    return { say };
  }

  async leave(round, me, actor, now) {
    if (!me) return { toast: 'You\'re not in this race.' };
    if (round.phase === 'racing') {
      if (me.finishedAt) return { toast: 'You already finished!' };
      me.gaveUp = true;
      await this.store.put(`racer:${me.id}`, me);
      const say = `🏳️ ${first(actor.name)} gave up.`;
      if (!(await this.everyoneDone(round))) return { say };
      const end = await this.finish(round, now);
      return { ...end, say: `${say}\n${end.say}` };
    }
    round.racers = round.racers.filter((id) => id !== me.id);
    await this.store.delete(`racer:${me.id}`);
    if (!round.racers.length) Object.assign(round, { phase: 'idle', startsAt: null });
    await this.store.put('round', round);
    return { toast: 'You left the next race.' };
  }

  async start(round, now) {
    if (!round.racers.length) {
      Object.assign(round, { phase: 'idle', startsAt: null });
      await this.store.put('round', round);
      return { say: '🏁 Nobody turned up for the rally.' };
    }
    const route = [...shuffle(CHECKPOINTS, this.rand).slice(0, LEGS).map((z) => z.id), HOME.id];
    Object.assign(round, { phase: 'racing', startsAt: now, endsAt: now + RACE_MS, route, warned: false });
    await this.store.put('round', round);
    const names = (await this.racers(round)).map((r) => first(r.name)).join(', ');
    return {
      say: `🏁 GO! Rally #${round.n}: ${route.map((z) => `${ZONE[z].emoji} ${ZONE[z].name}`).join(' → ')}. Racing: ${names}.`,
      // Tell the office which areas to report people walking into.
      watch: [...new Set(route)],
    };
  }

  // Someone walked into an area we're watching.
  async reached(round, me, zone, now) {
    if (round.phase !== 'racing' || !me || me.finishedAt || me.gaveUp) return {};
    if (round.route[me.step] !== zone) return {};
    me.step++;
    me.splits.push(now - round.startsAt);
    const done = me.step === round.route.length;
    let out;
    if (!done) {
      const next = ZONE[round.route[me.step]];
      out = { toast: `✓ ${ZONE[zone].name} (${me.step}/${round.route.length}). Next: ${next.emoji} ${next.name}${next.id === HOME.id ? ', back to the flag!' : ''}` };
    } else {
      me.finishedAt = now;
      const racers = await this.racers(round);
      me.place = racers.filter((r) => r.finishedAt && r.id !== me.id).length + 1;
      const ms = now - round.startsAt;
      const medal = MEDALS[me.place - 1];
      const stats = await this.stat(me);
      const record = stats.best == null || ms < stats.best;
      out = {
        say: `${medal?.emoji || '🏁'} ${first(me.name)} finished the rally ${ordinal(me.place)} in ${clock(ms)}${record ? stats.best == null ? '' : ', a personal best!' : ''}`,
        toast: `Finished ${ordinal(me.place)} in ${clock(ms)}.`,
        give: medal ? [{ ...medal, verb: 'shows off', data: { rally: round.n, ms } }] : [],
      };
    }
    await this.store.put(`racer:${me.id}`, me);
    if (done && (await this.everyoneDone(round))) {
      const end = await this.finish(round, now);
      out = { ...out, say: `${out.say}\n${end.say}`, watch: end.watch };
    }
    return out;
  }

  async tick(round, now) {
    if (round.phase === 'gathering' && now >= round.startsAt) return this.start(round, now);
    if (round.phase === 'racing' && now >= round.endsAt) return this.finish(round, now);
    if (round.phase === 'racing' && !round.warned && now >= round.endsAt - WARN_MS) {
      round.warned = true;
      await this.store.put('round', round);
      return { say: '⏱ One minute left in the rally!' };
    }
    return {};
  }

  async everyoneDone(round) { return (await this.racers(round)).every((r) => r.finishedAt || r.gaveUp); }

  // Call time: results, all-time stats, history, and stop watching.
  async finish(round, now) {
    const racers = await this.racers(round);
    const placed = racers.filter((r) => r.finishedAt).sort((a, b) => a.place - b.place);
    for (const r of racers) {
      const s = await this.stat(r);
      s.name = r.name;
      s.races++;
      if (r.finishedAt) {
        const ms = r.finishedAt - round.startsAt;
        if (s.best == null || ms < s.best) s.best = ms;
        if (r.place <= 3) s.podiums++;
        if (r.place === 1) s.wins++;
      }
      await this.store.put(`stats:${r.key}`, s);
      await this.store.delete(`racer:${r.id}`);
    }
    await this.trimStats();
    const results = placed.map((r) => ({ name: r.name, ms: r.finishedAt - round.startsAt, place: r.place }));
    const history = [{ n: round.n, at: now, route: round.route, results, dnf: racers.length - placed.length }, ...((await this.store.get('history')) || [])].slice(0, HISTORY);
    await this.store.put('history', history);
    await this.store.put('round', { n: round.n, phase: 'idle', route: [], racers: [] });
    const podium = results.slice(0, 3).map((r) => `${MEDALS[r.place - 1].emoji} ${first(r.name)} ${clock(r.ms)}`).join('  ');
    return { say: `🏁 Rally #${round.n} is over. ${podium || 'Nobody made it back in time!'}`, watch: [] };
  }

  async stat(r) { return (await this.store.get(`stats:${r.key}`)) || { key: r.key, name: r.name, best: null, wins: 0, podiums: 0, races: 0 }; }

  async leaderboard() {
    return [...(await this.store.list({ prefix: 'stats:' })).values()]
      .sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity) || b.wins - a.wins);
  }

  // The in-state fallback only has 32 KB: keep the best maxStats people.
  async trimStats() {
    const all = await this.leaderboard();
    for (const s of all.slice(this.maxStats)) await this.store.delete(`stats:${s.key}`);
  }

  // ---- what people see ------------------------------------------------------------
  display(round) {
    if (round.phase === 'gathering') return { label: `🏁 Rally #${round.n}: join now!`, glow: GLOW, until: round.startsAt };
    if (round.phase === 'racing') return { label: `🏁 Rally #${round.n} racing`, glow: '#ef4444', until: round.endsAt };
    return { label: null, glow: null };
  }

  wakeAt(round) {
    if (round.phase === 'gathering') return round.startsAt;
    if (round.phase === 'racing') return round.warned ? round.endsAt : round.endsAt - WARN_MS;
    return null;
  }

  async panel(round, actor, now) {
    const racers = await this.racers(round);
    const me = racers.find((r) => r.id === actor.id);
    const buttons = [];
    let text, list = null;
    if (round.phase === 'idle') {
      text = `Race around the office! Hit ${LEGS} checkpoints in the order the rally picks, then get back to the Lobby. Just walk there: the rally sees you arrive. The first three home win medals, and best times stay on the board.`;
      buttons.push({ label: 'Join the next race', action: 'join', primary: true });
      const last = (await this.store.get('history'))?.[0];
      if (last) list = { title: `Last race (#${last.n})`, rows: last.results.length ? last.results.map((r) => `${r.name}: ${clock(r.ms)}`) : ['Nobody made it back in time.'] };
    } else if (round.phase === 'gathering') {
      text = `Rally #${round.n} starts in **${Math.ceil(Math.max(0, round.startsAt - now) / 1000)} s**. ${me ? 'You\'re in! Stay close: the route is announced at the start.' : 'Join to race.'}`;
      buttons.push(me ? { label: 'Leave', action: 'leave' } : { label: 'Join', action: 'join', primary: true });
      if (me) buttons.push({ label: 'Start now', action: 'start', primary: true });
      list = { title: `Racers (${racers.length}/${MAX_RACERS})`, rows: racers.map((r) => r.name) };
    } else {
      const left = clock(round.endsAt - now).replace(/\.\d$/, '');
      const route = round.route.map((z, i) => `${me && me.step > i ? '✓' : me && me.step === i ? '➜' : '·'} ${ZONE[z].emoji} ${ZONE[z].name}${me?.splits[i] != null ? ` (${clock(me.splits[i])})` : ''}`);
      if (me && !me.finishedAt && !me.gaveUp) {
        const next = ZONE[round.route[me.step]];
        text = `Rally #${round.n}, ${left} left. Next: **${next.emoji} ${next.name}**.`;
        buttons.push({ label: 'Give up', action: 'leave' });
      } else if (me?.finishedAt) text = `You finished **${ordinal(me.place)}** in ${clock(me.finishedAt - round.startsAt)}. ${left} left for the others.`;
      else text = `Rally #${round.n} is on: ${racers.length} racing, ${left} left. Join the next one when it's over.`;
      list = me ? { title: 'Your route', rows: route } : { title: 'Standings', rows: standings(racers, round) };
    }
    buttons.push({ label: 'Leaderboard', action: 'board' });
    return { title: '🏁 Office Rally', text, list, buttons };
  }

  async boardPanel() {
    const top = (await this.leaderboard()).filter((s) => s.best != null).slice(0, BOARD);
    return {
      title: '🏆 Rally leaderboard',
      text: top.length ? 'Best times, all time.' : 'No times yet. Be the first!',
      list: top.length ? { title: 'Best times', rows: top.map((s) => `${s.name}: ${clock(s.best)} · ${s.wins} win${s.wins === 1 ? '' : 's'}, ${s.races} race${s.races === 1 ? '' : 's'}`) } : null,
      buttons: [{ label: 'Back', action: 'use', primary: true }],
    };
  }
}

const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const standings = (racers, round) => [...racers]
  .sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || b.step - a.step || (a.splits.at(-1) ?? 0) - (b.splits.at(-1) ?? 0))
  .map((r) => `${r.name}: ${r.finishedAt ? `${ordinal(r.place)}, ${clock(r.finishedAt - round.startsAt)}` : r.gaveUp ? 'gave up' : `${r.step}/${round.route.length}`}`);

// The same storage shape over a plain object, for the in-state fallback.
export class JsonStore {
  constructor(data) { this.data = data && typeof data === 'object' ? structuredClone(data) : {}; }
  async get(k) { return this.data[k] === undefined ? undefined : structuredClone(this.data[k]); }
  async put(k, v) { this.data[k] = structuredClone(v); }
  async delete(k) { const had = k in this.data; delete this.data[k]; return had; }
  async list({ prefix = '' } = {}) {
    return new Map(Object.keys(this.data).filter((k) => k.startsWith(prefix)).sort().map((k) => [k, structuredClone(this.data[k])]));
  }
}

// The office's built-in copy: the same game, its keys kept in the object's state.
export async function rally(req) {
  const store = new JsonStore(req.state?.kv);
  const out = await new Rally(store, { maxStats: 100 }).interact(req);
  return { ...out, state: { kv: store.data } };
}
