# coffee (CoffeeMachine)

The kitchen coffee machine; counts cups.

- address `coffee:<name>`
- Durable Object binding `ITEM` (class `ItemDO`)
- one: `main`

## `view()`

`read-only` · MCP tool **`coffee_view`**

Cups brewed.

Returns `{ count }`

## `brew()`

`mutates` · MCP tool **`coffee_brew`**

Count a cup (people get theirs with the protocol coffee message, which also hands them the mug).

Returns `integer ≥ 0`
