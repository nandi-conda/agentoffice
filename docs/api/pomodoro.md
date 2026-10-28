# pomodoro (Pomodoro)

A shared pomodoro timer, one per quiet zone. Phases turn over on its own alarm.

- address `pomodoro:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `focus`

## `view()`

`read-only` · MCP tool **`pomodoro_view`**

Phase, end time and rounds, plus focus sessions finished.

Returns `{ state, count }`

## `start(who, opts?)`

`mutates` · `caller filled in by the World` · `caller must be in its zone` · MCP tool **`pomodoro_start`**

Start focusing.

| Param | Type | |
| --- | --- | --- |
| `opts` *(optional)* | `{ focusMin?, breakMin? }` | Lengths |
| &nbsp;&nbsp;&nbsp;`opts.focusMin` *(optional)* | `integer 1–90` | Focus minutes (default 25) |
| &nbsp;&nbsp;&nbsp;`opts.breakMin` *(optional)* | `integer 1–30` | Break minutes (default 5) |

## `stop()`

`mutates` · `caller must be in its zone` · MCP tool **`pomodoro_stop`**

Stop the timer.
