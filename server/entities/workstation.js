// The computer on every desk: walk up to it, press E, and your own workstation
// comes up, whichever desk you're at. One entity per identity
// (`workstation:<did>` or `workstation:agent:<name>`), hosted next to the
// actors. What it does is a WASM program (plugins/wasm-workstation, built to
// public/plugins/workstation.wasm): notes, a todo list, bookmarks, a
// personal focus timer and a small shell. This entity is the host around it:
// it keeps the state, makes sure it's yours, rings the timer through your
// actor, keeps the window layout, gathers what the shell prints about the
// office, and runs the apps that are plugins of their own.
//
// The address is never chosen by the caller: the World names it after
// whoever is calling (`self` in the api), so nobody can read or create
// someone else's. Guests get a throwaway one that lives with their
// connection (Office.guestStation).

import { Entity } from './runtime.js';
import { str, int, bool, arr, obj, opt } from './schema.js';
import { WS_APPS } from '../../public/js/apps.js';
import { zoneAt, ZONES } from '../../public/js/map.js';
import { PluginHost } from '../plugins.js';

// The program's limits (plugins/wasm-workstation), for the api docs.
export const LIMITS = { notes: 30, noteText: 20000, todos: 100, links: 40, prefs: 8 * 1024, timerMin: 240 };
const COOLDOWN_MS = 300;
let offline = null;
// The program, and the parts of the state that are its.
const PROGRAM = { id: 'workstation', plugin: 'workstation', name: 'workstation', wasm: 'workstation.wasm' };
const DATA = ['notes', 'todos', 'links', 'timer'];

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

