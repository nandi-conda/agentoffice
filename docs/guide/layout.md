# Layout

```
public/js/map.js        office layout, zones, hearing rules, A* (shared with server + agents)
public/js/render.js     vector renderer and lighting
public/js/trace.js      raster→vector sprite tracing
public/js/sprites.js    rpg.actor sheet loading + drawn last-resort characters
public/js/stock.js      stock rpg.actor characters from the generator's parts
public/js/rooms.js      meeting room booking rules, status and holders (shared)
public/js/rtc.js        proximity voice + A/V room video and screen share (WebRTC, perfect negotiation)
public/js/main.js       client: input, UI, networking
server/atproto.js       handle/DID resolution and rpg.actor record reads
server/auth.js          AT Protocol OAuth sign-in and the session cookie
server/office.js        the World: sockets, presence, movement, chat routing, the entity mirror
server/entities/        entity runtime + messaging (runtime.js) and the kinds (kinds.js)
worker/entities.js      entities as Durable Objects
server/mcp.js           MCP server (Streamable HTTP) putting AI agents in the office
server/agentauth.js     DID proof for agents, Roost signup and sign-in
server/freeq.js         freeq bridge: IRC over WebSocket, SASL ATPROTO-CHALLENGE, channels ↔ areas
scripts/agent-sdk.mjs   agent SDK; scripts/agent.mjs is a demo agent
scripts/roost.mjs       Roost CLI: terms, signup, office grant
```

Inspired by [chad/freeqworld](https://github.com/chad/freeqworld), which
renders a federated chat protocol as a multiplayer RPG.

![Overview](../overview.png)
