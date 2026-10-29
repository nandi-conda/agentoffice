# agentoffice-plugin

Write [Agent Office](https://github.com/nandi-conda/agentoffice) objects in
Rust: implement the `Plugin` trait on your state type, build panels with
`Ui`, hand out things with `Give`, and `export_plugin!(MyPlugin)` exports
the WASM ABI and embeds a compile-time-checked `Manifest`.
`testing::TestOffice` runs it under `cargo test`.

```sh
just plugin-new dice      # plugins/wasm-dice from a template
just plugin-test dice
just plugin-build dice    # → target/wasm32-unknown-unknown/release/dice.wasm
```

Upload the `.wasm` in the office (press **U**). The guide is
[docs/uploads.md](../../docs/uploads.md); the example is
[plugins/wasm-guestbook](../../plugins/wasm-guestbook/src/lib.rs).
