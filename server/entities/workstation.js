// The computer on every desk: sit down, press E, and your own workstation
// comes up, whichever desk you're at. One entity per identity
// (`workstation:<did>` or `workstation:agent:<name>`), hosted next to the
// actors: notes, a todo list, bookmarks, a personal focus timer, how the
// windows were laid out, a small shell, and apps run by plugin Workers.
//
// The address is never chosen by the caller: the World names it after
// whoever is calling (`self` in the api), so nobody can read or create
// someone else's. Guests get a throwaway one that lives with their
// connection (Office.guestStation).

import { Entity } from './runtime.js';
import { str, int, bool, arr, obj, opt } from './schema.js';
import { WS_APPS } from '../../public/js/apps.js';
import { zoneAt, ZONES } from '../../public/js/map.js';
import { fmtTime, fmtRange } from '../../public/js/rooms.js';
import { PluginHost } from '../plugins.js';

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, n);
const line = (s, n) => clip(s, n).replace(/\n/g, ' ').trim();
const shortId = () => crypto.randomUUID().slice(0, 8);

export const LIMITS = { notes: 30, noteText: 20000, todos: 100, links: 40, prefs: 8 * 1024, timerMin: 240 };
const COOLDOWN_MS = 300;
let builtins = null;

const NOTE = obj({ id: str('Note id'), title: str('Title', 80), text: str('Text', LIMITS.noteText), updated: int('ms since epoch', 0) });
const TODO = obj({ id: str('Todo id'), text: str('What to do', 200), done: bool('Done'), at: int('Added, ms since epoch', 0) });
const LINK = obj({ id: str('Link id'), title: str('Title', 80), url: str('http(s) URL', 500) });
const TIMER = { type: ['object', 'null'], description: '{ label, minutes, endsAt } while running' };
const DESKTOP = obj({
  owner: str('Whose workstation'), guest: bool('A guest\'s: gone when they leave'),
  notes: arr(NOTE, 'Notes, newest first'), todos: arr(TODO, 'Todo list'), links: arr(LINK, 'Bookmarks'),
  timer: TIMER, prefs: { type: ['object', 'null'], description: 'Window layout and wallpaper, as the browser left them' },
  apps: arr(obj({ id: str('App id'), name: str('Name'), icon: str('Emoji'), plugin: opt(str('Plugin it runs on')) }), 'Apps besides the built-in ones'),
});
const DESK = { self: true, who: true, atDesk: true };

export function cleanUrl(u) {
  u = String(u ?? '').trim();
  if (!u) return null;
  if (u.startsWith('/')) return u.slice(0, 500); // a page of the office itself (/docs…)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href.slice(0, 500) : null;
  } catch { return null; }
}

