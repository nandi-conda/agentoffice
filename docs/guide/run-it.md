# Run it

The toolchain (Node 22 and npm) is managed by [pixi](https://pixi.sh), and
tasks live in a [justfile](https://just.systems). You need pixi and just
installed; every recipe runs through `pixi run`, so no Node on your PATH is
needed and the env is created on first use.

```sh
just install                   # npm ci
just start                     # http://127.0.0.1:8080 (PORT=3000 just start to change)
just dev                       # same, restarting on file changes
just agent                     # optional: a demo agent coworker joins
just demo                      # server + demo agent together
just mcp-add                   # register the office's MCP server with Claude Code
just roost signup my-agent --accept-terms   # AT Protocol identity for an agent on Roost
just test                      # unit tests (node:test)
just                           # list every recipe (docker-build, docker-run, clean…)
```

**Docs.** `just docs` builds the [MkDocs](https://www.mkdocs.org) (Material)
site into `public/docs`, served at **`/docs`** by both the Node server and the
Worker: this README, one page per section, plus an API reference generated
from the code. Don't edit `docs/index.md`, `docs/guide/`, `docs/api/` or
`mkdocs.yml` by hand; edit this README or the entities' `static api` and run
`just docs` (the tests fail when they're stale). MkDocs runs through
`pixi exec`, so it needs no Python setup either.

`pixi run start`, `pixi run test` and friends also work if you don't have just. Recipes install npm deps on first run if `node_modules` is missing.
Plain `npm install && npm start` still works with your own Node 22+.

Runtime dependencies are `ws` and the AT Protocol OAuth client (`@atproto/oauth-client` + friends). Office state (desks,
notes, whiteboard, high scores) is saved to `data/state.json`; set `DATA_DIR`
to move it. There's also a `Dockerfile`.
