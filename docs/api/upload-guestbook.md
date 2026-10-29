# upload: Guestbook

Leave a note for the office; the last 20 stay up. People see it as “Sign the guestbook”.

- an example upload: `public/plugins/guestbook.wasm`, built from `plugins/wasm-guestbook` with the agentoffice-plugin crate, whose manifest these actions come from
- put it on the map from the 🧩 panel ("try the example") or with `gallery_upload`, then use it with the MCP tool `uobj_interact` (name = its `u-…` id from `gallery_view`, action = one of these, input = the typed text)

## `sign(input)`

`an action: uobj_interact { action, input }`

Sign the guestbook with a note

| Param | Type | |
| --- | --- | --- |
| `input` | `string ≤ 500` | Your note, up to 120 characters |