export class Workstation extends Entity {
  static doc = 'The computer on the desks: one per identity, so yours comes up at whichever desk you sit at. Holds notes, a todo list, bookmarks, a personal focus timer and the window layout, runs a small office shell, and hosts apps that run on plugin Workers. Always your own: the World names it after the caller, and you must be sitting at a desk.';
  static api = {
    view: { doc: 'Nothing: a workstation shows the office nothing.', internal: true },
    desktop: { doc: 'Your workstation: notes, todos, bookmarks, timer, layout and the apps you can open.', ...DESK, returns: DESKTOP },
    noteSave: { doc: 'Write a note. Without an id it makes a new one (30 at most); with one it replaces that note.', ...DESK, mutates: true,
      params: { note: obj({ id: opt(str('Note id, to change one')), title: opt(str('Title', 80)), text: str('Text', LIMITS.noteText) }, 'The note') }, returns: NOTE },
    noteDelete: { doc: 'Throw a note away.', ...DESK, mutates: true, params: { id: str('Note id') }, returns: obj({ ok: bool('Gone') }) },
    todoAdd: { doc: 'Add something to your todo list (100 at most).', ...DESK, mutates: true, params: { text: str('What to do', 200) }, returns: TODO },
    todoSet: { doc: 'Tick off, untick or reword a todo.', ...DESK, mutates: true,
      params: { todo: obj({ id: str('Todo id'), done: opt(bool('Done')), text: opt(str('New wording', 200)) }, 'The change') }, returns: TODO },
    todoRemove: { doc: 'Remove a todo, or every finished one with id "done".', ...DESK, mutates: true, params: { id: str('Todo id, or "done"') }, returns: obj({ removed: int('How many', 0) }) },
    linkAdd: { doc: 'Bookmark a page (http/https, or an office path like /docs).', ...DESK, mutates: true,
      params: { link: obj({ url: str('URL', 500), title: opt(str('Title', 80)) }, 'The bookmark') }, returns: LINK },
    linkRemove: { doc: 'Drop a bookmark.', ...DESK, mutates: true, params: { id: str('Link id') }, returns: obj({ ok: bool('Gone') }) },
    timerStart: { doc: 'Start your own focus timer. When it rings you get a note, even if you have left the office by then.', ...DESK, mutates: true,
      params: { timer: obj({ minutes: int('Minutes', 1, LIMITS.timerMin), label: opt(str('What it is for', 60)) }, 'The timer') }, returns: TIMER },
    timerStop: { doc: 'Stop your focus timer.', ...DESK, mutates: true, returns: obj({ ok: bool('Stopped') }) },
    prefs: { doc: 'Keep the window layout and wallpaper (what the browser sends; 8 KB at most).', ...DESK, mutates: true, internal: true,
      params: { prefs: { type: 'object', description: 'Layout' } } },
    run: { doc: 'Run one line in the workstation shell (try "help"): who, desks, rooms, todo, notes, timer, links and more. Returns what it printed.', ...DESK, mutates: true,
      params: { line: str('The command line', 500) }, returns: obj({ out: str('What it printed', 20000), open: opt(str('An app the browser should open')), url: opt(str('A page to open in the browser app')) }) },
    app: { doc: 'Use an app that runs on a plugin Worker. `action` is "use" to open it or an action id from the panel it answered with; `input` is typed text.', ...DESK, mutates: true,
      params: { req: obj({ app: str('App id (see desktop().apps)', 32), action: opt(str('Action id', 64, { pattern: '^[\\w:.-]{1,64}$' })), input: opt({ type: ['string', 'null'], maxLength: 500, description: 'Typed text' }) }, 'What to do') },
      returns: { type: ['object', 'null'], description: '{ ui, say, toast, via }: what the plugin answered; null when called again within 300 ms' } },
  };
  static events = { sends: { 'actor:<owner>': 'a deliver message (a toast) when the focus timer rings' } };

  constructor(host) {
    super(host);
    this.lastApp = 0;
  }

  get plugins() { return this.services.plugins || (builtins ||= new PluginHost()); }
  get notes() { return (this.state.notes ||= []); }
  get todos() { return (this.state.todos ||= []); }
  get links() { return (this.state.links ||= []); }

  view() { return null; }

  // Yours only: the World already names the entity after the caller, this
  // just makes sure nothing else does.
  mine(who) {
    if (!this.state.guest && who?.key !== this.name) throw new Error('not your workstation');
  }

  desktop(who) {
    this.mine(who);
    return {
      owner: this.name, guest: !!this.state.guest,
      notes: [...this.notes].sort((a, b) => b.updated - a.updated),
      todos: this.todos, links: this.links,
      timer: this.state.timer || null, prefs: this.state.prefs || null,
      apps: WS_APPS.map(({ id, name, icon, plugin }) => ({ id, name, icon, plugin })),
    };
  }

  async noteSave(who, { id, title, text = '' } = {}) {
    this.mine(who);
    let n = id && this.notes.find((x) => x.id === id);
    if (id && !n) throw new Error('no such note');
    if (!n) {
      if (this.notes.length >= LIMITS.notes) throw new Error(`${LIMITS.notes} notes at most: delete one first`);
      n = { id: shortId(), title: '', text: '', updated: 0 };
      this.notes.push(n);
    }
    n.text = clip(text, LIMITS.noteText);
    n.title = line(title ?? n.title, 80) || line(n.text.split('\n').find((l) => l.trim()) || 'Untitled', 80);
    n.updated = this.now();
    await this.save();
    return n;
  }

