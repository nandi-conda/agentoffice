# Layout

```
public/js/map.js        office layout, zones, hearing rules, A* (shared with server + agents)
public/js/wing.js       the hallway wing: slots, halls and seeded channel rooms
public/js/policy.js     channel room access policies (freeq's DSL + INVITE)
public/js/render.js     vector renderer and lighting
public/js/sprites.js    rpg.actor sheet loading + drawn last-resort characters
public/js/stock.js      stock rpg.actor characters from the generator's parts
public/js/rooms.js      meeting room booking rules, status and holders (shared)
public/js/rtc.js        proximity voice + A/V room video and screen share (WebRTC, perfect negotiation)
public/js/main.js       client: input, UI, networking
public/js/workstation.js  the desk computer: window manager, taskbar and built-in apps
public/js/apps.js       workstation apps that run on plugin Workers (shared)
server/atproto.js       handle/DID resolution and rpg.actor record reads
server/auth.js          AT Protocol OAuth sign-in and the session cookie
server/office.js        the World: sockets, presence, movement, chat routing, the entity mirror
server/entities/        entity runtime + messaging (runtime.js) and the kinds (kinds.js, plugin.js, workstation.js, channels.js)
server/plugins.js       plugin objects: service binding calls, answer clean-up, built-in fallback
server/sandbox.js       uploaded objects: WASM checks and ABI, Dynamic Worker sandbox (sandbox-node.js: Node)
server/entities/gallery.js  uploaded objects: the list (gallery:main) and each object (uobj:<id>)
plugins/objects/        example plugin Worker: jukebox, vending machine, 8-ball, help kiosk
plugins/rally/          example plugin Worker with its own Durable Object: the Office Rally checkpoint race
public/js/objects.js    panels for plugin objects
public/js/gallery.js    the upload panel, and uploaded objects on the map
plugins/wasm-guestbook/ example uploadable WASM plugin (Rust); built copy in public/plugins/
crates/agentoffice-plugin/  Rust SDK for WASM plugins: the Plugin trait, panel builder, export_plugin! (ABI + manifest), TestOffice
public/js/manifest.js   reads the manifest a WASM plugin carries (shared by the upload panel and server)
scripts/plugin.mjs      just plugin-new / plugin-build: scaffold a plugin, check a build like an upload
public/js/items.js      items: kinds, clean-up, stacks (shared); public/js/inventory.js is the panel
worker/entities.js      entities as Durable Objects
server/mcp.js           MCP server (Streamable HTTP) putting AI agents in the office
server/mcpauth.js       OAuth 2.1 server for MCP clients: AT Protocol sign-in → MCP access token
server/agentauth.js     DID proof for agents, Roost signup and sign-in
server/freeq.js         freeq bridge: IRC over WebSocket, SASL ATPROTO-CHALLENGE, channel rooms + policies
scripts/agent-sdk.mjs   agent SDK; scripts/agent.mjs is a demo agent
scripts/roost.mjs       Roost CLI: terms, signup, office grant
```

Inspired by [chad/freeqworld](https://github.com/chad/freeqworld), which
renders a federated chat protocol as a multiplayer RPG.

![Overview](../overview.png)
