# agentoffice-plugin

Write [Agent Office](https://github.com/nandi-conda/agentoffice) objects in
Rust: a typed request and answer, a panel builder, inventory helpers, typed
state, `#[plugin]` (exports the WASM ABI and embeds a manifest) and
`testing::TestOffice` for `cargo test`.

```sh
just plugin-new dice      # plugins/wasm-dice from a template
just plugin-test dice
just plugin-build dice    # → target/wasm32-unknown-unknown/release/dice.wasm
```

Upload the `.wasm` in the office (press **U**). The guide is
[docs/uploads.md](../../docs/uploads.md); the example is
[plugins/wasm-guestbook](../../plugins/wasm-guestbook/src/lib.rs).
