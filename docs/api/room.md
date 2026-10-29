# room (Room)

Retired: a meeting room's bookings, as they were before its door panel (a WASM plugin, plugin:panel-<room>) took them over. Kept only for that takeover.

- address `room:<name>`
- Durable Object binding `ROOM` (class `RoomDO`)

## `view()`

`read-only` · `internal (entity to entity)`

The bookings it kept.

Returns `{ id, room, title, start, end }[]`

## `retire()`

`mutates` · `internal (entity to entity)`

Stop listening on its zone: the panel that took over its bookings does now.
