# arcade (Arcade)

The Byte Snake arcade cabinet and its top 20.

- address `arcade:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`arcade_view`**

The leaderboard.

Returns `{ name, score, ts }[]`

## `score(who, score)`

`mutates` · `caller filled in by the World` · MCP tool **`arcade_score`**

Submit a score.

| Param | Type | |
| --- | --- | --- |
| `score` | `integer 1–10000` | Score |
