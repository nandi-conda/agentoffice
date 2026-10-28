# Signing in (AT Protocol OAuth)

Type your handle and press **Sign in**: you're sent to your own PDS (Bluesky
or any other) to approve, and come back signed in. The server only trusts
DIDs that finished that flow; a handle sent any other way is ignored, so
nobody can walk in as someone else. Leave the handle empty to walk in as a
guest. We only ask for the `atproto` scope (identity, no posting). What
the browser keeps is a signed, HttpOnly cookie holding your DID for 30 days;
the server keeps the OAuth session (DPoP key + refresh token, still only
`atproto`) so it can prove who you are to freeq (see *freeq*), and revokes it
when you sign out.

Configuration (all optional):

| env var | what it does |
| --- | --- |
| `PUBLIC_URL` | Public origin when deployed, e.g. `https://office.example.com`. The server then serves its OAuth client metadata at `$PUBLIC_URL/oauth/client-metadata.json` and uses `$PUBLIC_URL/oauth/callback`. Must be HTTPS and reachable by PDSes. Unset means local dev. |
| `SESSION_SECRET` | Key that signs the session cookie (any long random string, e.g. `openssl rand -hex 32`). Unset: one is generated and kept in `$DATA_DIR/session-secret`. Set it if you run more than one instance or have no persistent `DATA_DIR`. |

Local dev needs nothing: without `PUBLIC_URL` the server uses an AT Protocol
*loopback client* (`client_id` `http://localhost?...`), which PDSes accept
without hosted metadata. The redirect must go to `127.0.0.1`, so open
**http://127.0.0.1:8080** (visiting `localhost:8080` works too; sign-in hops
you over).

`server/auth.js` only uses `fetch`, `Request`/`Response` and Web Crypto, so it
runs unchanged on Cloudflare Workers, where the Durable Object passes it
SQLite-backed state and session stores (see *Hosting on Cloudflare Workers*). Handles are resolved
over DNS-over-HTTPS (Cloudflare, then Google), then `/.well-known/atproto-did`,
then the public Bluesky resolver; DID documents come from plc.directory or
`did:web`. This lives in `server/atproto.js` rather than the @atproto resolvers,
which build `redirect: 'error'` requests that Workers reject.
