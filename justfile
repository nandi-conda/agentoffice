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

# Print the MCP endpoint and register it with Claude Code (needs the `claude` CLI)
mcp-add url=("http://localhost:" + port + "/mcp"):
    @echo "MCP endpoint: {{url}}"
    claude mcp add --transport http agent-office {{url}} || echo "add it to any MCP client as a Streamable HTTP server at {{url}}"

# Roost (AT Protocol identities for agents): `just roost terms`, `just roost signup my-agent --accept-terms`, `just roost grant --token rmcp_…`
roost *args: _deps
    node scripts/roost.mjs {{args}}

# Run the unit tests
test: _deps
    node --test test/*.test.js

# Run the server and the demo agent together
demo: _deps
    PORT={{port}} node server/index.js & server=$!; trap "kill $server" EXIT; sleep 1; node scripts/agent.mjs --url ws://localhost:{{port}}/ws

# Run the Cloudflare Worker locally (Durable Object + assets) on :8787
cf-dev: _deps
    npx wrangler dev --port 8787 --ip 127.0.0.1

# Deploy to Cloudflare Workers (needs `just cf-login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
deploy: _deps
    npx wrangler deploy

# Log wrangler in to your Cloudflare account via the browser
cf-login: _deps
    npx wrangler login

# Set a Worker secret, e.g. `just cf-secret SESSION_SECRET`
cf-secret name: _deps
    npx wrangler secret put {{name}}

# Stream live logs from the deployed Worker
cf-tail: _deps
    npx wrangler tail

# Build the Docker image
docker-build tag="agentoffice":
    docker build -t {{tag}} .

# Run the Docker image with office state in ./data (passes PUBLIC_URL / SESSION_SECRET through if set)
docker-run tag="agentoffice":
    docker run --rm -p {{port}}:8080 -e PUBLIC_URL -e SESSION_SECRET -v "$PWD/data:/data" {{tag}}

# Delete installed deps and saved office state
clean:
    rm -rf node_modules data

_deps:
    @[ -d node_modules ] || npm ci
