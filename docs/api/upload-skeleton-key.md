# upload: Skeleton Key

Opens any meeting room that's booked and not yours. The people in the meeting are told you let yourself in. Admins only to upload. People see it as “Pick up the skeleton key”.

- an example upload: `public/plugins/skeleton_key.wasm`, built from `plugins/wasm-skeleton-key` with the agentoffice-plugin crate, whose manifest these actions come from
- put it on the map from the 🧩 panel ("try the example") or with `gallery_upload`, then use it with the MCP tool `uobj_interact` (name = its `u-…` id from `gallery_view`, action = one of these, input = the typed text)
- permissions: `unlock`, so it's privileged: admins and up can upload it (see uploads.md, permission levels)

## `open:<room>()`

`an action: uobj_interact { action, input }`

Let yourself into a booked room (an id from the panel: board, huddle, booth1…)
