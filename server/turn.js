// ICE servers for voice and video. With a Cloudflare Realtime TURN key
// (TURN_KEY_ID + TURN_KEY_API_TOKEN) we hand browsers short-lived TURN
// credentials, so calls still connect behind strict NATs and firewalls by
// relaying through Cloudflare. Without one, browsers get public STUN only and
// connect peer to peer where the network allows it.

export const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const API = 'https://rtc.live.cloudflare.com/v1/turn/keys/';
const TTL = 24 * 3600; // seconds a credential lives
const REFRESH = 6 * 3600; // re-mint once less than this is left

// Browsers block port 53, and trying it only slows ICE gathering down.
const no53 = (servers) => servers
  .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
  .filter((s) => s.urls.length);

export function createIce({ keyId = '', token = '', fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let cached = null; // { iceServers, expires }
  let pending = null;

  async function mint() {
    const res = await fetchImpl(`${API}${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TTL }),
    });
    if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
    const { iceServers } = await res.json();
    const servers = no53([].concat(iceServers || []));
    if (!servers.length) throw new Error('Cloudflare TURN returned no ICE servers');
    cached = { iceServers: servers, expires: now() + TTL * 1000 };
    return cached;
  }

  return {
    turn: !!(keyId && token),
    // { iceServers, ttl } for the browser; ttl is how long (s) to keep them.
    async get() {
      if (!keyId || !token) return { iceServers: STUN, ttl: TTL, turn: false };
      if (!cached || cached.expires - now() < REFRESH * 1000) {
        pending ||= mint().finally(() => { pending = null; });
        try { await pending; } catch (e) {
          // A hiccup at Cloudflare shouldn't take voice down for people on open networks.
          if (!cached || cached.expires <= now()) return { iceServers: STUN, ttl: 300, turn: false, error: e.message };
        }
      }
      return { iceServers: cached.iceServers, ttl: Math.floor((cached.expires - now()) / 1000) - REFRESH, turn: true };
    },
  };
}
