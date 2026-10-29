import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Office } from '../server/office.js';
import { LocalRuntime } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';
import { ZONES, isBlocked } from '../public/js/map.js';
import { FreeqBridge, IrcClient, parseLine, saslLines, loadIdentity, cryptoResponder, oauthResponder, didKeyFor, base58btc, unb64url, b64url, parseRooms, ircNick } from '../server/freeq.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
// Stand someone on a free tile inside a zone (a channel's room is ch-<name>).
function stand(p, zoneId) {
  const z = ZONES.find((x) => x.id === zoneId);
  assert.ok(z, `no zone ${zoneId}`);
  for (let y = z.y0; y <= z.y1; y++) for (let x = z.x0; x <= z.x1; x++) if (!isBlocked(x, y)) { p.x = x + 0.5; p.y = y + 0.5; return; }
  assert.fail(`nowhere to stand in ${zoneId}`);
}
const enc = new TextEncoder();

// A pretend freeq: just enough IRC to register, run SASL ATPROTO-CHALLENGE
// the way irc.freeq.at does, and route channel messages between sockets.
function fakeFreeq({ verify }) {
  const conns = new Set();
  const members = new Map(); // channel -> Set(conn)
  const history = new Map(); // channel -> [{ id, sender, text, timestamp, msgid, tags }]
  let n = 0;
  const server = {
    conns, members, history, sent: [],
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
          out(`:irc.freeq.at 353 ${c.nick} = ${ch} :${[...members.get(ch)].map((o) => o.nick).join(' ')}`);
          return out(`:irc.freeq.at 366 ${c.nick} ${ch} :End of /NAMES list`);
        }
        if (m.command === 'NAMES') {
          const ch = m.params[0];
          out(`:irc.freeq.at 353 ${c.nick} = ${ch} :${[...(members.get(ch) || [])].map((o) => o.nick).join(' ')}`);
          return out(`:irc.freeq.at 366 ${c.nick} ${ch} :End of /NAMES list`);
        }
        if (m.command === 'PART') {
          for (const o of members.get(m.params[0]) || []) o.out(`:${c.nick}!u@h PART ${m.params[0]}`);
          members.get(m.params[0])?.delete(c);
          return;
        }
        if (m.command === 'PRIVMSG') {
          const ch = m.params[0], at = new Date(), msgid = `m${++n}`;
          if (!history.has(ch)) history.set(ch, []);
          history.get(ch).push({ id: n, sender: c.nick, text: m.params[1], timestamp: Math.floor(at / 1000), msgid, tags: { account: c.account } });
          for (const o of members.get(ch) || []) if (o !== c) o.out(`@account=${c.account};msgid=${msgid};time=${at.toISOString()} :${c.nick}!u@h PRIVMSG ${ch} :${m.params[1]}`);
        }
      }
      return c;
    },
    // freeq's REST API: the channel list and per-channel history.
    fetch: (list) => async (url) => {
      const h = String(url).match(/\/channels\/([^/]+)\/history/);
      if (h) return new Response(JSON.stringify([...(history.get(decodeURIComponent(h[1])) || [])].reverse()));
      return new Response(JSON.stringify(list));
    },
    // Someone on freeq (not the office) talks.
    outsider(nick, did) {
      const c = server.open();
      c.nick = nick; c.account = did;
      return {
        join: (ch) => c.socket.send(`JOIN ${ch}`),
        part: (ch) => c.socket.send(`PART ${ch}`),
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

test('SASL responses go on one line unless they exceed freeq\'s line limit', () => {
  assert.deepEqual(saslLines('abc'), ['AUTHENTICATE abc']);
  // A pds-oauth response (token + DPoP proof) is a few KB: still one line,
  // because freeq servers before 2026-10-19 decode every line on its own.
  assert.deepEqual(saslLines('x'.repeat(3000)).map((l) => l.length), [3013]);
  assert.equal(saslLines('y'.repeat(8177)).length, 1);
  // Past the limit: 400-byte pieces, then "+" after a final full piece.
  assert.deepEqual(saslLines('z'.repeat(8400)).map((l) => l.length).slice(-2), [413, 14]);
  assert.equal(saslLines('z'.repeat(8400)).length, 22);
  assert.deepEqual(saslLines(''), ['AUTHENTICATE +']);
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
  // Each answer is one line that decodes to JSON on its own, the way an
  // irc.freeq.at that predates SASL reassembly reads it.
  const answers = server.sent.filter((l) => l.startsWith('AUTHENTICATE ') && l !== 'AUTHENTICATE ATPROTO-CHALLENGE');
  assert.equal(answers.length, 2);
  for (const l of answers) assert.equal(JSON.parse(new TextDecoder().decode(unb64url(l.slice(13)))).method, 'pds-oauth');
});

test('populated channels get their own rooms off the hallway, and talk flows both ways', async () => {
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
  assert.equal(bridge.bindings.get('ch-general')?.channel, '#general');
  assert.equal(bridge.bindings.get('ch-provisio')?.channel, '#provisio');
  assert.ok(![...bridge.bindings.values()].some((b) => b.channel === '#quiet'));
  assert.ok(said.some((m) => m.t === 'freeq' && m.rooms['ch-general'].channel === '#general'));
  // The rooms are part of everyone's map, the busiest one biggest.
  const wing = said.filter((m) => m.t === 'wing').pop().rooms;
  assert.deepEqual(wing.map((r) => r.channel).sort(), ['#general', '#provisio']);
  assert.equal(wing.find((r) => r.channel === '#provisio').tier, 'm'); // 9 minus the listener
  assert.equal(wing.find((r) => r.channel === '#general').tier, 's');
  assert.equal(ZONES.find((z) => z.id === 'ch-general').kind, 'room');
  // bob is drawn in the Lounge.
  const bobPeer = [...office.peers.values()].find((p) => p.kind === 'freeq' && p.name === 'bob');
  assert.ok(bobPeer);
  stand(me, 'ch-general');

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
  assert.ok(said.some((m) => m.t === 'freeq-note' && m.ok && /Talking on freeq as/.test(m.text)));
  // ...and the listener doesn't echo Alice back into the office.
  await tick();
  assert.equal(said.filter((m) => m.t === 'chat' && m.text === 'hello freeq').length, 1);

  // Guests stay local and are told why.
  const gsaid = [];
  const guest = office.open({ readyState: 1, send: (s) => gsaid.push(JSON.parse(s)) });
  await office.handle(guest, { t: 'hello', name: 'Gus' });
  stand(guest, 'ch-general');
  await office.handle(guest, { t: 'chat', text: 'can anyone hear me' });
  await tick();
  assert.ok(gsaid.some((m) => m.t === 'freeq-note' && /signed-in/.test(m.text)));

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
  const other = first === 'ch-general' ? '#dev' : '#general';
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

test('a failed freeq sign-in or a refused message tells the speaker why', async () => {
  let refuse = true;
  const server = fakeFreeq({ verify: async (r) => r.method === 'crypto' || !refuse });
  const office = new Office({}, { loadActor: null });
  let jwk = null;
  const bridge = new FreeqBridge({
    office, log: () => {},
    auth: { freeqCredentials: async (did) => ({ did, pds: 'https://pds.example', accessToken: 't', dpopProof: 'p' }) },
    openSocket: async () => server.open().socket,
    keyStore: { get: async () => jwk, set: async (j) => { jwk = j; } },
    fetch: async () => new Response(JSON.stringify([{ name: '#general', members: 3 }])),
  });
  server.outsider('bob', 'did:plc:bob').join('#general');
  const said = [];
  const me = office.open({ readyState: 1, send: (s) => said.push(JSON.parse(s)) }, { did: 'did:plc:alice' });
  await office.handle(me, { t: 'hello', name: 'Alice' });
  await bridge.start();
  await tick();
  stand(me, 'ch-general');
  await office.handle(me, { t: 'chat', text: 'one' });
  for (let i = 0; i < 20 && !said.some((m) => m.t === 'freeq-note'); i++) await tick();
  const fail = said.find((m) => m.t === 'freeq-note');
  assert.equal(fail.ok, false);
  assert.match(fail.text, /didn't reach #general.*sign-in failed/);

  // Signed in, but the channel turns the message away.
  refuse = false;
  said.length = 0;
  await office.handle(me, { t: 'chat', text: 'two' });
  for (let i = 0; i < 20 && !bridge.users.get('did:plc:alice')?.irc.registered; i++) await tick();
  const conn = [...server.conns].find((c) => c.account === 'did:plc:alice');
  conn.out(':irc.freeq.at 404 alice #general :Cannot send to channel');
  await tick();
  assert.ok(said.some((m) => m.t === 'freeq-note' && !m.ok && /Cannot send to channel/.test(m.text)));
  bridge.stop();
});

test('agents talk on freeq too: as their DID with a token, else as a did:key of their own', async () => {
  const replies = [];
  const server = fakeFreeq({ verify: async (r) => { replies.push(r); return true; } });
  const office = new Office({}, { loadActor: null });
  let jwk = null;
  const bridge = new FreeqBridge({
    office, log: () => {},
    openSocket: async () => server.open().socket,
    keyStore: { get: async () => jwk, set: async (j) => { jwk = j; } },
    fetch: async () => new Response(JSON.stringify([{ name: '#general', members: 3 }])),
  });
  const bob = server.outsider('bob', 'did:plc:bob');
  bob.join('#general');
  const bobGot = [];
  [...server.conns].find((c) => c.nick === 'bob').out = (l) => bobGot.push(l);
  await bridge.start();
  await tick();

  const agent = async (name, did) => {
    const said = [];
    const p = office.open({ readyState: 1, send: (s) => said.push(JSON.parse(s)) }, { did });
    await office.handle(p, { t: 'hello', name, kind: 'agent' });
    stand(p, 'ch-general');
    return { p, said };
  };
  bridge.rememberAgentToken('did:plc:bodhi', 'rmcp_secret', 'https://roost.latha.org/');
  const bodhi = await agent('Bodhi', 'did:plc:bodhi');
  await office.handle(bodhi.p, { t: 'chat', text: 'hello from bodhi' });
  for (let i = 0; i < 20 && !bobGot.some((l) => l.includes('hello from bodhi')); i++) await tick();
  const r = replies.find((x) => x.did === 'did:plc:bodhi');
  assert.deepEqual({ method: r.method, signature: r.signature, pds_url: r.pds_url }, { method: 'pds-session', signature: 'rmcp_secret', pds_url: 'https://roost.latha.org' });
  assert.ok(r.challenge_nonce);
  assert.ok(bobGot.some((l) => /account=did:plc:bodhi[; ].*PRIVMSG #general :hello from bodhi/.test(l)));
  assert.ok(bodhi.said.some((m) => m.t === 'freeq-note' && m.ok));

  // No token: a did:key derived for this agent, the same one next time.
  const rex = await agent('Rex', null);
  await office.handle(rex.p, { t: 'chat', text: 'rex here' });
  for (let i = 0; i < 20 && !bobGot.some((l) => l.includes('rex here')); i++) await tick();
  const rr = replies.filter((x) => x.method === 'crypto' && x.did !== replies[0].did);
  assert.equal(rr.length, 1);
  assert.match(rr[0].did, /^did:key:z6Mk/);
  assert.ok(bobGot.some((l) => l.includes(`account=${rr[0].did}`) && l.includes('rex here')));
  office.leave(rex.p);
  assert.ok(!bridge.users.has('agent:Rex'));
  const again = await bridge.responderFor({ kind: 'agent', name: 'Rex', did: null }, 'agent:Rex');
  assert.equal(again.as, rr[0].did);
  bridge.stop();
});

test('fixed area mapping and nick cleanup', () => {
  assert.deepEqual([...parseRooms('lounge=#general, open=dev, nowhere=#x')], [['lounge', '#general'], ['open', '#dev']]);
  assert.equal(ircNick('alice.bsky.social'), 'alice');
  assert.equal(ircNick('9lives.example'), 'lives');
  assert.equal(ircNick(''), 'office');
});


test('a listener sign-in that never finishes gives up, says why, and retries', async () => {
  const office = new Office({}, { loadActor: null });
  let opened = 0;
  const silent = () => ({ readyState: 1, addEventListener() {}, send() {}, close() { this.readyState = 3; } });
  const bridge = new FreeqBridge({
    office, auth: null, log: () => {}, signInMs: 30,
    openSocket: async () => { opened++; return silent(); },
    keyStore: { get: async () => null, set: async () => {} },
    fetch: async () => new Response('[]'),
  });
  const me = office.open({ readyState: 1, send() {} });
  await office.handle(me, { t: 'hello', name: 'Alice' }); // presence() starts the listener
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(opened, 1);
  const st = bridge.status();
  assert.equal(st.listening, false);
  assert.equal(st.retrying, true);
  assert.match(st.lastError, /didn't finish signing the office in/);
  assert.ok(!bridge.starting && !bridge.listener);
  // More presence while the retry is pending doesn't open more connections.
  bridge.presence();
  assert.equal(opened, 1);
  bridge.stop();
});

test('after a restart, only real comings and goings show, and missed messages are caught up', async () => {
  const server = fakeFreeq({ verify: async () => true });
  const list = [{ name: '#general', members: 3 }];
  let jwk = null, snap = null;
  const keyStore = { get: async () => jwk, set: async (j) => { jwk = j; } };
  const stateStore = { get: async () => snap && JSON.parse(JSON.stringify(snap)), set: async (s) => { snap = s; } };
  const bob = server.outsider('bob', 'did:plc:bob');
  const carol = server.outsider('carol', 'did:plc:carol');
  bob.join('#general'); carol.join('#general');

  // Before: Alice is in the Lounge with bob and carol.
  const office1 = new Office({}, { loadActor: null });
  const bridge1 = new FreeqBridge({ office: office1, log: () => {}, keyStore, stateStore, openSocket: async () => server.open().socket, fetch: server.fetch(list) });
  const a1 = office1.open({ readyState: 1, send() {} });
  await office1.handle(a1, { t: 'hello', name: 'Alice' });
  await bridge1.start();
  await tick();
  assert.equal(bridge1.bindings.get('ch-general')?.channel, '#general');
  bob.say('#general', 'before the restart');
  await tick();
  const before = Object.fromEntries([...office1.peers.values()].filter((p) => p.kind === 'freeq').map((p) => [p.name, { x: p.x, y: p.y }]));
  assert.deepEqual(Object.keys(before).sort(), ['bob', 'carol']);
  await bridge1.saver.now();

  // The process dies (no goodbye), and while it's down carol leaves, dave comes, bob talks.
  bridge1.saver.cancel(); clearInterval(bridge1.refreshTimer);
  bridge1.listener.onClose = () => {}; bridge1.listener.ws.close();
  carol.part('#general');
  const dave = server.outsider('dave', 'did:plc:dave');
  dave.join('#general');
  bob.say('#general', 'said while you were away');

  // After: a fresh office over the same entities (the wing remembers the room), Alice back in #general.
  const office2 = new Office({}, { loadActor: null, runtime: new LocalRuntime({ kinds: KINDS, data: office1.runtime.data }) });
  await office2.ready;
  const said = [];
  const a2 = office2.open({ readyState: 1, send: (s) => said.push(JSON.parse(s)) });
  await office2.handle(a2, { t: 'hello', name: 'Alice' });
  stand(a2, 'ch-general');
  const bridge2 = new FreeqBridge({ office: office2, log: () => {}, keyStore, stateStore, openSocket: async () => server.open().socket, fetch: server.fetch(list) });
  await bridge2.restored;
  // bob and carol are back where they stood, before freeq has said anything.
  const drawn = () => [...office2.peers.values()].filter((p) => p.kind === 'freeq');
  assert.deepEqual(drawn().map((p) => p.name).sort(), ['bob', 'carol']);
  const bobPeer = drawn().find((p) => p.name === 'bob');
  assert.deepEqual({ x: bobPeer.x, y: bobPeer.y }, before.bob);

  said.length = 0;
  await bridge2.start();
  for (let i = 0; i < 20 && !said.some((m) => m.t === 'chat'); i++) await tick();
  const names = (t) => said.filter((m) => m.t === t).map((m) => (t === 'join' ? m.peer.name : office2.peers.get(m.id)?.name ?? m.id));
  assert.deepEqual(names('join'), ['dave']); // only the real arrival
  assert.equal(said.filter((m) => m.t === 'leave').length, 1); // only carol
  assert.ok(!office2.peers.has(drawn().find((p) => p.name === 'carol')?.id));
  assert.deepEqual(drawn().map((p) => p.name).sort(), ['bob', 'dave']);
  assert.ok(office2.peers.has(bobPeer.id), 'bob is the same avatar, never redrawn');

  // The message said during the gap is caught up once; the earlier one isn't replayed.
  const chats = said.filter((m) => m.t === 'chat');
  assert.deepEqual(chats.map((m) => m.text), ['said while you were away']);
  assert.equal(chats[0].backfill, true);
  assert.equal(chats[0].id, bobPeer.id);

  // The area's count is who's drawn there.
  await new Promise((r) => setTimeout(r, 300));
  const rooms = said.filter((m) => m.t === 'freeq').pop().rooms;
  assert.equal(rooms['ch-general'].members, 2);
  assert.equal(rooms['ch-general'].here, 2);

  // Someone who vanished without a PART we heard is gone after the next NAMES.
  const room = server.members.get('#general');
  room.delete([...room].find((c) => c.nick === 'dave'));
  await bridge2.refresh();
  await tick();
  assert.deepEqual(drawn().map((p) => p.name), ['bob']);
  bridge2.stop();
});

test('the office works the same when freeq is unreachable', async () => {
  const snap = {
    v: 1, at: Date.now(),
    bindings: { lounge: { channel: '#general', topic: null, members: 2 } },
    people: [{ nick: 'bob', channels: ['#general'], active: '#general', zone: 'lounge', x: 35, y: 25 }],
    seen: { '#general': { ts: 1, ids: [] } },
  };
  const office = new Office({}, { loadActor: null });
  const logs = [];
  const bridge = new FreeqBridge({
    office, log: (l) => logs.push(l), graceMs: 40, signInMs: 20,
    keyStore: { get: async () => null, set: async () => {} },
    stateStore: { get: async () => snap, set: async () => { throw new Error('disk full'); } },
    openSocket: async () => { throw new Error('getaddrinfo ENOTFOUND irc.freeq.at'); },
    fetch: async () => { throw new Error('fetch failed'); },
  });
  await bridge.restored;
  const said = [];
  const me = office.open({ readyState: 1, send: (s) => said.push(JSON.parse(s)) });
  // Joining doesn't wait on freeq.
  await office.handle(me, { t: 'hello', name: 'Alice' });
  assert.ok(said.some((m) => m.t === 'welcome'));
  // Talking outside the freeq areas is untouched.
  await office.handle(me, { t: 'chat', text: 'still here' });
  assert.ok(said.some((m) => m.t === 'chat' && m.text === 'still here'));
  await tick();
  const st = bridge.status();
  assert.equal(st.listening, false);
  assert.match(st.lastError, /ENOTFOUND/);
  // Nobody is left standing around from before once the grace period ends.
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(![...office.peers.values()].some((p) => p.kind === 'freeq'));
  assert.deepEqual(said.filter((m) => m.t === 'freeq').pop().rooms, {});
  bridge.stop();
  // A snapshot that can't be written is logged, not thrown.
  await bridge.saver.now();
  assert.ok(logs.some((l) => /couldn't save the snapshot: disk full/.test(l)));
});
