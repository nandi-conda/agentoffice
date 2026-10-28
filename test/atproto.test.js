import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeActor, parseDidDoc, isHandle, isDid } from '../server/atproto.js';

test('parses the PDS and handle from a DID document', () => {
  const r = parseDidDoc({
    alsoKnownAs: ['at://ada.example.com'],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com/' }],
  });
  assert.deepEqual(r, { pds: 'https://pds.example.com', handle: 'ada.example.com' });
});

test('validates handles and DIDs', () => {
  assert.ok(isHandle('ada.bsky.social'));
  assert.ok(!isHandle('not a handle'));
  assert.ok(isDid('did:plc:j5kbwhmd443ek6crecv66bzu'));
  assert.ok(!isDid('did:evil:x'));
});

test('shapes an rpg.actor sprite record with emotes', () => {
  const sprite = {
    $type: 'actor.rpg.sprite', columns: 3, rows: 4, frameWidth: 48, frameHeight: 48,
    spriteSheet: { $type: 'blob', ref: { $link: 'bafkreisheet' }, mimeType: 'image/png' },
    emotes: {
      happy: { label: 'Happy', emoteSheet: { ref: { $link: 'bafkreihappy' } }, talkSheet: { ref: { $link: 'bafkreitalk' } } },
      generatedAt: '2026-10-28T17:46:31.242Z',
      version: 'rpg.actor.emote.006',
    },
  };
  const a = shapeActor({ did: 'did:plc:j5kbwhmd443ek6crecv66bzu', handle: 'ada.test', sprite, stats: [{ uri: 'at://x/actor.rpg.stats/dnd5e', value: { system: 'dnd5e', data: { _meta: { name: 'Ada' }, level: 3, class: 'Wizard' } } }], profile: { displayName: 'Ada' } });
  assert.match(a.sprite.sheet, /cid=bafkreisheet/);
  assert.deepEqual(Object.keys(a.sprite.emotes), ['happy']);
  assert.match(a.sprite.emotes.happy.talk, /bafkreitalk/);
  assert.equal(a.stats[0].name, 'Ada');
  assert.deepEqual(a.stats[0].summary, [['level', 3], ['class', 'Wizard']]);
});

test('missing sprite falls back to null', () => {
  const a = shapeActor({ did: 'did:plc:j5kbwhmd443ek6crecv66bzu', handle: 'x.test', sprite: null, stats: [], profile: null });
  assert.equal(a.sprite, null);
});
