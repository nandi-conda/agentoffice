// Picking the freeq bridge back up after a restart, without pretending the
// whole of freeq walked out and back in.
//
// The bridge keeps a small snapshot in whatever storage it's given (a JSON
// file under Node, a SQLite row in the Durable Object):
//
//   { v: 1, at,                                   // when it was written (ms)
//     bindings: { zoneId: { channel, topic, last } },
//     people:   [{ nick, channels, active, zone, x, y, did, handle, actor }],
//     seen:     { '#chan': { ts, ids } } }        // newest message heard per channel
//
// On a restart it puts the snapshot's people back where they stood, marked
// stale. Once freeq answers NAMES for a channel, whoever is still stale for it
// really left, and anyone new really came in. Messages newer than `seen` are
// fetched from freeq's REST history and played into the area as catch-up.
//
// Nothing here touches the network or the office; freeq.js does that.

export const SNAPSHOT_VERSION = 1;
export const RESTORE_MAX_MS = 30 * 60 * 1000; // older snapshots aren't worth drawing people from
export const BACKFILL_MAX_S = 6 * 60 * 60; // don't catch up on more than six hours
export const BACKFILL_LIMIT = 30; // per channel

const lower = (s) => String(s || '').toLowerCase();

// The newest message heard in each channel, as { ts (unix seconds), ids }.
// `ids` are the msgids heard at exactly `ts`, so a history page that repeats
// that second doesn't repeat them.
export class Seen {
  constructor(saved = {}) {
    this.map = new Map(Object.entries(saved || {}).map(([k, v]) => [lower(k), { ts: Number(v.ts) || 0, ids: [...(v.ids || [])] }]));
    this.recent = new Set(); // msgids heard since this process started
  }

  get(channel) { return this.map.get(lower(channel)) || null; }

  // Record a message. Returns false if it was already heard (a duplicate).
  hear(channel, ts, msgid) {
    if (msgid) {
      if (this.recent.has(msgid)) return false;
      this.recent.add(msgid);
      if (this.recent.size > 1000) this.recent.delete(this.recent.values().next().value);
    }
    const key = lower(channel), cur = this.map.get(key);
    if (!cur || ts > cur.ts) this.map.set(key, { ts, ids: msgid ? [msgid] : [] });
    else if (ts === cur.ts && msgid && !cur.ids.includes(msgid)) cur.ids.push(msgid);
    return true;
  }

  toJSON() { return Object.fromEntries(this.map); }
}

// From a freeq history page (any order), the messages after `seen`, oldest
// first. Nothing when there's no `seen` (we never listened here, so nothing
// was missed) or it's too old to be worth replaying.
export function missedSince(rows, seen, { nowS = Date.now() / 1000, recent = new Set(), limit = BACKFILL_LIMIT, maxAgeS = BACKFILL_MAX_S } = {}) {
  if (!seen || !Array.isArray(rows) || nowS - seen.ts > maxAgeS) return [];
  const out = rows
    .filter((r) => r && typeof r.text === 'string' && Number(r.timestamp) >= seen.ts)
    .filter((r) => !(r.msgid && (recent.has(r.msgid) || seen.ids?.includes(r.msgid))))
    // Same second but no msgid to tell them apart: only what's strictly newer.
    .filter((r) => r.msgid || Number(r.timestamp) > seen.ts)
    .sort((a, b) => a.timestamp - b.timestamp || (a.id ?? 0) - (b.id ?? 0));
  return out.slice(-limit);
}

// A server-time tag ("2026-10-28T23:00:00.123Z") as unix seconds, else now.
export const tagSeconds = (time, nowMs = Date.now()) => {
  const t = time ? Date.parse(time) : NaN;
  return Math.floor((Number.isFinite(t) ? t : nowMs) / 1000);
};

// A snapshot worth restoring people from (seen is always worth keeping).
export function usable(snap, nowMs = Date.now()) {
  return !!snap && snap.v === SNAPSHOT_VERSION && nowMs - (snap.at || 0) < RESTORE_MAX_MS;
}

// Writes the snapshot at most every `ms`, so a busy channel doesn't hammer storage.
export class Saver {
  constructor(store, build, { ms = 2000, log = () => {} } = {}) {
    Object.assign(this, { store, build, ms, log });
    this.timer = null;
  }

  soon() {
    if (!this.store || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.now(); }, this.ms);
  }

  async now() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.store) return;
    try { await this.store.set(this.build()); } catch (e) { this.log(`freeq: couldn't save the snapshot: ${e.message}`); }
  }

  cancel() { clearTimeout(this.timer); this.timer = null; }
}