export class Workstation extends Entity {
  static doc = 'The computer on the desks: one per identity, so yours comes up at whichever desk you use. Holds notes, a todo list, bookmarks, a personal focus timer and the window layout, runs a small office shell, and hosts apps that run on WASM plugins. What it does is a WASM program itself (public/plugins/workstation.wasm). Always your own: the World names it after the caller, and you must be at a desk.';
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
    app: { doc: 'Use an app that runs on a WASM plugin. `action` is "use" to open it or an action id from the panel it answered with; `input` is typed text.', ...DESK, mutates: true,
      params: { req: obj({ app: str('App id (see desktop().apps)', 32), action: opt(str('Action id', 64, { pattern: '^[\\w:.-]{1,64}$' })), input: opt({ type: ['string', 'null'], maxLength: 500, description: 'Typed text' }) }, 'What to do') },
      returns: { type: ['object', 'null'], description: '{ ui, say, toast, via }: what the plugin answered; null when called again within 300 ms' } },
  };
  static events = { sends: { 'actor:<owner>': 'a deliver message (a toast) when the focus timer rings' } };

  constructor(host) {
    super(host);
    this.lastApp = 0;
    // One program call at a time: a Durable Object lets other calls in while
    // this one waits on the sandbox, and two at once would each start from
    // the same state and the second would undo the first.
    this.queue = Promise.resolve();
  }

  get plugins() { return this.services.plugins || (offline ||= new PluginHost()); }

  view() { return null; }

  // Yours only: the World already names the entity after the caller, this
  // just makes sure nothing else does.
  mine(who) {
    if (!this.state.guest && who?.key !== this.name) throw new Error('not your workstation');
  }

  // One method of the program, with its share of the state. Keeps what it
  // changed, and moves the timer's alarm when it asks to be woken elsewhere.
  program(who, method, args = null, { alarm = false } = {}) {
    const turn = this.queue.then(() => this.programTurn(who, method, args, alarm));
    this.queue = turn.catch(() => {});
    return turn;
  }

  async programTurn(who, method, args, alarm) {
    const state = Object.fromEntries(DATA.filter((k) => this.state[k] != null).map((k) => [k, this.state[k]]));
    const r = await this.plugins.program({ object: { ...PROGRAM, zone: who.zone || null }, actor: who, method, args, state, now: this.now() });
    const was = this.state.timer?.endsAt ?? null;
    if (r.state !== state) {
      for (const k of DATA) { if (r.state?.[k] != null) this.state[k] = r.state[k]; else delete this.state[k]; }
      await this.save();
    }
    if (alarm || r.wakeAt !== was) await this.setAlarm(r.wakeAt);
    return r;
  }

  async exec(who, method, args) {
    this.mine(who);
    return (await this.program(who, method, args)).reply;
  }

  async desktop(who) {
    const d = await this.exec(who, 'desktop');
    return {
      owner: this.name, guest: !!this.state.guest, ...d,
      prefs: this.state.prefs || null,
      apps: WS_APPS.map(({ id, name, icon, plugin }) => ({ id, name, icon, plugin })),
    };
  }

  noteSave(who, note = {}) { return this.exec(who, 'noteSave', note); }
  noteDelete(who, id) { return this.exec(who, 'noteDelete', { id }); }
  todoAdd(who, text) { return this.exec(who, 'todoAdd', { text }); }
  todoSet(who, todo = {}) { return this.exec(who, 'todoSet', todo); }
  todoRemove(who, id) { return this.exec(who, 'todoRemove', { id }); }
  linkAdd(who, link = {}) { return this.exec(who, 'linkAdd', link); }
  linkRemove(who, id) { return this.exec(who, 'linkRemove', { id }); }
  timerStart(who, timer = {}) { return this.exec(who, 'timerStart', timer); }
  timerStop(who) { return this.exec(who, 'timerStop'); }

  // The timer is due: the program rings it, and the owner gets its toast,
  // now or when they're next in.
  async alarm() {
    if (!this.state.timer) return;
    const { toast } = await this.program(OFFICE, 'tick', null, { alarm: true });
    if (!toast || this.state.guest) return;
    await this.tell(`actor:${this.name}`, 'deliver', { t: 'toast', text: toast, ws: 'timer' });
  }

  async prefs(who, prefs) {
    this.mine(who);
    const json = JSON.stringify(prefs ?? null);
    if (json.length > LIMITS.prefs) throw new Error('layout too big');
    this.state.prefs = JSON.parse(json);
    await this.save();
    return true;
  }

  // ---- apps on WASM plugins -------------------------------------------------
  // The same contract and modules as the objects on the map: the app
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
      object: { id: `ws-${a.id}`, plugin: a.plugin, name: a.name, zone: who.zone || null, wasm: a.wasm },
      actor: who, action, input, state: apps[a.id] ?? null, nearby: [],
    });
    apps[a.id] = state;
    await this.save();
    return { ui: result.ui, say: result.say, toast: result.toast, via };
  }

  // ---- the shell ---------------------------------------------------------------
  // The program runs the commands (try "help"); what they print about the
  // office comes from here, since WASM sees nothing of it.
  async run(who, line) {
    this.mine(who);
    const { online = [], desks = {}, bookings = [] } = await this.office();
    const room = (id) => ZONES.find((z) => z.id === id)?.name || id;
    const office = {
      online: online.map((p) => ({ name: p.name || '', kind: p.kind || '', zone: zoneAt(p.x, p.y)?.name || 'Hallway', status: p.status || '', note: p.note || '' })),
      desks: Object.entries(desks).map(([id, d]) => ({ id, name: d.name || '', goal: d.goal || '', seen: d.seen || d.since || 0 })),
      bookings: bookings.map((b) => ({ start: b.start, end: b.end, room: room(b.room), title: b.title || '', name: b.name || '' })),
    };
    return this.exec(who, 'run', { line, key: who.key || '', office, apps: [...BUILTIN_APPS, ...WS_APPS.map((a) => a.id)] });
  }

  async office() {
    try { return await this.world.summary(); } catch { return { online: [], desks: {}, bookings: [] }; }
  }
}

// Who the program sees on the timer's wake-up call: the office, not a person.
const OFFICE = { id: 'system', key: 'system', name: 'the office', handle: null, did: null, kind: 'system', zone: null };

// The apps the browser has built in (public/js/workstation.js), for `open`.
export const BUILTIN_APPS = ['notes', 'todo', 'terminal', 'browser', 'calendar', 'timer', 'share', 'inventory', 'settings'];
