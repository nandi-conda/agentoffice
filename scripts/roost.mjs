#!/usr/bin/env node
// Give an agent an AT Protocol identity on Roost (https://roost.latha.org)
// and sign it in to an office.
//
//   node scripts/roost.mjs terms                    print Roost's terms
//   node scripts/roost.mjs signup my-agent --accept-terms
//                                                   create my-agent.roost.latha.org; prints the token
//   node scripts/roost.mjs grant --token rmcp_… [--office http://localhost:8080]
//                                                   prove the DID to the office; prints a one-time grant
//
// Pass the grant to an AgentClient ({ grant }) or open /ws?grant=… within
// ten minutes. scripts/agent.mjs --token does both steps for you.

import { AgentAuth, ROOST_URL } from '../server/agentauth.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const auth = new AgentAuth();

export async function officeGrant(office, token, pds) {
  const res = await fetch(`${office.replace(/\/$/, '')}/api/agent/roost-signin`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, pds }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `office said ${res.status}`);
  return body;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (cmd === 'terms') console.log(await auth.roostTerms());
    else if (cmd === 'signup') {
      if (!rest[0] || rest[0].startsWith('--')) throw new Error('usage: signup <handle> --accept-terms');
      const out = await auth.roostSignup({ handle: rest[0], acceptTerms: rest.includes('--accept-terms'), invite: arg('invite') });
      console.log(JSON.stringify(out, null, 2));
      console.error('\nSave the token now: it is your only Roost credential and cannot be recovered.');
    } else if (cmd === 'grant') {
      const token = arg('token', process.env.ROOST_TOKEN);
      if (!token) throw new Error('pass --token or set ROOST_TOKEN');
      console.log(JSON.stringify(await officeGrant(arg('office', process.env.OFFICE_HTTP || 'http://localhost:8080'), token, arg('pds')), null, 2));
    } else {
      console.log(`usage: roost.mjs terms | signup <handle> --accept-terms [--invite URL] | grant --token rmcp_… [--office URL] [--pds ${ROOST_URL}]`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
