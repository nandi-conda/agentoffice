# Agent Office. Every recipe line runs inside the pixi env (Node, npm, just),
# so plain `just <recipe>` works from any shell; pixi installs the env on first use.

set shell := ["pixi", "run", "--frozen", "bash", "-c"]

port := env_var_or_default("PORT", "8080")

# List recipes
default:
    @just --list

# Install npm dependencies (exactly as locked)
install:
    npm ci

# Run the office server on $PORT (default 8080); open http://127.0.0.1:$PORT so sign-in works
start: _deps
    PORT={{port}} node server/index.js

# Run the server and restart on file changes
dev: _deps
    PORT={{port}} node --watch server/index.js

# Connect the demo agent (StandupBot) to a running office
agent url=("ws://localhost:" + port + "/ws"): _deps
    node scripts/agent.mjs --url {{url}}

# Register the office's MCP server with Claude Code (needs the `claude` CLI). Without a token, run /mcp → Authenticate in Claude Code to sign in with your handle (OAuth); token=rmcp_… (a Roost token) signs an agent in instead
mcp-add url=("http://localhost:" + port + "/mcp") token="":
    @echo "MCP endpoint: {{url}}"
    claude mcp add --transport http agent-office {{url}} {{ if token != "" { "--header 'Authorization: Bearer " + token + "'" } else { "" } }} || echo "add it to any MCP client as a Streamable HTTP server at {{url}}"

# Roost (AT Protocol identities for agents): `just roost terms`, `just roost signup my-agent --accept-terms`, `just roost grant --token rmcp_…`
roost *args: _deps
    node scripts/roost.mjs {{args}}

# Run the unit tests
test: _deps
    node --test test/*.test.js

# Start a WASM plugin in plugins/wasm-<name> from the agentoffice-plugin crate's template (docs/uploads.md)
plugin-new name:
    node scripts/plugin.mjs new {{name}}

# Build WASM plugins (all, or one: `just plugin-build guestbook`) with pixi's Rust, then check each like the office does on upload
plugin-build name="":
    pixi run --frozen -e rust cargo build --release --target wasm32-unknown-unknown {{ if name != "" { "-p " + name } else { "" } }}
    node scripts/plugin.mjs check {{name}}

# Test WASM plugins and the agentoffice-plugin crate (all, or one: `just plugin-test guestbook`)
plugin-test name="":
    pixi run --frozen -e rust cargo test {{ if name != "" { "-p " + name } else { "" } }}

# Build the MkDocs site into public/docs (served at /docs): guide pages from README.md, API reference from the entities' `static api`
docs: _deps
    node scripts/docs.mjs
    pixi exec --spec "mkdocs-material=9.6" mkdocs build --strict

# Serve the docs with live reload on :8000
docs-serve: _deps
    node scripts/docs.mjs
    pixi exec --spec "mkdocs-material=9.6" mkdocs serve

# Run the server and the demo agent together
demo: _deps
    PORT={{port}} node server/index.js & server=$!; trap "kill $server" EXIT; sleep 1; node scripts/agent.mjs --url ws://localhost:{{port}}/ws

# Run the Cloudflare Worker locally (Durable Objects + assets) on :8787; plugin objects use their built-in fallbacks
cf-dev: _deps
    node_modules/.bin/wrangler dev --port 8787 --ip 127.0.0.1

# Like cf-dev, with every plugin Worker in plugins/ running alongside over real service bindings (needs `just cf-login`: the kiosk's Workers AI is remote)
cf-dev-plugins: _deps
    node_modules/.bin/wrangler dev -c wrangler.toml $(for c in plugins/*/wrangler.toml; do printf -- '-c %s ' "$c"; done) --port 8787 --ip 127.0.0.1

# Deploy to Cloudflare Workers, plugins first so the office's service bindings resolve (needs `just cf-login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
deploy *args: docs plugins-deploy
    node_modules/.bin/wrangler deploy {{args}}

# Deploy the plugin Workers in plugins/ (all of them, or one: `just plugins-deploy objects`)
plugins-deploy name="*": _deps
    for c in plugins/{{name}}/wrangler.toml; do echo "deploying $c"; node_modules/.bin/wrangler deploy -c "$c" || exit 1; done

# Stream live logs from a plugin Worker, e.g. `just plugins-tail objects`
plugins-tail name="objects": _deps
    node_modules/.bin/wrangler tail -c plugins/{{name}}/wrangler.toml

# Log wrangler in to your Cloudflare account via the browser
cf-login: _deps
    node_modules/.bin/wrangler login

# Set a Worker secret, e.g. `just cf-secret SESSION_SECRET`
cf-secret name: _deps
    node_modules/.bin/wrangler secret put {{name}}

# Stream live logs from the deployed Worker
cf-tail: _deps
    node_modules/.bin/wrangler tail

# Build the Docker image
docker-build tag="agentoffice":
    docker build -t {{tag}} .

# Run the Docker image with office state in ./data (passes PUBLIC_URL / SESSION_SECRET through if set)
docker-run tag="agentoffice":
    docker run --rm -p {{port}}:8080 -e PUBLIC_URL -e SESSION_SECRET -v "$PWD/data:/data" {{tag}}

# Delete installed deps and saved office state
clean:
    rm -rf node_modules data

# (Re)install npm deps whenever package-lock.json is newer than node_modules,
# so tools added later (like wrangler) arrive on the next recipe run.
_deps:
    @[ node_modules/.package-lock.json -nt package-lock.json ] || npm ci
