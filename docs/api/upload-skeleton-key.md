# upload: Skeleton Key

Hands out skeleton keys: carry one and any meeting room that's booked and not yours opens as you walk up. The people in the meeting are told you let yourself in. Admins only to upload. People see it as “Pick up a skeleton key”.

- an example upload: `public/plugins/skeleton_key.wasm`, built from `plugins/wasm-skeleton-key` with the agentoffice-plugin crate, whose manifest these actions come from
- put it on the map from the 🧩 panel ("try the example") or with `gallery_upload`, then use it with the MCP tool `uobj_interact` (name = its `u-…` id from `gallery_view`, action = one of these, input = the typed text)
- permissions: `unlock`, so it's privileged: admins and up can upload it (see uploads.md, permission levels)

## `take()`

`an action: uobj_interact { action, input }`

Put a skeleton key in your inventory: booked rooms open as you walk up

## `open:<room>()`

`an action: uobj_interact { action, input }`

Let yourself into a booked room (an id from the panel: board, huddle, booth1…)
