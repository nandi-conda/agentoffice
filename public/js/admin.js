// The 🛡️ panel for moderators and up: who's in and their roles, mute, move
// and kick them, and (admins) grant roles. Every action is a { t: 'mod' }
// message answered with { t: 'modres' }; the World checks each one again
// (Office.call), so this only hides buttons people can't use.

import { ask } from './ask.js';
import { ROLES, GRANTABLE, can, rank, roleBadge, grantError } from './roles.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A badge for the roles worth pointing out (moderator and up, and banned).
export const roleTag = (role) => (rank(role) >= rank('moderator') || role === 'banned'
  ? `<span class="badge role role-${role}" title="${esc(ROLES[role].doc)}">${roleBadge(role)} ${ROLES[role].label.toUpperCase()}</span>`
  : '');

// request(op, fields) → Promise of the result ({ … } or { error }).
export function openAdmin(modal, { me, request, toast, fmtTime, zoneName }) {
  let data = null;
  const mayGrant = can(me.role, 'roles.grant');
  const options = (from) => GRANTABLE.filter((r) => r === from || !grantError(me.role, from, r))
    .map((r) => `<option value="${r}"${r === from ? ' selected' : ''}>${ROLES[r].label}</option>`).join('');
  const editable = (did, role, env) => mayGrant && did && did !== me.did && !env && (me.role === 'owner' || rank(role) < rank(me.role));
  const roleCell = (did, role, env) => (editable(did, role, env)
    ? `<select class="adm-role" data-did="${esc(did)}" aria-label="Role">${options(GRANTABLE.includes(role) ? role : 'member')}</select>`
    : `<span class="small">${roleBadge(role)} ${ROLES[role]?.label || role}${env ? ' <span class="muted">(env)</span>' : ''}</span>`);
  const lower = (p) => p.id !== me.id && p.kind !== 'freeq' && (me.role === 'owner' || rank(p.role) < rank(me.role));

  const render = () => {
    const online = data?.online || [];
    const granted = Object.entries(data?.granted || {});
    modal.open(`
      <h2>🛡️ Moderation</h2>
      <p class="small muted">You're ${roleBadge(me.role)} <b>${ROLES[me.role].label}</b>: ${esc(ROLES[me.role].doc)}</p>
      <h3>In the office (${online.length})</h3>
      ${!data ? '<p class="muted small">Loading…</p>' : `<div class="adm-list">${online.map((p) => `
        <div class="adm-row" data-id="${esc(p.id)}">
          <span class="grow"><b>${esc(p.name)}</b> ${roleTag(p.role)}${p.muted ? ` <span class="small">🔇 until ${esc(fmtTime(p.muted))}</span>` : ''}<br>
            <small class="muted">${esc([p.handle && `@${p.handle}`, p.kind, zoneName(p.zone)].filter(Boolean).join(' · '))}</small></span>
          ${roleCell(p.did, p.role, data.granted[p.did]?.env)}
          ${lower(p) ? `<span class="adm-acts">
            ${p.muted ? '<button class="btn ghost" data-act="unmute">Unmute</button>' : '<button class="btn ghost" data-act="mute" title="No chat or mic for 10 minutes">Mute</button>'}
            <button class="btn ghost" data-act="move" title="Send them to the lobby">To lobby</button>
            <button class="btn ghost danger" data-act="kick">Kick</button></span>` : ''}
        </div>`).join('')}</div>`}
      <h3>Roles</h3>
      ${granted.length ? `<div class="adm-list">${granted.map(([did, g]) => `
        <div class="adm-row"><span class="grow"><b>${esc(g.name || g.handle || did)}</b><br><small class="muted">${esc(g.handle ? `@${g.handle} · ` : '')}${esc(did)}${g.by ? ` · by ${esc(g.by)}` : ''}</small></span>
          ${roleCell(did, g.role, g.env)}</div>`).join('')}</div>` : '<p class="muted small">Nobody has a role yet besides the defaults.</p>'}
      ${mayGrant ? `<form class="adm-grant row"><input class="adm-to" maxlength="253" placeholder="DID, or the name or handle of someone here" aria-label="Who">
        <select class="adm-new" aria-label="Role">${options('member')}</select><button class="btn primary">Grant</button></form>
        <p class="small muted">Owners and admins from OWNER_DIDS / ADMIN_DIDS can only be changed in the env.</p>` : ''}`, 'admin-modal');
    // modal.open closes what was open, this panel included, so claim it again.
    modal.admin = api;
    modal.onclose = () => { if (modal.admin === api) modal.admin = null; };
    const b = modal.body;
    b.querySelectorAll('.adm-row button[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const p = online.find((x) => x.id === btn.closest('.adm-row').dataset.id);
      const act = btn.dataset.act;
      if (act === 'kick' && !(await ask(btn, `Send ${p.name} out of the office?`, 'Kick'))) return;
      const reason = act === 'kick' || act === 'mute' ? (prompt(`Why? ${p.name} sees this (optional)`) || undefined) : undefined;
      btn.disabled = true;
      const r = await request(act, { to: p.id, reason, ...(act === 'move' ? { place: 'lobby' } : {}), ...(act === 'mute' ? { minutes: 10 } : {}) });
      if (r.error) toast(`⚠️ ${esc(r.error)}`);
      load();
    }));
    b.querySelectorAll('.adm-role').forEach((sel) => sel.addEventListener('change', async () => {
      const role = sel.value;
      if (role === 'banned' && !(await ask(sel, 'Ban them? They are sent out and kept out.', 'Ban'))) return load();
      const r = await request('grant', { to: sel.dataset.did, role });
      if (r.error) toast(`⚠️ ${esc(r.error)}`);
      load();
    }));
    b.querySelector('.adm-grant')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const to = b.querySelector('.adm-to').value.trim();
      if (!to) return;
      const r = await request('grant', { to, role: b.querySelector('.adm-new').value });
      if (r.error) toast(`⚠️ ${esc(r.error)}`); else toast(`${roleBadge(r.role)} ${esc(to)} is now ${ROLES[r.role]?.label.toLowerCase() || r.role}`);
      load();
    });
  };
  const load = async () => { data = await request('people', {}); if (data.error) { toast(`⚠️ ${esc(data.error)}`); data = { online: [], granted: {} }; } if (modal.admin === api) render(); };
  const api = { refresh: load };
  render();
  load();
  return api;
}
