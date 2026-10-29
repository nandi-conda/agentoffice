# MoQ web components (moq-publish, moq-watch)

Built bundles of `@moq/publish/element` and `@moq/watch/element` (moq-dev/moq,
@moq/hang 0.2.5), copied unchanged from freeq's `freeq-server/static/av/assets/`
(github.com/chad/freeq @ ce43e1b). They're the exact builds freeq's own web app
loads, so the office speaks the same moq-lite version as freeq's SFU and its
clients. Used by `public/js/freeq-av.js` for calls in freeq-bridged channel rooms.

freeq is MIT licensed (see LICENSE); moq-dev/moq is MIT / Apache-2.0.
To update, copy the new files from freeq and change the names in freeq-av.js.
