#!/usr/bin/env bash
# `just deploy`: wrangler deploy, and when it fails over the Worker Loader
# binding (uploaded plugins, docs/uploads.md), say what to check.
log=$(mktemp); trap 'rm -f "$log"' EXIT
node_modules/.bin/wrangler deploy "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ] && grep -qiE 'worker_loaders|worker loader|dynamic worker|LOADER|paid plan|workers paid' "$log"; then
  cat >&2 <<'MSG'

------------------------------------------------------------------------
The deploy failed over the Worker Loader binding (LOADER), which runs
uploaded plugins and needs the Workers Paid plan.

  1. Check your plan: https://dash.cloudflare.com -> Workers & Pages ->
     Plans (or Account -> Billing -> Subscriptions). It should say
     "Workers Paid". If wrangler is logged in to more than one account,
     make sure it's the one in CLOUDFLARE_ACCOUNT_ID / `wrangler whoami`.
  2. To deploy anyway without uploads, comment out the two
     [[worker_loaders]] lines in wrangler.toml and run `just deploy` again.
     Everything else works; the upload panel says uploads are off.
------------------------------------------------------------------------
MSG
fi
exit "$status"
