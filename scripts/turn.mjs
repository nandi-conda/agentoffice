#!/usr/bin/env node
// `just turn`: give the deployed Worker a Cloudflare Realtime TURN key, so
// voice and video connect behind strict NATs (README: Voice and video behind
// firewalls). Safe to run again: it does nothing while the Worker's /api/ice
// already hands out TURN servers.
//
//   1. If TURN_KEY_ID and TURN_KEY_API_TOKEN are set on the Worker and
//      /api/ice says turn: true, stop there (--rotate makes a new key anyway).
//   2. Create a TURN key named after the Worker through the Cloudflare API
//      (POST /accounts/{id}/calls/turn_keys). Credentials come from
//      CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL), else
//      wrangler's login. If they aren't allowed to, it asks you to paste a
//      key made in the dashboard instead (or use --manual).
//   3. Pipe the key's id and secret into `wrangler secret put`.
//   4. Poll /api/ice until it returns TURN servers, then delete older keys
//      with the same name (their secret was replaced; --keep-old skips this).
//
//   node scripts/turn.mjs [--url https://office.example.com] [--name agentoffice]
//                         [--rotate] [--manual] [--keep-old] [--print]
//
// --print skips wrangler and prints TURN_KEY_ID=… / TURN_KEY_API_TOKEN=… for a
// Node server's environment instead.

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const API = 'https://api.cloudflare.com/client/v4';
const WRANGLER = 'node_modules/.bin/wrangler';
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const say = (m) => console.error(m);