  async noteDelete(who, id) {
    this.mine(who);
    const before = this.notes.length;
    this.state.notes = this.notes.filter((n) => n.id !== id);
    await this.save();
    return { ok: this.notes.length < before };
  }

  async todoAdd(who, text) {
    this.mine(who);
    text = line(text, 200);
    if (!text) throw new Error('say what to do');
    if (this.todos.length >= LIMITS.todos) throw new Error(`${LIMITS.todos} todos at most: clear some first`);
    const t = { id: shortId(), text, done: false, at: this.now() };
    this.todos.push(t);
    await this.save();
    return t;
  }

  async todoSet(who, { id, done, text } = {}) {
    this.mine(who);
    const t = this.todos.find((x) => x.id === id);
    if (!t) throw new Error('no such todo');
    if (done !== undefined) t.done = !!done;
    if (text !== undefined && line(text, 200)) t.text = line(text, 200);
    await this.save();
    return t;
  }

  async todoRemove(who, id) {
    this.mine(who);
    const before = this.todos.length;
    this.state.todos = this.todos.filter((t) => (id === 'done' ? !t.done : t.id !== id));
    await this.save();
    return { removed: before - this.todos.length };
  }

  async linkAdd(who, { url, title } = {}) {
    this.mine(who);
    const href = cleanUrl(url);
    if (!href) throw new Error('only http(s) links or office paths like /docs');
    if (this.links.length >= LIMITS.links) throw new Error(`${LIMITS.links} bookmarks at most`);
    const l = { id: shortId(), url: href, title: line(title, 80) || href.replace(/^https?:\/\//, '').slice(0, 80) };
    this.links.push(l);
    await this.save();
    return l;
  }

  async linkRemove(who, id) {
    this.mine(who);
    const before = this.links.length;
    this.state.links = this.links.filter((l) => l.id !== id);
    await this.save();
    return { ok: this.links.length < before };
  }

  async timerStart(who, { minutes, label } = {}) {
    this.mine(who);
    const m = Math.round(Number(minutes));
    if (!(m >= 1 && m <= LIMITS.timerMin)) throw new Error(`1 to ${LIMITS.timerMin} minutes`);
    this.state.timer = { label: line(label, 60) || 'Focus', minutes: m, endsAt: this.now() + m * 60000 };
    await this.setAlarm(this.state.timer.endsAt);
    await this.save();
    return this.state.timer;
  }

  async timerStop(who) {
    this.mine(who);
    const had = !!this.state.timer;
    delete this.state.timer;
    await this.setAlarm(null);
    await this.save();
    return { ok: had };
  }

  // The timer rang: tell the owner, now or when they're next in.
  async alarm() {
    const t = this.state.timer;
    if (!t) return;
    if (t.endsAt > this.now() + 1000) return this.setAlarm(t.endsAt);
    delete this.state.timer;
    await this.save();
    if (this.state.guest) return;
    await this.tell(`actor:${this.name}`, 'deliver', { t: 'toast', text: `⏰ ${t.label}: your ${t.minutes}-minute timer is up.`, ws: 'timer' });
  }

  async prefs(who, prefs) {
    this.mine(who);
    const json = JSON.stringify(prefs ?? null);
    if (json.length > LIMITS.prefs) throw new Error('layout too big');
    this.state.prefs = JSON.parse(json);
    await this.save();
    return true;
  }

  // ---- apps on plugin Workers ------------------------------------------------
  // The same contract as the objects on the map (plugins/objects): the app
  // gets an object of its own (`ws-<app>`), keeps its state here, and answers
  // with a declarative panel. Nothing is said out loud: it's your screen.
  async app(who, { app, action = 'use', input = null } = {}) {
    this.mine(who);
    const a = WS_APPS.find((x) => x.id === app);
    if (!a?.plugin) throw new Error(`no app ${app}`);
    const now = this.now();
    if (now - this.lastApp < COOLDOWN_MS) return null;
    this.lastApp = now;
    const apps = (this.state.apps ||= {});
    const { result, state, via } = await this.plugins.interact({
      object: { id: `ws-${a.id}`, plugin: a.plugin, name: a.name, zone: who.zone || null },
      actor: who, action, input, state: apps[a.id] ?? null, nearby: [],
    });
    apps[a.id] = state;
    await this.save();
    return { ui: result.ui, say: result.say, toast: result.toast, via };
  }

  // ---- the shell ---------------------------------------------------------------
  async run(who, cmdline) {
    this.mine(who);
    const raw = line(cmdline, 500);
    const [cmd = '', ...rest] = raw.split(/\s+/);
    const arg = raw.slice(cmd.length).trim();
    const out = (s, extra = {}) => ({ out: String(s), ...extra });
    const fn = SHELL[cmd.toLowerCase()];
    if (!cmd) return out('');
    if (!fn) return out(`${cmd}: command not found (try help)`);
    try {
      return await fn.call(this, { who, arg, args: rest, out });
    } catch (e) {
      return out(`${cmd}: ${e.message}`);
    }
  }

  async office() {
    try { return await this.world.summary(); } catch { return { online: [], desks: {}, bookings: [] }; }
  }
}

const pad = (s, n) => String(s).padEnd(n);
const zoneName = (p) => zoneAt(p.x, p.y)?.name || 'Hallway';
const ago = (ms) => (ms < 60000 ? 'just now' : ms < 3600000 ? `${Math.round(ms / 60000)} min ago` : `${Math.round(ms / 3600000)} h ago`);
const pick = (list, n) => {
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || !list[i]) throw new Error(`no #${n} (see the numbers in the list)`);
  return list[i];
};

// Each command: ({ who, arg, args, out }) → { out, open?, url? }, `this` the workstation.
export const SHELL = {
  help: ({ out }) => out([
    'Office shell. Commands:',
    '  who                     who is in, and where',
    '  desks                   claimed desks and their goals',
    '  rooms [today|all]       meeting room bookings',
    '  todo                    your todo list',
    '  todo add <text>         add one        todo done <n>   tick #n',
    '  todo rm <n>             remove #n      todo clear      drop finished ones',
    '  notes                   your notes     cat <n>         print note #n',
    '  jot <text>              add a line to your "Scratch" note',
    '  timer <min> [label]     focus timer    timer stop',
    '  links                   bookmarks      bookmark <url> [title]',
    '  open <app|url>          open an app (notes, todo, browser, calendar, timer…) or a page',
    '  whoami, date, echo, clear',
  ].join('\n')),

  whoami: ({ who, out }) => out(`${who.name}${who.handle ? ` (@${who.handle})` : ''}\n${who.key}`),
  date: function ({ out }) { return out(new Date(this.now()).toUTCString()); },
  echo: ({ arg, out }) => out(arg),
  clear: ({ out }) => out('', { open: 'clear' }),

  who: async function ({ out }) {
    const { online = [] } = await this.office();
    if (!online.length) return out('Nobody is in.');
    return out(online.map((p) => `${pad(p.name, 20)} ${pad(p.kind, 6)} ${pad(zoneName(p), 16)} ${p.status || ''}${p.note ? `  “${p.note}”` : ''}`).join('\n'));
  },

  desks: async function ({ out }) {
    const { desks = {} } = await this.office();
    const rows = Object.entries(desks);
    if (!rows.length) return out('No desks claimed.');
    return out(rows.map(([id, d]) => `${pad(id, 12)} ${pad(d.name, 20)} ${d.goal || ''}  (${ago(this.now() - (d.seen || d.since || 0))})`).join('\n'));
  },

  rooms: async function ({ args, out }) {
    const { bookings = [] } = await this.office();
    const now = this.now(), dayEnd = new Date(now); dayEnd.setUTCHours(23, 59, 59, 999);
    const until = args[0] === 'all' ? Infinity : args[0] === 'today' ? dayEnd.getTime() : now + 86400000;
    const list = bookings.filter((b) => b.end > now && b.start < until);
    if (!list.length) return out('No bookings coming up. Book a room from its door or the Calendar app.');
    const name = (id) => ZONES.find((z) => z.id === id)?.name || id;
    return out(list.map((b) => `${b.start <= now ? '▶' : ' '} ${pad(fmtRange(b), 15)} ${pad(name(b.room), 14)} ${b.title}  (${b.name})`).join('\n') + '\n(times in UTC)');
  },

  todo: async function ({ who, args, arg, out }) {
    const sub = (args[0] || '').toLowerCase(), rest = arg.slice(sub.length).trim();
    if (sub === 'add') { await this.todoAdd(who, rest); }
    else if (sub === 'done' || sub === 'undo') { const t = pick(this.todos, rest); await this.todoSet(who, { id: t.id, done: sub === 'done' }); }
    else if (sub === 'rm') { await this.todoRemove(who, pick(this.todos, rest).id); }
    else if (sub === 'clear') { await this.todoRemove(who, 'done'); }
    else if (sub) throw new Error(`unknown "${sub}" (add, done, undo, rm, clear)`);
    if (!this.todos.length) return out('Nothing to do. todo add <text> to add something.');
    return out(this.todos.map((t, i) => `${pad(`${i + 1}.`, 4)}[${t.done ? 'x' : ' '}] ${t.text}`).join('\n'));
  },

  notes: function ({ out }) {
    const list = [...this.notes].sort((a, b) => b.updated - a.updated);
    if (!list.length) return out('No notes yet. jot <text>, or open notes.');
    return out(list.map((n, i) => `${pad(`${i + 1}.`, 4)}${pad(n.title, 40)} ${n.text.length} chars, ${ago(this.now() - n.updated)}`).join('\n'));
  },

  cat: function ({ args, out }) {
    const n = pick([...this.notes].sort((a, b) => b.updated - a.updated), args[0]);
    return out(`# ${n.title}\n${n.text}`);
  },

  jot: async function ({ who, arg, out }) {
    if (!arg) throw new Error('jot <text>');
    const n = this.notes.find((x) => x.title === 'Scratch');
    const stamp = fmtTime(this.now());
    await this.noteSave(who, { id: n?.id, title: 'Scratch', text: `${n ? `${n.text}\n` : ''}${stamp} ${arg}` });
    return out('Jotted down in Scratch.');
  },

  timer: async function ({ who, args, out }) {
    if (args[0] === 'stop') { await this.timerStop(who); return out('Timer stopped.'); }
    if (!args[0]) {
      const t = this.state.timer;
      return out(t ? `${t.label}: ${Math.max(0, Math.ceil((t.endsAt - this.now()) / 60000))} min left` : 'No timer. timer <minutes> [label]');
    }
    const t = await this.timerStart(who, { minutes: args[0], label: args.slice(1).join(' ') });
    return out(`${t.label}: ${t.minutes} min, rings at ${fmtTime(t.endsAt)} UTC.`);
  },

  links: function ({ out }) {
    if (!this.links.length) return out('No bookmarks. bookmark <url> [title]');
    return out(this.links.map((l, i) => `${pad(`${i + 1}.`, 4)}${pad(l.title, 32)} ${l.url}`).join('\n'));
  },

  bookmark: async function ({ who, args, out }) {
    const l = await this.linkAdd(who, { url: args[0], title: args.slice(1).join(' ') });
    return out(`Bookmarked ${l.title}.`);
  },

  open: function ({ args, out }) {
    const what = (args[0] || '').toLowerCase();
    if (!what) throw new Error('open <app|url>');
    if (BUILTIN_APPS.includes(what) || WS_APPS.some((a) => a.id === what)) return out(`Opening ${what}…`, { open: what });
    const url = cleanUrl(args[0]);
    if (!url) throw new Error(`no app or page "${args[0]}"`);
    return out(`Opening ${url}…`, { open: 'browser', url });
  },
};

// The apps the browser has built in (public/js/workstation.js), for `open`.
export const BUILTIN_APPS = ['notes', 'todo', 'terminal', 'browser', 'calendar', 'timer', 'share', 'inventory', 'settings'];
