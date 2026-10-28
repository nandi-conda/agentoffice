import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { KINDS } from '../server/entities/kinds.js';
import { describeApi, generatedTools, parseWrangler } from '../server/apidoc.js';
import { build } from '../scripts/docs.mjs';
import { Office } from '../server/office.js';
import { AgentAuth } from '../server/agentauth.js';
import { McpHub } from '../server/mcp.js';

test('the generated docs are up to date (run `just docs`)', async () => {
  for (const [file, text] of Object.entries(await build())) {
    assert.equal(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), text, `${file} is stale: run \`just docs\``);
  }
});

test('every entity method is described, and every description is a real method', () => {
  for (const [kind, Kind] of Object.entries(KINDS)) {
    assert.ok(Kind.doc, `${kind} has no static doc`);
    for (const m of Kind.rpc || []) assert.ok(Kind.api?.[m], `${kind}.${m} is in rpc but not in static api`);
    for (const [m, spec] of Object.entries(Kind.api || {})) {
      assert.equal(typeof Kind.prototype[m], 'function', `${kind}.${m} is described but not implemented`);
      assert.ok(spec.doc, `${kind}.${m} has no doc`);
    }
  }
});

test('wrangler bindings are parsed and match the entity bindings', async () => {
  const w = parseWrangler(await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8'));
  const names = w.durableObjects.map((b) => b.name);
  for (const e of describeApi().entities) if (e.binding) assert.ok(names.includes(e.binding), `${e.kind} needs binding ${e.binding}`);
});

test('generated tools: names, read-only split, no internal methods', () => {
  const tools = generatedTools(describeApi());
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.ok(by.desk_claim && !by.desk_claim.readOnly);
  assert.ok(by.noticeboard_view.readOnly);
  assert.ok(by.room_book.input.properties.op && by.room_book.input.required.includes('name'));
  for (const n of ['desk_touch', 'room_tick', 'actor_sessionGet', 'actor_view', 'topic_publish', 'desk_inspect', 'desk_seed']) assert.ok(!by[n], `${n} should not be a tool`);
});

async function setup() {
  const office = new Office({});
  await office.ready;
  const hub = new McpHub({ office, auth: new AgentAuth({ fetch: async () => new Response('', { status: 404 }), resolve: async () => ({}) }), token: 'op' });
  const connect = async (headers = {}) => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://office.test/mcp'), { fetch: (u, i) => hub.fetch(new Request(u, i)), requestInit: { headers } }));
    return client;
  };
  return { office, connect };
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

test('MCP: observers read through generated tools but cannot act', async () => {
  const { connect } = await setup();
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ['desk_claim', 'noticeboard_add', 'room_book', 'pomodoro_start', 'whiteboard_view']) assert.ok(names.includes(n), `missing ${n}`);
  assert.deepEqual(await call(c, 'noticeboard_view'), []);
  assert.equal(await call(c, 'desk_view', { name: 'desk-1' }), null);
  await assert.rejects(call(c, 'noticeboard_add', { text: 'hi' }), /sign in|Roost/i);
  await assert.rejects(call(c, 'desk_view', { name: 'desk-999' }));
  await c.close();
});

test('MCP: a joined agent acts through generated tools, with the World filling in who', async () => {
  const { connect, office } = await setup();
  const c = await connect({ authorization: 'Bearer op' });
  await assert.rejects(call(c, 'desk_claim', { name: 'desk-3', goal: 'x' }), /join_office/);
  await call(c, 'join_office', { name: 'Docbot' });
  await call(c, 'noticeboard_add', { text: 'generated tools work' });
  const notes = await call(c, 'noticeboard_view');
  assert.equal(notes[0].text, 'generated tools work');
  assert.equal(notes[0].by, 'Docbot');
  assert.deepEqual(await call(c, 'desk_claim', { name: 'desk-3', goal: 'docs' }), { ok: true });
  assert.equal(office.desks['desk-3'].goal, 'docs');
  const { booking } = await call(c, 'room_book', { name: 'huddle', op: 'create', title: 'sync', minutes: 30 });
  assert.equal(booking.room, 'huddle');
  assert.ok(office.bookings.some((b) => b.id === booking.id));
  // The pomodoro lives in the Deep Work Den: not from the lobby.
  await assert.rejects(call(c, 'pomodoro_start', {}), /walk to/);
  await c.close();
});
