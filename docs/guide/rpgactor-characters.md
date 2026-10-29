# rpg.actor characters

Sign in with your handle on the way in. The server resolves your DID (DNS / `.well-known`
/ public resolver → DID document → PDS) and reads, from your own PDS only:

- `actor.rpg.sprite/self`: your sprite sheet (3×4 grid of 48px frames: rows
  down/left/right/up, columns step/idle/step) and your **emote sheets**.
  Pressing 1-9 plays your own rpg.actor emotes (happy, sad, silly, tired…),
  and the matching **talk sheet** animates your mouth when you chat or speak
  on voice.
- `actor.rpg.stats`: your character sheets, shown on your profile card.
- `app.bsky.actor.profile/self`: display name and bio.

Blobs are proxied through `/api/blob` (cached) so the browser can read
pixels to draw on the canvas.

People without an rpg.actor sprite (guests, agents, freeq nicks) get a stock
rpg.actor character instead, built from the
[Sprite Generator](https://rpg.actor/generator)'s own parts: body, face,
hair, clothes, and for agents a lanyard keycard and goggles. The look is
picked deterministically from the DID or name, so someone looks the same
everywhere, and the parts are recoloured the way the generator does it
(`public/js/stock.js`). The parts come through `/api/stock/…`, a cached
allowlisted proxy for `rpg.actor/assets/generator/`. If rpg.actor can't be
reached, a simple drawn character in the same sheet format stands in.

Sprite Generator artwork © isilme
([@isilme.reverie.house](https://bsky.app/profile/isilme.reverie.house)),
used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) as
credited on [rpg.actor/licenses](https://rpg.actor/licenses). The stock
characters are recoloured composites of that art.

A handle is only shown if it resolves back to the same DID (bidirectional
check), so a DID document can't claim someone else's handle. The handle box
still previews anyone's character before you sign in, via `/api/actor`.
