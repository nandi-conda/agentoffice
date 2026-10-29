//! `#[plugin(...)]` for [agentoffice-plugin](https://docs.rs/agentoffice-plugin):
//! put it on your handler and it exports the office's WASM ABI
//! (`alloc`, `interact`) and embeds a manifest in the module's
//! `agentoffice.manifest` custom section. The office reads that manifest on
//! upload (name, prompt, emoji, look…) and lists its actions in
//! `gallery_view`, so agents and the docs know what the object does.
//!
//! ```ignore
//! /// A guestbook people sign.
//! #[plugin(
//!     name = "Guestbook", prompt = "Sign the guestbook", emoji = "📖", glow = "#f59e0b", look = "kiosk",
//!     action("sign", "Sign it with a note", input = "Your note, up to 120 characters"),
//! )]
//! fn guestbook(req: Request<State>) -> Response<State> { … }
//! ```

use proc_macro::TokenStream;
use proc_macro2::Span;
use quote::quote;
use serde_json::{json, Map, Value};
use syn::{parse::Parser, punctuated::Punctuated, spanned::Spanned, Expr, ExprAssign, ExprCall, ExprLit, ItemFn, Lit, LitByteStr, LitStr, Meta, Token};

const LOOKS: &[&str] = &["plinth", "kiosk", "jukebox", "vending", "eightball"];

fn err<T>(span: Span, msg: impl std::fmt::Display) -> syn::Result<T> {
    Err(syn::Error::new(span, msg))
}

fn string(e: &Expr) -> syn::Result<String> {
    match e {
        Expr::Lit(ExprLit { lit: Lit::Str(s), .. }) => Ok(s.value()),
        _ => err(e.span(), "expected a string literal"),
    }
}

fn key(a: &ExprAssign) -> syn::Result<String> {
    match &*a.left {
        Expr::Path(p) if p.path.get_ident().is_some() => Ok(p.path.get_ident().unwrap().to_string()),
        l => err(l.span(), "expected `key = \"value\"`"),
    }
}

fn limit(span: Span, what: &str, s: &str, max: usize) -> syn::Result<()> {
    if s.chars().count() > max {
        return err(span, format!("{what} is {} characters; the office keeps {max}", s.chars().count()));
    }
    Ok(())
}

// action("id", "what it does", input = "what to type")
fn action(call: &ExprCall, api: &mut Map<String, Value>) -> syn::Result<()> {
    let mut args = call.args.iter();
    let id = match args.next() {
        Some(e) => string(e)?,
        None => return err(call.span(), "action needs an id: action(\"sign\", \"what it does\")"),
    };
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || "_:.-<>".contains(c));
    if !ok {
        return err(call.args[0].span(), "action ids are letters, digits and _ : . - (up to 64), e.g. \"sign\" or \"play:<track>\"");
    }
    let mut spec = Map::new();
    for e in args {
        match e {
            Expr::Lit(_) => {
                let doc = string(e)?;
                limit(e.span(), "the action's doc", &doc, 200)?;
                spec.insert("doc".into(), doc.into());
            }
            Expr::Assign(a) if key(a)? == "input" => {
                let what = string(&a.right)?;
                spec.insert("params".into(), json!({ "input": { "type": "string", "maxLength": 500, "description": what } }));
            }
            Expr::Assign(a) if key(a)? == "doc" => {
                spec.insert("doc".into(), string(&a.right)?.into());
            }
            _ => return err(e.span(), "expected a doc string or `input = \"what to type\"`"),
        }
    }
    if api.insert(id.clone(), Value::Object(spec)).is_some() {
        return err(call.span(), format!("action \"{id}\" is declared twice"));
    }
    Ok(())
}

// The handler's /// doc comment, as one paragraph.
fn doc_comment(f: &ItemFn) -> String {
    let lines: Vec<String> = f.attrs.iter().filter_map(|a| match &a.meta {
        Meta::NameValue(nv) if nv.path.is_ident("doc") => match &nv.value {
            Expr::Lit(ExprLit { lit: Lit::Str(s), .. }) => Some(s.value().trim().to_string()),
            _ => None,
        },
        _ => None,
    }).collect();
    lines.split(|l| l.is_empty()).next().unwrap_or(&[]).join(" ")
}

