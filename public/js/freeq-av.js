// Voice and video in freeq-bridged channel rooms. Such a room's call is the
// freeq channel's own call, so people in freeq's apps are on it too: the
// office server starts or joins it over the person's freeq IRC connection
// (server/freeq.js) and hands back the session, our nick and a token; the
// browser then publishes one MoQ broadcast `{session}/{nick}~{instance}` and
// watches everyone else's, straight to freeq's media server, with the same
// <moq-publish> / <moq-watch> builds freeq's web app uses (public/vendor/moq).
//
// It's never required: guests, a room freeq isn't bridging, or a join that
// fails all fall back to the office's own WebRTC voice (rtc.js). Pairs who are
// both on the freeq call skip WebRTC (onCall), so nobody is heard twice.

const BASE = '/vendor/moq/';
let loading = null;
export const loadMoq = () => (loading ||= Promise.all([import(`${BASE}publish-Du5ksDQe.js`), import(`${BASE}watch-CTz_Tjt7.js`)])
  .catch((e) => { loading = null; throw e; }));

// freeq's per-device id: 8 lowercase hex characters.
const newInstance = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

const pathOf = (session, nick, instance) => (instance ? `${session}/${nick}~${instance}` : `${session}/${nick}`);

// H.264 (capped at 1080p) before `source` starts the encoder, as freeq's app
// does: native freeq clients can't hardware-decode the AV1 browsers prefer.
function pinH264(pub) {
  const cfg = { codec: 'avc1', maxPixels: 1920 * 1080 };
  try { pub.broadcast?.video?.hd?.config?.set(cfg); pub.broadcast?.video?.sd?.config?.set(cfg); } catch { /* older bundle */ }
}

