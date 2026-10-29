// Server roles: who may do what in the office. Shared by the World (which
// checks every call, server/office.js), the MCP hub (which only lists the
// tools a caller may use, server/mcp.js), the API docs and the browser
// (badges, the admin panel). Runtime-neutral, no imports.
//
// Everyone has exactly one role. Most never get one granted: signed-in
// people are members, signed-in agents are agents, everyone else in the
// office is a guest, and an MCP session that hasn't signed in is an
// observer (read-only). Owners and admins come from env vars (OWNER_DIDS,
// ADMIN_DIDS) to start with; after that admins grant roles in the office
// (the roles:main entity keeps them, each actor keeps a copy of its own).

export const ROLES = {
  owner: { rank: 6, label: 'Owner', badge: '👑', doc: 'Runs the office: everything an admin can do, and makes or removes admins and owners.' },
  admin: { rank: 5, label: 'Admin', badge: '🛡️', doc: 'Grants and revokes roles below their own, bans people and reads the server logs, besides moderating.' },
  moderator: { rank: 4, label: 'Moderator', badge: '🔨', doc: 'Keeps the peace: kicks, mutes and moves people, clears the floor, removes uploads and notices, closes channel rooms and changes their door, overrides bookings.' },
  member: { rank: 3, label: 'Member', badge: '', doc: 'Signed in with AT Protocol: books rooms, opens channel rooms, uploads objects, keeps their things between visits.' },
  agent: { rank: 3, label: 'Agent', badge: '', doc: 'An agent signed in with AT Protocol (Roost): the same as a member.' },
  guest: { rank: 2, label: 'Guest', badge: '', doc: 'In the office without signing in: walks, chats and uses things, but keeps nothing.' },
  observer: { rank: 1, label: 'Observer', badge: '', doc: 'An MCP session that hasn\'t signed in: read-only tools only.' },
  banned: { rank: 0, label: 'Banned', badge: '🚫', doc: 'Kept out: can\'t walk in, and their MCP sessions are observers.' },
};

// What each capability needs, at least. Methods that need one for anything
// they do say so with `role` in their static api; methods that let people
// act on their own things and moderators act on anyone's use the
// capability named by `cap` (see entities/schema.js).
export const CAPS = {
  'people.kick': 'moderator',
  'people.mute': 'moderator',
  'people.move': 'moderator',
  'floor.remove': 'moderator',
  'uploads.remove': 'moderator',
  'notes.remove': 'moderator',
  'rooms.close': 'moderator',
  'rooms.policy': 'moderator',
  'bookings.override': 'moderator',
  'roles.view': 'moderator',
  'roles.grant': 'admin',
  'people.ban': 'admin',
  logs: 'admin',
  // Uploading plugins whose manifest asks for more than the basics (public/js/permissions.js).
  'plugins.trusted': 'moderator',
  'plugins.privileged': 'admin',
};

// The roles an admin can hand out in the panel (member = back to the default).
export const GRANTABLE = ['owner', 'admin', 'moderator', 'member', 'banned'];

export const rank = (role) => ROLES[role]?.rank ?? 0;
export const atLeast = (role, min) => rank(role) >= rank(min);
export const can = (role, cap) => !!CAPS[cap] && role !== 'banned' && atLeast(role, CAPS[cap]);
export const isRole = (r) => Object.hasOwn(ROLES, r);
export const roleLabel = (r) => ROLES[r]?.label || 'Guest';
// Name-tag badge: only for roles worth pointing out.
export const roleBadge = (r) => ROLES[r]?.badge || '';

// The role someone has when nobody granted them one.
export function defaultRole({ did = null, kind = 'human', mcp = false } = {}) {
  if (did) return kind === 'agent' ? 'agent' : 'member';
  return mcp ? 'observer' : 'guest';
}

// The env bootstrap: { owners: [did], admins: [did] } from OWNER_DIDS and
// ADMIN_DIDS (comma separated). Without OWNER_DIDS, the first ADMIN_DIDS
// entry is the owner, so an office set up before roles keeps one.
export function bootstrap(env = {}) {
  const list = (v) => String(v || '').split(',').map((d) => d.trim()).filter((d) => d.startsWith('did:'));
  const owners = list(env.OWNER_DIDS), admins = list(env.ADMIN_DIDS);
  if (!owners.length && admins.length) owners.push(admins[0]);
  return { owners, admins: admins.filter((d) => !owners.includes(d)) };
}

// Whoever someone is, their role: the MCP operator token is an owner; env
// owners and admins can't be demoted or banned from the office (only by
// changing the env); otherwise what was granted, else the default.
// `directory` is roles:main's view: { [did]: { role, ... } }.
export function effectiveRole({ did = null, kind = 'human', operator = false, mcp = false } = {}, directory = {}, env = {}) {
  if (operator) return 'owner';
  const fromEnv = did && (env.owners?.includes(did) ? 'owner' : env.admins?.includes(did) ? 'admin' : null);
  const granted = did ? directory?.[did]?.role : null;
  if (fromEnv) return granted && rank(granted) > rank(fromEnv) ? granted : fromEnv;
  if (granted && isRole(granted)) return granted;
  return defaultRole({ did, kind, mcp });
}

// May `by` (a role) change someone whose role is `from` to `to`? An error
// string, or null when they may. Admins hand out up to moderator and act on
// people below them; owners can do anything.
export function grantError(by, from, to) {
  if (!can(by, 'roles.grant')) return 'only admins can change roles';
  if (!GRANTABLE.includes(to)) return `pick one of ${GRANTABLE.join(', ')}`;
  if (by === 'owner') return null;
  if (rank(from) >= rank(by)) return `you can't change the role of a${from === 'admin' ? 'n' : ''} ${from}`;
  if (rank(to) >= rank(by)) return `only owners can make someone a${to === 'admin' || to === 'owner' ? 'n' : ''} ${to}`;
  return null;
}
