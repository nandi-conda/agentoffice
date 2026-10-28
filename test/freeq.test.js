import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Office } from '../server/office.js';
import { FreeqBridge, IrcClient, parseLine, saslLines, loadIdentity, cryptoResponder, oauthResponder, didKeyFor, base58btc, unb64url, b64url, parseRooms, ircNick } from '../server/freeq.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
const enc = new TextEncoder();

// A pretend freeq: just enough IRC to register, run SASL ATPROTO-CHALLENGE
// the way irc.freeq.at does, and route channel messages between sockets.
function fakeFreeq({ verify }) {
  const conns = new Set();
  const members = new Map(); // channel -> Set(conn)
  const server = {
    conns, members, sent: [],
    open() {
      const listeners = {};
      const c = { nick: null, buf: '', readyState: 1, account: null };
      const emit = (type, ev) => (listeners[type] || []).forEach((f) => f(ev));
      const out = (line) => emit('message', { data: line });
      c.socket = {
        get readyState() { return c.readyState; },
        addEventListener: (t, f) => (listeners[t] ||= []).push(f),
        send: (line) => handle(line),
        close: () => { c.readyState = 3; conns.delete(c); for (const s of members.values()) s.delete(c); },
      };
      c.out = out;
      conns.add(c);
      let challenge = null;
      async function handle(line) {
        server.sent.push(line);
        const m = parseLine(line);
        if (m.command === 'CAP' && m.params[0] === 'LS') return out(':irc.freeq.at CAP * LS :sasl=ATPROTO-CHALLENGE message-tags account-tag extended-join');
        if (m.command === 'CAP' && m.params[0] === 'REQ') return out(`:irc.freeq.at CAP * ACK :${m.params[1]}`);
        if (m.command === 'CAP' && m.params[0] === 'END') return out(`:irc.freeq.at 001 ${c.nick} :Welcome`);
        if (m.command === 'NICK') { c.nick = m.params[0]; return; }
        if (m.command === 'AUTHENTICATE' && m.params[0] === 'ATPROTO-CHALLENGE') {
          challenge = enc.encode(JSON.stringify({ session_id: 's1', nonce: 'n' + Math.random(), timestamp: 1 }));
          return out(`AUTHENTICATE ${b64url(challenge)}`);
        }
        if (m.command === 'AUTHENTICATE') {
          c.saslBuf = (c.saslBuf || '') + (m.params[0] === '+' ? '' : m.params[0]);
          if (m.params[0].length === 400) return;
          const reply = JSON.parse(new TextDecoder().decode(unb64url(c.saslBuf)));
          c.saslBuf = '';
          const r = await verify(reply, challenge);
          if (r?.nonce) {
            out(`:irc.freeq.at NOTICE * :DPOP_NONCE ${r.nonce}`);
            challenge = enc.encode(JSON.stringify({ session_id: 's1', nonce: 'n2', timestamp: 2 }));
            return out(`AUTHENTICATE ${b64url(challenge)}`);
          }
          if (!r) return out(`:irc.freeq.at 904 ${c.nick} :SASL authentication failed`);
          c.account = reply.did;
          out(`:irc.freeq.at 900 ${c.nick} :You are now logged in as ${reply.did}`);
          return out(`:irc.freeq.at 903 ${c.nick} :SASL authentication successful`);
        }
        if (m.command === 'JOIN') {
          const ch = m.params[0];
          if (!members.has(ch)) members.set(ch, new Set());
          members.get(ch).add(c);
          for (const o of members.get(ch)) o.out(`:${c.nick}!u@h JOIN ${ch} ${c.account || '*'} :x`);
          return out(`:irc.freeq.at 353 ${c.nick} = ${ch} :${[...members.get(ch)].map((o) => o.nick).join(' ')}`);
        }
        if (m.command === 'PRIVMSG') {
          for (const o of members.get(m.params[0]) || []) if (o !== c) o.out(`@account=${c.account} :${c.nick}!u@h PRIVMSG ${m.params[0]} :${m.params[1]}`);
        }
      }
      return c;
    },
    // Someone on freeq (not the office) talks.
    outsider(nick, did) {
      const c = server.open();
      c.nick = nick; c.account = did;
      return {
        join: (ch) => c.socket.send(`JOIN ${ch}`),
        say: (ch, text) => c.socket.send(`PRIVMSG ${ch} :${text}`),
      };
    },
  };
  return server;
}

