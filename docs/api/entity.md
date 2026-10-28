# Every entity (built-ins)

Every entity answers these besides its own methods (server/entities/runtime.js). Entities talk by direct RPC (this.ref(address).method()), messages (this.tell(address, type, data) → receive → onMessage) and pub/sub (this.subscribe(topic), this.publish(topic, ev) → notify → onEvent). Calls are structured-cloned on Node and on Workers alike.

- address `<kind>:<name>`

## `receive(message)`

`read-only` · `internal (entity to entity)`

A direct message: { type, data, from } → onMessage.

| Param | Type | |
| --- | --- | --- |
| `message` | `{ type, data, from }` |  |
| &nbsp;&nbsp;&nbsp;`message.type` | `string ≤ 200` | Message type |
| &nbsp;&nbsp;&nbsp;`message.data` | `any` | Payload |
| &nbsp;&nbsp;&nbsp;`message.from` | `string ≤ 200` | Sender address |

## `notify(topic, ev, from)`

`read-only` · `internal (entity to entity)`

A pub/sub event from a topic → onEvent(topic, ev, from).

| Param | Type | |
| --- | --- | --- |
| `topic` | `string ≤ 200` | Topic name |
| `ev` | `any` | The event |
| `from` | `string ≤ 200` | Publisher address |

## `inspect()`

`read-only` · `internal (entity to entity)`

Address and raw state, for debugging. Never exposed over MCP (actor state holds OAuth sessions).

## `seed(legacy)`

`read-only` · `internal (entity to entity)`

Legacy data from before entities; only taken by an entity that has nothing yet.

| Param | Type | |
| --- | --- | --- |
| `legacy` | `any` | Whatever this kind kept in the old office state |