fn expand(attr: TokenStream, item: TokenStream) -> syn::Result<proc_macro2::TokenStream> {
    let f: ItemFn = syn::parse(item)?;
    let args = Punctuated::<Expr, Token![,]>::parse_terminated.parse(attr)?;
    let mut m = Map::new();
    let mut api = Map::new();
    for e in &args {
        match e {
            Expr::Assign(a) => {
                let k = key(a)?;
                let v = string(&a.right)?;
                let span = a.right.span();
                match k.as_str() {
                    "name" => limit(span, "name", &v, 40)?,
                    "prompt" => limit(span, "prompt", &v, 60)?,
                    "doc" => limit(span, "doc", &v, 280)?,
                    "emoji" => limit(span, "emoji", &v, 8)?,
                    "glow" => {
                        let hex = v.len() >= 4 && v.len() <= 9 && v.starts_with('#') && v[1..].chars().all(|c| c.is_ascii_hexdigit());
                        if !hex { return err(span, "glow is a colour like \"#f59e0b\""); }
                    }
                    "look" => {
                        if !LOOKS.contains(&v.as_str()) { return err(span, format!("look is one of {}", LOOKS.join(", "))); }
                    }
                    _ => return err(a.left.span(), "unknown key: use name, prompt, doc, emoji, glow, look or action(…)"),
                }
                m.insert(k, v.into());
            }
            Expr::Call(c) if matches!(&*c.func, Expr::Path(p) if p.path.is_ident("action")) => action(c, &mut api)?,
            _ => return err(e.span(), "expected `key = \"value\"` or action(\"id\", \"what it does\")"),
        }
    }
    if !m.contains_key("name") {
        // guestbook → Guestbook, magic_8_ball → Magic 8 ball
        let n = f.sig.ident.to_string().replace('_', " ");
        let mut c = n.chars();
        let name: String = c.next().map(|h| h.to_uppercase().chain(c).collect()).unwrap_or_default();
        m.insert("name".into(), name.into());
    }
    if !m.contains_key("doc") {
        let doc = doc_comment(&f);
        if !doc.is_empty() {
            limit(f.sig.ident.span(), "the doc comment's first paragraph", &doc, 280)?;
            m.insert("doc".into(), doc.into());
        }
    }
    m.insert("api".into(), Value::Object(api));
    m.insert("manifest".into(), 1.into());
    let text = serde_json::to_string(&Value::Object(m)).unwrap();
    if text.len() > 8 * 1024 {
        return err(Span::call_site(), "the manifest is over 8 KB: shorten the docs");
    }
    let lit = LitStr::new(&text, Span::call_site());
    let bytes = LitByteStr::new(text.as_bytes(), Span::call_site());
    let len = text.len();
    let ident = &f.sig.ident;
    Ok(quote! {
        #f

        /// This plugin's manifest (JSON), as embedded in the module's
        /// `agentoffice.manifest` custom section.
        pub const MANIFEST: &str = #lit;

        #[cfg(target_arch = "wasm32")]
        #[unsafe(link_section = "agentoffice.manifest")]
        #[used]
        static __AGENTOFFICE_MANIFEST: [u8; #len] = *#bytes;

        ::agentoffice_plugin::export_plugin!(#ident);
    })
}

/// Make a function the plugin: exports the WASM ABI for it and embeds a
/// manifest. Keys (all optional): `name`, `prompt`, `doc` (defaults to the
/// function's doc comment), `emoji`, `glow`, `look`, and any number of
/// `action("id", "what it does", input = "what to type")`.
#[proc_macro_attribute]
pub fn plugin(attr: TokenStream, item: TokenStream) -> TokenStream {
    expand(attr, item).unwrap_or_else(|e| e.to_compile_error()).into()
}
