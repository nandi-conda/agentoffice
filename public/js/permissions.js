// Plugin permissions: what a WASM plugin may ask the office to do beyond the
// basics. A plugin lists the ones it needs in its manifest (the Rust crate's
// Manifest::permissions); each belongs to a level, and the level decides who
// may upload it (a capability in public/js/roles.js). The office's own
// objects (public/plugins) get whatever they declare. At run time the office
// only honours what was declared and granted: a `take` without the
// permission is dropped, an `unlock` refused.
// Shared by the server, the upload panel and the docs.

import { CAPS, can } from './roles.js';

export const LEVELS = {
  basic: { cap: null, label: 'Basic', doc: 'Panels, speech bubbles, its label and glow, music, handing out things, timers and watching zones. Anyone signed in can upload it.' },
  trusted: { cap: 'plugins.trusted', label: 'Trusted', doc: 'Also spends the office\'s money or people\'s things. Moderators and up can upload it.' },
  privileged: { cap: 'plugins.privileged', label: 'Privileged', doc: 'Also gets around the office\'s rules for people. Only admins and owners can upload it.' },
};

export const PERMISSIONS = {
  take: { level: 'trusted', label: 'Take things', doc: 'Use up things the person carries (Response::take), all or nothing with what it gives.' },
  feed: { level: 'trusted', label: 'Keep a feed', doc: 'Keep a long list every browser gets, beyond its 32 KB of state (Response::append, Response::clear_feed): the last 3000 entries of up to 8 KB, like the whiteboard\'s strokes. It\'s the office\'s storage and bandwidth.' },
  unlock: { level: 'privileged', label: 'Open booked rooms', doc: 'Let whoever uses it into a meeting room someone else booked (Response::unlock), past the booking. The request carries `rooms`, each bookable room and what is on in it now.' },
};

const ORDER = ['basic', 'trusted', 'privileged'];

// Known permissions only, each once, in a stable order.
export function cleanPermissions(list) {
  return Array.isArray(list) ? Object.keys(PERMISSIONS).filter((p) => list.includes(p)) : [];
}

// The level a set of permissions needs: the highest of theirs.
export function levelOf(list) {
  return cleanPermissions(list).reduce((lv, p) => (ORDER.indexOf(PERMISSIONS[p].level) > ORDER.indexOf(lv) ? PERMISSIONS[p].level : lv), 'basic');
}

// The role a level needs, at least.
export const levelRole = (level) => (LEVELS[level]?.cap ? CAPS[LEVELS[level].cap] : 'member');

// May someone with `role` upload a plugin asking for `list`? An error
// string, or null when they may.
export function uploadError(role, list, name = 'this plugin') {
  const level = levelOf(list);
  if (level === 'basic' || can(role, LEVELS[level].cap)) return null;
  const needs = cleanPermissions(list).filter((p) => PERMISSIONS[p].level === level).join(', ');
  const who = levelRole(level) === 'admin' ? 'admins' : `${levelRole(level)}s`;
  return `${name} asks for ${needs} (${LEVELS[level].label.toLowerCase()}): only ${who} and up can upload it`;
}
