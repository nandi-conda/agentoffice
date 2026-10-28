# desk (Desk)

A desk, claimed by one owner with a goal. Claiming one lets go of any other desk you held (desks listen to each other on the desks topic). Someone else's desk frees up after 12 hours if they are not in.

- address `desk:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- 32: `desk-1`, `desk-2`, `desk-3`, `desk-4`, `desk-5`, `desk-6`, `desk-7`, `desk-8`, `desk-9`, `desk-10`, `desk-11`, `desk-12`, `desk-13`, `desk-14`, `desk-15`, `desk-16`, `desk-17`, `desk-18`, `desk-19`, `desk-20`, `desk-21`, `desk-22`, `desk-23`, `desk-24`, `desk-25`, `desk-26`, `den-2-5`, `den-5-5`, `den-8-5`, `den-2-8`, `den-5-8`, `den-8-8`

## `view()`

`read-only` · MCP tool **`desk_view`**

Who holds it.

Returns `object | null`

## `claim(who, goal?)`

`mutates` · `caller filled in by the World` · MCP tool **`desk_claim`**

Put your name and goal on the desk.

| Param | Type | |
| --- | --- | --- |
| `goal` *(optional)* | `string ≤ 80` | What you are working on |

Returns `{ ok, error? }`

## `goal(who, goal)`

`mutates` · `caller filled in by the World` · MCP tool **`desk_goal`**

Change the goal on your desk.

| Param | Type | |
| --- | --- | --- |
| `goal` | `string ≤ 80` | What you are working on |

Returns `{ ok, error? }`

## `release(who)`

`mutates` · `caller filled in by the World` · MCP tool **`desk_release`**

Give your desk up.

Returns `{ ok, error? }`

## `touch(key)`

`mutates` · `internal (entity to entity)`

The owner came in: keeps the desk from going stale.

| Param | Type | |
| --- | --- | --- |
| `key` | `string ≤ 200` | Owner key |

## Events

- publishes `desks`: { type: "claimed", owner, desk } when someone claims this desk
- subscribes `desks`: lets go of this desk when its owner claims another
