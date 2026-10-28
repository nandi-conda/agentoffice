#!/usr/bin/env node
// A demo coworker agent. It takes a desk, keeps a "working on" note, and
// answers @mentions:
//
//   @standupbot standup   - posts everyone's "working on" notes and desks
//   @standupbot come here - walks over to you
//   @standupbot coffee    - fetches a coffee and comes back
//   @standupbot focus     - joins the Deep Work Den
//
// Usage: node scripts/agent.mjs [--url ws://localhost:8080/ws] [--name StandupBot] [--goal "..."]

import { AgentClient } from './agent-sdk.mjs';
import { FURNITURE } from '../public/js/map.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = arg('url', process.env.OFFICE_URL || 'ws://localhost:8080/ws');
const name = arg('name', 'StandupBot');
const goal = arg('goal', 'collecting standup notes');

const bot = new AgentClient({ url, name, note: goal });
await bot.connect();
console.log(`${name} connected to ${url}`);
let home = await bot.takeDesk(goal);
bot.status('available', goal);

let busy = false;
const task = async (fn) => {
  if (busy) return bot.say('one sec, finishing something');
  busy = true;
  try { await fn(); } finally { busy = false; }
};

bot.on('mention', (m) => {
  // Drop the @mentions so the bot's own name doesn't read as a command.
  const text = m.text.toLowerCase().replace(/@[\w.-]+/g, '');
  const who = `@${m.name.replace(/\s+/g, '')}`;
  if (text.includes('standup')) {
    const people = [...bot.peers.values()].filter((p) => p.kind !== 'agent');
    if (!people.length) return bot.say('nobody here but us agents');
    const lines = people.map((p) => {
      const desk = Object.entries(bot.desks).find(([, v]) => v.owner === (p.did || `human:${p.name}`));
      return `${p.name}: ${p.note || 'no note'}${desk ? ` (${desk[0]})` : ''}`;
    });
    bot.shout(`standup ✦ ${lines.join(' · ')}`);
  } else if (text.includes('come')) {
    task(async () => { bot.say(`${who} walking over`); await bot.walkToPeer(m.id); bot.emote('wave'); });
  } else if (text.includes('coffee')) {
    task(async () => {
      const machine = FURNITURE.find((f) => f.id === 'coffee');
      bot.say('☕ brb');
      bot.status('coffee', 'getting coffee');
      await bot.walkTo(machine.x + 0.5, machine.y + 1.5);
      bot.send({ t: 'coffee' });
      await bot.walkToPeer(m.id);
      bot.say(`${who} here you go ☕`);
      bot.status('available', goal);
      home = await bot.takeDesk(goal);
    });
  } else if (text.includes('focus')) {
    task(async () => {
      bot.say('heading to the den 🎧');
      const desk = bot.freeDesk('den-');
      if (desk) { await bot.sit(`${desk.id}-chair`); bot.status('focus', goal); }
    });
  } else {
    bot.say(`hi ${who}! try "@${name} standup", "come here", "coffee" or "focus"`);
  }
});

bot.on('close', () => { console.log('disconnected'); process.exit(1); });
process.on('SIGINT', () => { bot.close(); process.exit(0); });