test('IRC line parsing with tags, prefix and trailing', () => {
  const m = parseLine('@account=did:plc:abc;time=2026 :alice!a@h PRIVMSG #general :hello there');
  assert.equal(m.command, 'PRIVMSG');
  assert.equal(m.nick, 'alice');
  assert.deepEqual(m.params, ['#general', 'hello there']);
  assert.equal(m.tags.account, 'did:plc:abc');
  assert.deepEqual(parseLine('PING :x').params, ['x']);
});

test('SASL responses are split in 400-byte pieces', () => {
  assert.deepEqual(saslLines('abc'), ['AUTHENTICATE abc']);
  const full = 'x'.repeat(800);
  assert.deepEqual(saslLines(full).map((l) => l.length), [413, 413, 14]);
  assert.equal(saslLines('y'.repeat(401)).length, 2);
});

test('did:key encodes ed25519 keys the standard way', () => {
  assert.equal(base58btc(new Uint8Array([0, 0, 1])), '112');
  const did = didKeyFor(new Uint8Array(32));
  assert.match(did, /^did:key:z6Mk/);
});

test('the listener signs the exact challenge bytes with its did:key', async () => {
  let jwk = null;
  const id = await loadIdentity({ get: async () => jwk, set: async (j) => { jwk = j; } });
  const again = await loadIdentity({ get: async () => jwk, set: async () => assert.fail('regenerated') });
  assert.equal(again.did, id.did);
  const challenge = enc.encode('{"session_id":"a","nonce":"b","timestamp":1}');
  const reply = await cryptoResponder(id)(challenge);
  assert.equal(reply.method, 'crypto');
  // Verify with the public key carried in the did:key itself.
  const pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify('Ed25519', pub, unb64url(reply.signature), challenge));
});

test('a person signs in with pds-oauth, retrying with the DPoP nonce freeq relays', async () => {
  const proofs = [];
  const server = fakeFreeq({
    verify: async (r, ch) => {
      assert.equal(r.method, 'pds-oauth');
      assert.equal(r.challenge_nonce, JSON.parse(new TextDecoder().decode(ch)).nonce);
      proofs.push(r.dpop_proof);
      return proofs.length === 1 ? { nonce: 'pds-nonce-1' } : true;
    },
  });
  const creds = async (nonce) => ({ did: 'did:plc:alice', pds: 'https://pds.example', accessToken: 'tok'.repeat(300), dpopProof: `proof(${nonce})` });
  const irc = new IrcClient({ openSocket: async () => server.open().socket, nick: 'alice', respond: oauthResponder(creds) });
  const who = await irc.open();
  assert.equal(who.did, 'did:plc:alice');
  assert.deepEqual(proofs, ['proof(null)', 'proof(pds-nonce-1)']);
  // The response was long enough to be chunked.
  assert.ok(server.sent.filter((l) => l.startsWith('AUTHENTICATE ') && l.length === 413).length > 1);
});