export function createFreeqCall({ send, stage, onChange = () => {}, toast = () => {} }) {
  let zone = null;     // the bridged room we're standing in
  let talk = false;    // whether we want to be on its call (voice on, signed in)
  let call = null;     // { session, count, roster, token, url } from the server
  let channel = null;
  let joined = null;   // { session, nick, instance, token } once freeq has us
  let joining = false;
  let pub = null;      // our <moq-publish> (mic, and camera when on)
  let selfTile = null; // our own camera, in the stage, while it's on
  let screenPub = null; // a second one for our screen: `{broadcast}/screen`, as freeq's app does
  let screenOff = null; // unhooks the "Stop sharing" watch
  let cam = false, muted = false, deaf = false;
  const failed = new Set(); // rooms where joining failed: WebRTC there until we come back
  const watches = new Map(); // broadcast path -> { el, tile }
  let head = null;     // the call's header tile in the stage
  let instance = newInstance();

  const dialUrl = () => {
    const u = `${call?.url || 'wss://irc.freeq.at/av/moq'}?inst=${encodeURIComponent(instance)}`;
    const token = joined?.token || call?.token;
    return token ? `${u}&jwt=${encodeURIComponent(token)}` : u;
  };

  // ---- publishing -----------------------------------------------------------

  function stopPublish() {
    if (!pub) return;
    // Clearing `source` (removeAttribute, never '') is what closes the capture.
    pub.muted = true; pub.setAttribute('muted', '');
    pub.removeAttribute('source');
    pub.setAttribute('url', '');
    pub.remove();
    pub = null;
    selfTile?.remove(); selfTile = null;
  }

  async function startPublish() {
    stopPublish();
    if (!joined) return;
    await loadMoq();
    if (!joined) return;
    pub = document.createElement('moq-publish');
    pub.hidden = !cam;
    pub.setAttribute('url', dialUrl());
    pub.setAttribute('name', pathOf(joined.session, joined.nick, instance));
    pinH264(pub);
    // `invisible` before `source`: audio only, so a busy camera can't sink the call.
    if (!cam) pub.setAttribute('invisible', '');
    if (muted) { pub.setAttribute('muted', ''); pub.muted = true; }
    pub.setAttribute('source', 'camera');
    if (!cam) { stage.append(pub); return; }
    // With the camera on, a <video> inside the element gets its own preview:
    // that's our "You" tile, next to everyone else's.
    pub.append(Object.assign(document.createElement('video'), { muted: true, autoplay: true, playsInline: true }));
    selfTile = document.createElement('div');
    selfTile.className = 'tile cam self fq';
    selfTile.innerHTML = '<span class="tag">You</span><button class="grow-btn" title="Enlarge">⤢</button>';
    selfTile.querySelector('.grow-btn').onclick = () => selfTile.classList.toggle('big');
    selfTile.prepend(pub);
    head ? head.after(selfTile) : stage.prepend(selfTile);
  }

  function stopScreen() {
    screenOff?.(); screenOff = null;
    if (!screenPub) return;
    screenPub.removeAttribute('source');
    screenPub.setAttribute('url', '');
    screenPub.remove();
    screenPub = null;
  }

  // Share our screen on its own broadcast, video only (muted before `source`
  // so no tab audio goes out). `source="screen"` opens the browser's picker.
  async function startScreen() {
    stopScreen();
    if (!joined || !navigator.mediaDevices?.getDisplayMedia) return false;
    await loadMoq();
    if (!joined) return false;
    const el = screenPub = document.createElement('moq-publish');
    el.hidden = true;
    el.setAttribute('url', dialUrl());
    el.setAttribute('name', `${pathOf(joined.session, joined.nick, instance)}/screen`);
    pinH264(el);
    el.setAttribute('muted', ''); el.muted = true;
    stage.append(el);
    el.setAttribute('source', 'screen');
    // The capture shows up on el.video.source ({ video, audio } for screens);
    // its track ending is the browser's own "Stop sharing" button.
    let track = null, inner = null;
    const ended = () => { if (screenPub === el) { stopScreen(); onChange(); } };
    const outer = el.video?.subscribe?.((v) => {
      inner?.(); inner = null;
      inner = v?.source?.subscribe?.((val) => {
        track?.removeEventListener('ended', ended);
        track = val instanceof MediaStreamTrack ? val : val?.video || null;
        track?.addEventListener('ended', ended);
      });
    });
    screenOff = () => { inner?.(); outer?.(); track?.removeEventListener('ended', ended); };
    return true;
  }

  // ---- watching -------------------------------------------------------------

  function dropWatch(key) {
    const w = watches.get(key);
    if (!w) return;
    // Pause first: removing the element alone keeps its audio playing.
    w.off?.();
    w.el.paused = true;
    w.el.setAttribute('url', ''); w.el.setAttribute('name', '');
    w.tile.remove();
    watches.delete(key);
  }

  async function syncWatches() {
    const want = new Map();
    if (joined && call?.session === joined.session) {
      for (const r of call.roster || []) {
        if (r.instance === instance || (!r.instance && r.nick === joined.nick)) continue;
        want.set(pathOf(joined.session, r.nick, r.instance), r);
        want.set(`${pathOf(joined.session, r.nick, r.instance)}/screen`, { ...r, screen: true });
      }
    }
    for (const key of [...watches.keys()]) if (!want.has(key)) dropWatch(key);
    if (want.size && [...want.keys()].some((k) => !watches.has(k))) await loadMoq().catch(() => toast('📞 Couldn\'t load the freeq call player.'));
    for (const [key, r] of want) {
      if (watches.has(key) || !customElements.get('moq-watch')) continue;
      const tile = document.createElement('div');
      // A screen tile waits, nearly invisible but on screen (the watcher only
      // runs while its canvas intersects), until that broadcast goes live.
      tile.className = r.screen ? 'tile screen fq waiting' : 'tile cam fq';
      tile.innerHTML = '<span class="tag"></span><button class="grow-btn" title="Enlarge">⤢</button>';
      tile.querySelector('.grow-btn').onclick = () => tile.classList.toggle('big');
      tile.querySelector('.tag').textContent = r.screen ? `${r.nick}'s screen` : r.nick;
      const el = document.createElement('moq-watch');
      // The watcher only decodes while its canvas is on screen, so the tile stays visible.
      el.append(document.createElement('canvas'));
      el.setAttribute('jitter', '80');
      el.setAttribute('reload', '');
      if (deaf) el.setAttribute('muted', '');
      el.setAttribute('url', dialUrl());
      el.setAttribute('name', key);
      tile.prepend(el);
      stage.append(tile);
      const w = { el, tile, off: null };
      if (!r.screen) {
        // Audio-only (camera off): a name chip instead of a black box. Only once
        // the catalog has arrived and says so; anything unexpected shows the video.
        const catalog = el.broadcast?.catalog;
        const show = (c) => { tile.classList.toggle('nocam', !!(c && c.audio && !c.video)); onChange(); };
        show(catalog?.peek?.());
        w.off = catalog?.subscribe?.(show) || null;
      }
      if (r.screen) {
        const status = el.broadcast?.status;
        const show = (st) => { tile.classList.toggle('waiting', st !== 'live'); onChange(); };
        show(status?.peek?.());
        w.off = status?.subscribe?.(show) || null;
      }
      watches.set(key, w);
    }
    paintHead();
  }

  function paintHead() {
    const show = !!(joined && call);
    if (!show) { head?.remove(); head = null; return; }
    if (!head) {
      head = document.createElement('div');
      head.className = 'fq-call';
      stage.prepend(head);
    }
    const n = call.count || call.roster?.length || 1;
    head.innerHTML = `<b>📞 ${esc(channel || 'freeq')} call</b> <small>${n} on the call, shared with freeq</small>
      <small class="muted">Runs on freeq's media server: audio over its WebSocket path can crackle, and it doesn't require tokens yet, so others on freeq could listen in.</small>`;
  }

  // ---- joining and leaving --------------------------------------------------

  function join() {
    if (joining || joined || !zone || failed.has(zone)) return;
    joining = true;
    send({ t: 'fq-call', op: 'join', zone, instance });
    // No answer at all (freeq or our connection to it is down): fall back like an error.
    const z = zone;
    setTimeout(() => { if (joining && zone === z) onMessage({ zone: z, call, error: 'no answer from freeq' }); }, 20000);
  }

  function leave() {
    if (joined || joining) send({ t: 'fq-call', op: 'leave' });
    joined = null; joining = false;
    stopPublish(); stopScreen();
    for (const key of [...watches.keys()]) dropWatch(key);
    paintHead();
    instance = newInstance();
    onChange();
  }

  // Every frame: which bridged room we're in (or null) and whether we want to talk.
  function want(zoneId, wantTalk) {
    if (zoneId !== zone) {
      leave();
      if (zone) failed.delete(zone);
      zone = zoneId; call = null; channel = null; cam = false;
      if (zone) send({ t: 'fq-call', op: 'look', zone });
    }
    if (wantTalk !== talk) { talk = wantTalk; if (!talk) leave(); }
    if (zone && talk) join();
  }

  function onMessage(m) {
    if (m.zone !== zone) return;
    call = m.call; channel = m.channel || channel;
    if (m.error && joining) {
      joining = false;
      failed.add(zone);
      toast(`📞 Couldn't join ${esc(channel || 'the')} freeq call (${esc(m.error)}). Using the office's own voice in here instead.`, [], 6000);
    }
    if (m.joined) {
      joining = false;
      const first = !joined;
      joined = m.joined;
      if (first) toast(`📞 You're on ${esc(channel)}'s call, shared with people on freeq.`, [], 4000);
      startPublish().catch(() => { toast('📞 Couldn\'t start publishing to the freeq call.'); leave(); failed.add(zone); });
    }
    if (m.dropped && joined) { joined = null; stopPublish(); stopScreen(); }
    if (joined && call?.session && call.session !== joined.session) { joined = null; stopPublish(); stopScreen(); }
    syncWatches();
    onChange();
  }

  return {
    want, onMessage,
    // Is this office person on the same freeq call as us (so rtc.js leaves them be)?
    onCall: (p) => !!(joined && p.did && call?.session === joined.session && call.roster?.some((r) => r.did === p.did)),
    setMuted(on) {
      muted = on;
      if (pub) { pub.muted = on; on ? pub.setAttribute('muted', '') : pub.removeAttribute('muted'); }
    },
    setDeaf(on) {
      if (on === deaf) return;
      deaf = on;
      for (const { el } of watches.values()) on ? el.setAttribute('muted', '') : el.removeAttribute('muted');
    },
    // The camera goes out on the same broadcast; changing it re-announces.
    async setCam(on) { cam = on; if (joined) await startPublish(); onChange(); },
    get cam() { return cam && !!joined; },
    get camWanted() { return cam; },
    async setScreen(on) { const ok = on ? await startScreen() : (stopScreen(), true); onChange(); return ok; },
    get screen() { return !!screenPub; },
    get joined() { return !!joined; },
    get tiles() { return !!head; },
    get zone() { return zone; },
    usable: (zoneId) => !failed.has(zoneId),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
