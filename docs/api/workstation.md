# workstation (Workstation)

The computer on the desks: one per identity, so yours comes up at whichever desk you sit at. Holds notes, a todo list, bookmarks, a personal focus timer and the window layout, runs a small office shell, and hosts apps that run on plugin Workers. Always your own: the World names it after the caller, and you must be sitting at a desk.

- address `workstation:<name>`
- Durable Object binding `ACTOR` (class `ActorDO`)

## `view()`

`read-only` · `internal (entity to entity)`

Nothing: a workstation shows the office nothing.

## `desktop(who)`

`read-only` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_desktop`**

Your workstation: notes, todos, bookmarks, timer, layout and the apps you can open.

Returns `{ owner, guest, notes, todos, links, timer, prefs, apps }`

## `noteSave(who, note)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_noteSave`**

Write a note. Without an id it makes a new one (30 at most); with one it replaces that note.

| Param | Type | |
| --- | --- | --- |
| `note` | `{ id?, title?, text }` | The note |
| &nbsp;&nbsp;&nbsp;`note.id` *(optional)* | `string ≤ 200` | Note id, to change one |
| &nbsp;&nbsp;&nbsp;`note.title` *(optional)* | `string ≤ 80` | Title |
| &nbsp;&nbsp;&nbsp;`note.text` | `string ≤ 20000` | Text |

Returns `{ id, title, text, updated }`

## `noteDelete(who, id)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_noteDelete`**

Throw a note away.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 200` | Note id |

Returns `{ ok }`

## `todoAdd(who, text)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_todoAdd`**

Add something to your todo list (100 at most).

| Param | Type | |
| --- | --- | --- |
| `text` | `string ≤ 200` | What to do |

Returns `{ id, text, done, at }`

## `todoSet(who, todo)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_todoSet`**

Tick off, untick or reword a todo.

| Param | Type | |
| --- | --- | --- |
| `todo` | `{ id, done?, text? }` | The change |
| &nbsp;&nbsp;&nbsp;`todo.id` | `string ≤ 200` | Todo id |
| &nbsp;&nbsp;&nbsp;`todo.done` *(optional)* | `boolean` | Done |
| &nbsp;&nbsp;&nbsp;`todo.text` *(optional)* | `string ≤ 200` | New wording |

Returns `{ id, text, done, at }`

## `todoRemove(who, id)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_todoRemove`**

Remove a todo, or every finished one with id "done".

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 200` | Todo id, or "done" |

Returns `{ removed }`

## `linkAdd(who, link)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_linkAdd`**

Bookmark a page (http/https, or an office path like /docs).

| Param | Type | |
| --- | --- | --- |
| `link` | `{ url, title? }` | The bookmark |
| &nbsp;&nbsp;&nbsp;`link.url` | `string ≤ 500` | URL |
| &nbsp;&nbsp;&nbsp;`link.title` *(optional)* | `string ≤ 80` | Title |

Returns `{ id, title, url }`

## `linkRemove(who, id)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_linkRemove`**

Drop a bookmark.

| Param | Type | |
| --- | --- | --- |
| `id` | `string ≤ 200` | Link id |

Returns `{ ok }`

## `timerStart(who, timer)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_timerStart`**

Start your own focus timer. When it rings you get a note, even if you have left the office by then.

| Param | Type | |
| --- | --- | --- |
| `timer` | `{ minutes, label? }` | The timer |
| &nbsp;&nbsp;&nbsp;`timer.minutes` | `integer 1–240` | Minutes |
| &nbsp;&nbsp;&nbsp;`timer.label` *(optional)* | `string ≤ 60` | What it is for |

Returns `object | null`

## `timerStop(who)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_timerStop`**

Stop your focus timer.

Returns `{ ok }`

## `prefs(who, prefs)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · `internal (entity to entity)`

Keep the window layout and wallpaper (what the browser sends; 8 KB at most).

| Param | Type | |
| --- | --- | --- |
| `prefs` | `object` | Layout |

## `run(who, line)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_run`**

Run one line in the workstation shell (try "help"): who, desks, rooms, todo, notes, timer, links and more. Returns what it printed.

| Param | Type | |
| --- | --- | --- |
| `line` | `string ≤ 500` | The command line |

Returns `{ out, open?, url? }`

## `app(who, req)`

`mutates` · `caller filled in by the World` · `always the caller's own (the World picks the address)` · `caller must sit at a desk` · MCP tool **`workstation_app`**

Use an app that runs on a plugin Worker. `action` is "use" to open it or an action id from the panel it answered with; `input` is typed text.

| Param | Type | |
| --- | --- | --- |
| `req` | `{ app, action?, input? }` | What to do |
| &nbsp;&nbsp;&nbsp;`req.app` | `string ≤ 32` | App id (see desktop().apps) |
| &nbsp;&nbsp;&nbsp;`req.action` *(optional)* | `string ≤ 64 /^[\w:.-]{1,64}$/` | Action id |
| &nbsp;&nbsp;&nbsp;`req.input` *(optional)* | `string \| null` | Typed text |

Returns `object | null`

## Events

- sends `actor:<owner>`: a deliver message (a toast) when the focus timer rings