test('populated channels attach to areas, and talk flows both ways', async () => {
  const server = fakeFreeq({ verify: async (r) => r.method === 'crypto' || r.method === 'pds-oauth' });
  const office = new Office({}, { loadActor: null });
  const said = [];
  const auth = { freeqCredentials: async (did) => ({ did, pds: 'https://pds.example', accessToken: 't', dpopProof: 'p' }) };
  let jwk = null;
  const bridge = new FreeqBridge({
    office, auth, log: () => {},
    openSocket: async () => server.open().socket,
    keyStore: { get: async () => jwk, set: async (j) => { jwk = j; } },
    fetch: async () => new Response(JSON.stringify([
      { name: '#provisio', members: 9 }, { name: '#general', members: 3 }, { name: '#quiet', members: 1 },
    ])),
  });
  const bob = server.outsider('bob', 'did:plc:bob');
  bob.join('#general');

  // A signed-in person walks into the Lounge.
  const sock = { readyState: 1, send: (s) => said.push(JSON.parse(s)) };
  const me = office.open(sock, { did: 'did:plc:alice' });
  await office.handle(me, { t: 'hello', name: 'Alice' });
  await bridge.start();
  await tick();
  assert.equal(bridge.bindings.get('lounge')?.channel, '#general'); // its natural home
  assert.equal(bridge.bindings.get('open')?.channel, '#provisio'); // biggest one next
  assert.ok(![...bridge.bindings.values()].some((b) => b.channel === '#quiet'));
  assert.ok(said.some((m) => m.t === 'freeq' && m.rooms.lounge.channel === '#general'));
  // bob is drawn in the Lounge.
  const bobPeer = [...office.peers.values()].find((p) => p.kind === 'freeq' && p.name === 'bob');
  assert.ok(bobPeer);
  me.x = 36; me.y = 25; // Lounge

  // freeq -> office
  bob.say('#general', 'hi office');
  await tick();
  const heard = said.find((m) => m.t === 'chat' && m.text === 'hi office');
  assert.equal(heard?.scope, '#general');
  assert.equal(heard?.id, bobPeer.id);

  // office -> freeq, as Alice's own connection (not the listener)
  const bobGot = [];
  const bobConn = [...server.conns].find((c) => c.nick === 'bob');
  bobConn.out = (l) => bobGot.push(l);
  await office.handle(me, { t: 'chat', text: 'hello freeq' });
  for (let i = 0; i < 20 && !bobGot.some((l) => l.includes('hello freeq')); i++) await tick();
  const line = bobGot.find((l) => l.includes('PRIVMSG #general :hello freeq'));
  assert.ok(line, 'bob should hear Alice');
  assert.match(line, /account=did:plc:alice/);
  // ...and the listener doesn't echo Alice back into the office.
  await tick();
  assert.equal(said.filter((m) => m.t === 'chat' && m.text === 'hello freeq').length, 1);

  // Guests stay local and are told why.
  const gsaid = [];
  const guest = office.open({ readyState: 1, send: (s) => gsaid.push(JSON.parse(s)) });
  await office.handle(guest, { t: 'hello', name: 'Gus' });
  guest.x = 36; guest.y = 26;
  await office.handle(guest, { t: 'chat', text: 'can anyone hear me' });
  await tick();
  assert.ok(gsaid.some((m) => m.t === 'toast' && /signed-in/.test(m.text)));

  // Everyone leaves: the person's connection hangs up.
  office.leave(me);
  assert.ok(!bridge.users.has('did:plc:alice'));
  bridge.stop();
  assert.equal(bridge.bindings.size, 0);
  assert.ok(![...office.peers.values()].some((p) => p.kind === 'freeq'));
});

test('someone in several channels is one person, standing where they last spoke', async () => {
  const server = fakeFreeq({ verify: async () => true });
  const office = new Office({}, { loadActor: null });
  let jwk = null;
  const bridge = new FreeqBridge({
    office, log: () => {},
    openSocket: async () => server.open().socket,
    keyStore: { get: async () => jwk, set: async (j) => { jwk = j; } },
    fetch: async () => new Response(JSON.stringify([{ name: '#general', members: 3 }, { name: '#dev', members: 3 }])),
  });
  const bob = server.outsider('bob', 'did:plc:bob');
  bob.join('#general'); bob.join('#dev');
  const said = [];
  const me = office.open({ readyState: 1, send: (s) => said.push(JSON.parse(s)) });
  await office.handle(me, { t: 'hello', name: 'Alice' });
  await bridge.start();
  await tick();
  const bobs = () => [...office.peers.values()].filter((p) => p.kind === 'freeq' && p.name === 'bob');
  assert.equal(bobs().length, 1);
  const p = bobs()[0];
  const first = p.freeqZone;
  assert.match(p.note, /also #/);

  // Speaking in the other channel walks bob over there.
  const other = first === 'lounge' ? '#dev' : '#general';
  bob.say(other, 'over here now');
  await tick();
  assert.equal(p.freeqZone, bridge.zoneFor(other));
  assert.equal(p.note.split(' ')[0], other);
  assert.ok(said.some((m) => m.t === 'move' && m.id === p.id));

  // Leaving that channel sends him back to the one he's still in.
  bridge.onListenerLine(parseLine(`:bob!b@h PART ${other}`));
  assert.equal(p.freeqZone, first);
  assert.ok(!/also/.test(p.note));
  bridge.onListenerLine(parseLine(`:bob!b@h QUIT :bye`));
  assert.equal(bobs().length, 0);
  bridge.stop();
});

test('fixed area mapping and nick cleanup', () => {
  assert.deepEqual([...parseRooms('lounge=#general, open=dev, nowhere=#x')], [['lounge', '#general'], ['open', '#dev']]);
  assert.equal(ircNick('alice.bsky.social'), 'alice');
  assert.equal(ircNick('9lives.example'), 'lives');
  assert.equal(ircNick(''), 'office');
});

