// Meeting room bookings. Shared by the server (which owns the schedule), the
// browser (which draws it) and agents, so it stays free of DOM and Node APIs.
//
// A booking is { id, room, title, start, end, owner, name, handle, invitees,
// lock, autoRelease, seen, admitted, created }. Times are epoch ms. `owner`
// is the booker's key (their DID, or `agent:<name>`); `invitees` are handles,
// DIDs or agent names; `admitted` holds keys let in at the door on the day.

import { ZONES } from './map.js';
import { stampRange } from './time.js';

export const MIN = 60000;
export const ROOMS = ZONES.filter((z) => z.bookable);
export const roomById = (id) => ROOMS.find((r) => r.id === id) || null;

export const RULES = {
  step: 5 * MIN, // starts and ends snap to 5 minutes
  minLen: 15 * MIN,
  maxLen: 4 * 60 * MIN,
  ahead: 14 * 24 * 60 * MIN, // how far out you can book
  perOwner: 12, // upcoming bookings per person
  grace: 10 * MIN, // auto-release if nobody turns up by then
  soon: 15 * MIN, // a room is "booked soon" this close to a booking
  remind: 5 * MIN, // heads-up before start and before end
};

export const snap = (t) => Math.round(t / RULES.step) * RULES.step;
export const keyOf = (p) => p.did || `${p.kind}:${p.name}`;
const norm = (s) => String(s ?? '').trim().replace(/^@/, '').toLowerCase().replace(/\s+/g, '');

export function parseInvitees(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  return [...new Set(list.map(norm).filter((s) => s && s.length <= 253))].slice(0, 20);
}

export const forRoom = (list, room) => list.filter((b) => b.room === room).sort((a, b) => a.start - b.start);
export const activeBooking = (list, room, now) => list.find((b) => b.room === room && b.start <= now && now < b.end) || null;
export const nextBooking = (list, room, now) => forRoom(list, room).find((b) => b.start > now) || null;
export const overlapping = (list, room, start, end, ignore = null) =>
  list.find((b) => b.room === room && b.id !== ignore && b.start < end && start < b.end) || null;

// free | soon | busy, plus the bookings that make it so.
export function roomStatus(list, room, now) {
  const current = activeBooking(list, room, now);
  const next = nextBooking(list, room, now);
  const state = current ? 'busy' : next && next.start - now <= RULES.soon ? 'soon' : 'free';
  return { state, current, next };
}

// Invitees match a signed-in handle or DID. A plain name only matches an
// agent, since guests can call themselves anything.
export function isHolder(b, p) {
  if (!b || !p) return false;
  const key = keyOf(p);
  if (b.owner === key || (b.admitted || []).includes(key)) return true;
  const inv = b.invitees || [];
  if (p.did && inv.includes(p.did.toLowerCase())) return true;
  if (p.handle && inv.includes(p.handle.toLowerCase())) return true;
  return p.kind === 'agent' && inv.includes(norm(p.name));
}

// Kept out of a room right now? Every booking keeps everyone but its
// holders out while it runs; others knock to be let in.
export function lockedOut(list, room, p, now) {
  const b = activeBooking(list, room, now);
  return !!(b && !isHolder(b, p));
}

// Check a booking request. Returns { error } or { start, end }.
export function checkSlot(list, { room, start, end, owner, id = null }, now) {
  if (!roomById(room)) return { error: 'no such room' };
  start = snap(+start); end = snap(+end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: 'start and end must be times' };
  if (end - start < RULES.minLen) return { error: 'bookings are at least 15 minutes' };
  if (end - start > RULES.maxLen) return { error: 'bookings are at most 4 hours' };
  if (end <= now) return { error: 'that time has already passed' };
  if (start < now - RULES.step && !id) start = snap(now); // "book it now" for a slot that just began
  if (start - now > RULES.ahead) return { error: 'you can book up to 14 days ahead' };
  const clash = overlapping(list, room, start, end, id);
  if (clash) return { error: `${roomById(room).name} is booked ${stampRange(clash)} (${clash.title})` };
  if (!id && list.filter((b) => b.owner === owner && b.end > now).length >= RULES.perOwner) {
    return { error: `you already have ${RULES.perOwner} upcoming bookings` };
  }
  return { start, end };
}

// Accepts epoch ms, an ISO string, or "HH:MM" (today, server-local).
export function toTime(v, now = Date.now()) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) { const d = new Date(now); d.setHours(+hm[1], +hm[2], 0, 0); return d.getTime(); }
  return Date.parse(s);
}

export { fmtTime, fmtRange } from './time.js';
