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

# Run the office server on $PORT (default 8080)
start: _deps
    PORT={{port}} node server/index.js

# Run the server and restart on file changes
dev: _deps
    PORT={{port}} node --watch server/index.js

# Connect the demo agent (StandupBot) to a running office
agent url=("ws://localhost:" + port + "/ws"): _deps
    node scripts/agent.mjs --url {{url}}

# Run the unit tests
test: _deps
    node --test test/*.test.js

# Run the server and the demo agent together
demo: _deps
    PORT={{port}} node server/index.js & server=$!; trap "kill $server" EXIT; sleep 1; node scripts/agent.mjs --url ws://localhost:{{port}}/ws

# Build the Docker image
docker-build tag="agentoffice":
    docker build -t {{tag}} .

# Run the Docker image with office state in ./data
docker-run tag="agentoffice":
    docker run --rm -p {{port}}:8080 -v "$PWD/data:/data" {{tag}}

# Delete installed deps and saved office state
clean:
    rm -rf node_modules data

_deps:
    @[ -d node_modules ] || npm ci