function run(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(WRANGLER, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`wrangler ${args.join(' ')} failed:\n${(err || out).trim()}`)));
    p.stdin.end(input ?? '');
  });
}
// wrangler prints banners and proxy warnings around --json output.
const jsonIn = (s) => JSON.parse(s.slice(s.search(/^[[{]/m)));

async function workerConfig() {
  const toml = await readFile('wrangler.toml', 'utf8').catch(() => '');
  const top = toml.split(/^\[/m)[0];
  const vars = (toml.match(/^\[vars\]([^[]*)/m) || [])[1] || '';
  return {
    name: (top.match(/^name\s*=\s*"([^"]+)"/m) || [])[1] || 'agentoffice',
    accountId: (top.match(/^account_id\s*=\s*"([^"]+)"/m) || [])[1],
    publicUrl: (vars.match(/^PUBLIC_URL\s*=\s*"([^"]+)"/m) || [])[1],
  };
}

async function credentials() {
  if (process.env.CLOUDFLARE_API_TOKEN) return { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
  if (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_EMAIL) {
    return { 'x-auth-key': process.env.CLOUDFLARE_API_KEY, 'x-auth-email': process.env.CLOUDFLARE_EMAIL };
  }
  const t = jsonIn(await run(['auth', 'token', '--json']));
  return t.type === 'api_key' ? { 'x-auth-key': t.key, 'x-auth-email': t.email } : { authorization: `Bearer ${t.token}` };
}

function cloudflare(headers) {
  return async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method, headers: { ...headers, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const e = new Error(`${method} ${path}: ${res.status} ${(data.errors || []).map((x) => `${x.code} ${x.message}`).join('; ')}`);
      e.status = res.status;
      throw e;
    }
    return data.result;
  };
}

async function accountId(cf, cfg) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  if (cfg.accountId) return cfg.accountId;
  const accounts = await cf('GET', '/accounts?per_page=50');
  if (accounts.length === 1) return accounts[0].id;
  throw new Error(`these credentials see ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID to one of:\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n')}`);
}

async function officeUrl(cf, account, cfg) {
  const u = opt('url') || process.env.PUBLIC_URL || cfg.publicUrl;
  if (u) return u.replace(/\/$/, '');
  const { subdomain } = await cf('GET', `/accounts/${account}/workers/subdomain`);
  return `https://${cfg.name}.${subdomain}.workers.dev`;
}

async function ice(url) {
  try {
    const res = await fetch(`${url}/api/ice`, { headers: { 'cache-control': 'no-cache' } });
    return res.ok ? await res.json() : { turn: false, status: res.status };
  } catch (e) {
    return { turn: false, status: e.message };
  }
}

async function paste() {
  if (!process.stdin.isTTY) throw new Error('no TTY to paste a key into; set CLOUDFLARE_API_TOKEN (see above) and run again');
  say('\nMake one by hand: Cloudflare dashboard -> Realtime -> TURN Server -> Create (any name).');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const uid = (await rl.question('Turn Token ID: ')).trim();
  const key = (await rl.question('API Token: ')).trim();
  rl.close();
  if (!uid || !key) throw new Error('need both the Turn Token ID and the API Token');
  return { uid, key };
}

async function main() {
  const cfg = await workerConfig();
  const name = opt('name') || cfg.name;
  const print = flag('print');
  let cf, account, url;

  const connect = async () => {
    cf ||= cloudflare(await credentials());
    account ||= await accountId(cf, cfg);
    return cf;
  };

  // 1. Already working?
  if (!print && !flag('rotate')) {
    const secrets = jsonIn(await run(['secret', 'list', '--format', 'json'])).map((s) => s.name);
    if (secrets.includes('TURN_KEY_ID') && secrets.includes('TURN_KEY_API_TOKEN')) {
      try { await connect(); url = await officeUrl(cf, account, cfg); } catch { url = opt('url') || process.env.PUBLIC_URL || cfg.publicUrl; }
      if (url) {
        const now = await ice(url);
        if (now.turn) {
          say(`TURN is already set up: ${url}/api/ice returns TURN servers. Nothing to do (--rotate makes a new key).`);
          return;
        }
        say(`The TURN secrets are set but ${url}/api/ice says turn: false${now.status ? ` (${now.status})` : ''}; making a new key.`);
      }
    }
  }

  // 2. A new key, from the API or pasted.
  let made;
  if (flag('manual')) made = await paste();
  else {
    try {
      await connect();
      made = await cf('POST', `/accounts/${account}/calls/turn_keys`, { name });
      say(`Created TURN key "${name}" (${made.uid}).`);
    } catch (e) {
      if (e.status !== 401 && e.status !== 403 && !/not logged in/i.test(e.message)) throw e;
      say(`Cloudflare didn't let these credentials create a TURN key (${e.message.split('\n')[0]}).`);
      say('(`wrangler login` alone can\'t: its OAuth scopes don\'t include Realtime.) Either export CLOUDFLARE_API_TOKEN');
      say('set to a custom API token with Account -> Realtime (or "Calls") -> Edit plus Account -> Workers Scripts -> Edit,');
      say('created at https://dash.cloudflare.com/profile/api-tokens, and run `just turn` again, or paste a key now.');
      made = await paste();
    }
  }

  if (print) {
    console.log(`TURN_KEY_ID=${made.uid}\nTURN_KEY_API_TOKEN=${made.key}`);
    return;
  }

  // 3. Secrets.
  for (const [k, v] of [['TURN_KEY_ID', made.uid], ['TURN_KEY_API_TOKEN', made.key]]) {
    await run(['secret', 'put', k], v);
    say(`Set ${k}.`);
  }

  // 4. Verify, then tidy up.
  if (!url) { try { await connect(); url = await officeUrl(cf, account, cfg); } catch { url = opt('url') || process.env.PUBLIC_URL || cfg.publicUrl; } }
  if (!url) { say('Secrets set. Pass --url https://your-office to check /api/ice.'); return; }
  let last;
  for (let i = 0; i < 12; i++) {
    last = await ice(url);
    if (last.turn) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!last.turn) {
    throw new Error(`${url}/api/ice still says turn: false${last.status ? ` (${last.status})` : ''} after a minute. Is the Worker deployed there (just deploy)? \`just cf-tail\` shows its logs.`);
  }
  const urls = last.iceServers.flatMap((s) => [].concat(s.urls)).filter((u) => /^turns?:/.test(u));
  say(`Verified: ${url}/api/ice returns TURN servers (${urls.join(', ')}).`);

  if (cf && !flag('keep-old')) {
    try {
      const stale = (await cf('GET', `/accounts/${account}/calls/turn_keys`)).filter((k) => k.name === name && k.uid !== made.uid);
      for (const k of stale) {
        await cf('DELETE', `/accounts/${account}/calls/turn_keys/${k.uid}`);
        say(`Deleted the old TURN key "${k.name}" (${k.uid}).`);
      }
    } catch (e) {
      say(`Couldn't tidy up older "${name}" keys (${e.message}); delete them in the dashboard if you like.`);
    }
  }
}

main().catch((e) => { say(e.message); process.exit(1); });
