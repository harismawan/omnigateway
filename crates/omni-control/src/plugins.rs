//! Which plugins the frozen CLI would import for providers, decided from the
//! filesystem alone. Mirrors `listPlugins` + `readPluginProviders` up to the
//! `import(...)` call: directory, id pattern, manifest read, `JSON.parse`,
//! `safeParseManifest`, the `provider` capability, loadability and a server
//! entry. Every plugin stopped before that point contributes no provider and is
//! only a failure note, which catalog and put never print. Plugin code is never
//! read or run here.
use crate::settings_value::get;
use omni_ir::jsjson::JsValue;
use std::path::{Path, PathBuf};

/// `PLUGIN_API_VERSION`.
const PLUGIN_API_VERSION: f64 = 3.0;
const CAPABILITIES: [&str; 7] = [
    "storage",
    "files",
    "net:outbound",
    "events:request",
    "events:limit",
    "channels",
    "provider",
];
const KEYS: [&str; 11] = [
    "id",
    "name",
    "version",
    "api",
    "sdk",
    "server",
    "ui",
    "nav",
    "capabilities",
    "origins",
    "defaults",
];

/// `/^[a-z][a-z0-9-]{0,31}$/`.
fn is_id(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn units(v: &JsValue) -> Option<&[u16]> {
    match v {
        JsValue::String(s) => Some(s),
        _ => None,
    }
}

/// Zod 4 string length: code points, a lone surrogate counting as one.
fn code_points(s: &[u16]) -> usize {
    char::decode_utf16(s.iter().copied()).count()
}

fn bounded(v: &JsValue, max: usize) -> bool {
    units(v).is_some_and(|s| (1..=max).contains(&code_points(s)))
}

/// `entrySchema`: nonempty, not absolute, no `..` segment.
fn entry_ok(v: &JsValue) -> bool {
    units(v).is_some_and(|s| {
        !s.is_empty()
            && s[0] != u16::from(b'/')
            && !s
                .split(|u| *u == u16::from(b'/'))
                .any(|seg| seg == [46, 46])
    })
}

/// `originSchema`: parses as a URL and is exactly its http(s) origin, with at
/// most one trailing slash.
fn origin_ok(v: &JsValue) -> bool {
    let Some(text) = units(v).and_then(|s| String::from_utf16(s).ok()) else {
        return false;
    };
    let Ok(url) = url::Url::parse(&text) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let origin = url.origin().ascii_serialization();
    text == origin || text == format!("{origin}/")
}

/// `safeParseManifest(...).ok`, returning the capabilities on success.
fn manifest_capabilities(m: &JsValue) -> Option<Vec<&str>> {
    let JsValue::Object(fields) = m else {
        return None;
    };
    if fields.iter().any(|(k, _)| {
        !KEYS
            .iter()
            .any(|key| k.iter().copied().eq(key.encode_utf16()))
    }) {
        return None;
    }
    let present = |k| get(m, k).filter(|v| !matches!(v, JsValue::Undefined));
    if !units(present("id")?)
        .and_then(|s| String::from_utf16(s).ok())
        .is_some_and(|s| is_id(&s))
        || !bounded(present("name")?, 64)
        || !bounded(present("version")?, 32)
    {
        return None;
    }
    let JsValue::Number(api) = present("api")? else {
        return None;
    };
    if !(api.is_finite()
        && api.fract() == 0.0
        && api.abs() <= 9_007_199_254_740_991.0
        && *api >= 0.0)
    {
        return None;
    }
    if present("sdk").is_some_and(|v| !bounded(v, 32))
        || present("server").is_some_and(|v| !entry_ok(v))
        || present("ui").is_some_and(|v| !entry_ok(v))
    {
        return None;
    }
    if let Some(nav) = present("nav") {
        let JsValue::Object(f) = nav else {
            return None;
        };
        if f.iter()
            .any(|(k, _)| !k.iter().copied().eq("label".encode_utf16()))
            || !get(nav, "label").is_some_and(|l| bounded(l, 32))
        {
            return None;
        }
    }
    let capabilities = match present("capabilities") {
        None => Vec::new(),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|c| {
                CAPABILITIES
                    .iter()
                    .find(|name| {
                        units(c).is_some_and(|s| s.iter().copied().eq(name.encode_utf16()))
                    })
                    .copied()
            })
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    let origins = present("origins");
    if let Some(origins) = origins {
        let JsValue::Array(items) = origins else {
            return None;
        };
        if items.is_empty() || !items.iter().all(origin_ok) {
            return None;
        }
    }
    if present("defaults").is_some_and(|d| !matches!(d, JsValue::Object(_))) {
        return None;
    }
    let needs_origins = capabilities
        .iter()
        .any(|c| matches!(*c, "net:outbound" | "provider"));
    if present("server").is_none() && present("ui").is_none()
        || present("ui").is_some() && present("sdk").is_none()
        || needs_origins != origins.is_some()
    {
        return None;
    }
    Some(capabilities)
}

/// `path.resolve(home, entry)` for a schema-valid relative entry, which has no
/// `..` segment: empty and `.` segments vanish.
fn resolve(home: &Path, entry: &str) -> PathBuf {
    entry
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .fold(home.to_path_buf(), |p, s| p.join(s))
}

/// Ids, in `listPlugins` order, of plugins frozen TS would import to read a
/// provider. Empty for a missing, file-only or provider-free plugins directory.
pub fn provider_plugins(root: &Path) -> Vec<String> {
    let dir = root.join("plugins");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
        .into_iter()
        .filter(|name| {
            let home = dir.join(name);
            if !home.is_dir() || !is_id(name) {
                return false;
            }
            let Ok(bytes) = std::fs::read(home.join("omni-plugin.json")) else {
                return false;
            };
            let Ok(manifest) = crate::operator_json::parse(&String::from_utf8_lossy(&bytes)) else {
                return false;
            };
            let Some(capabilities) = manifest_capabilities(&manifest) else {
                return false;
            };
            if !capabilities.contains(&"provider") {
                return false;
            }
            // Loadable: id, api and a server entry that is a file. UI and sdk
            // problems are not fatal. Then `typeof server === "string"`.
            let text = |k| {
                get(&manifest, k)
                    .and_then(units)
                    .map(String::from_utf16_lossy)
            };
            let Some(server) = text("server") else {
                return false;
            };
            text("id").as_deref() == Some(name.as_str())
                && get(&manifest, "api") == Some(&JsValue::Number(PLUGIN_API_VERSION))
                && resolve(&home, &server).is_file()
        })
        .collect()
}

/// Metadata only; `loadable` is deliberately false because this runtime does
/// not execute plugins, even when their manifest passes the metadata checks.
pub fn doctor_metadata(root: &Path) -> Option<serde_json::Value> {
    let dir = root.join("plugins");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(serde_json::json!([])),
        Err(_) => return None,
    };
    let mut paths = entries
        .collect::<Result<Vec<_>, _>>()
        .ok()?
        .into_iter()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect::<Vec<_>>();
    paths.sort();
    Some(serde_json::Value::Array(paths.into_iter().map(|path| {
        let id=path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let manifest=std::fs::read_to_string(path.join("omni-plugin.json")).ok().and_then(|s|crate::operator_json::parse(&s).ok());
        let valid=manifest.as_ref().is_some_and(|m| manifest_capabilities(m).is_some());
        let manifest=manifest.as_ref().and_then(omni_ir::jsjson::stringify).and_then(|s|serde_json::from_str::<serde_json::Value>(&s).ok()).unwrap_or(serde_json::Value::Null);
        let field=|key:&str|manifest.get(key).cloned().unwrap_or(serde_json::Value::Null);
        serde_json::json!({"id":id,"path":path,"name":field("name"),"version":field("version"),"api":field("api"),"sdk":field("sdk"),"capabilities":manifest.get("capabilities").cloned().unwrap_or(serde_json::json!([])),"origins":manifest.get("origins").cloned().unwrap_or(serde_json::json!([])),"manifest":manifest,"loadable":false,"problems":[{"check":if valid{"entry"}else{"manifest"},"reason":if valid{"plugins are not supported in this release; metadata only, code not checked or executed"}else{"manifest unavailable or invalid; plugins are not supported in this release"},"fatal":true}]})
    }).collect()))
}

#[cfg(test)]
mod tests {
    fn caps(raw: &str) -> Option<Vec<String>> {
        super::manifest_capabilities(&crate::operator_json::parse(raw).expect("JSON"))
            .map(|c| c.into_iter().map(str::to_owned).collect())
    }

    #[test]
    fn manifest_schema_follows_frozen_safe_parse() {
        let base = r#""id":"p","name":"n","version":"1","api":3"#;
        let ok = |extra: &str| caps(&format!("{{{base},{extra}}}")).is_some();
        assert!(ok(r#""server":"s.js""#));
        assert!(ok(r#""server":"..x""#));
        assert!(ok(r#""server":"a\\..\\b""#));
        assert!(!ok(r#""server":"a/../b""#));
        assert!(!ok(r#""server":"/s""#));
        assert!(!ok(r#""ui":"u""#));
        assert!(ok(r#""ui":"u","sdk":"1""#));
        assert!(!ok(r#""server":"s","x":1"#));
        assert!(!ok(r#""server":"s","capabilities":["provider"]"#));
        assert!(ok(
            r#""server":"s","capabilities":["provider"],"origins":["https://a.example:8443/"]"#
        ));
        for origin in [
            "https://a.example:443",
            "HTTPS://a.example",
            "https://A.example",
            "https://a.example/x",
            "ftp://a.example",
        ] {
            assert!(!ok(&format!(
                r#""server":"s","capabilities":["provider"],"origins":["{origin}"]"#
            )));
        }
        assert!(!ok(r#""server":"s","origins":["https://a.example"]"#));
        assert!(
            caps(&format!(
                r#"{{"id":"p","name":"{}","version":"1","api":3,"server":"s"}}"#,
                "😀".repeat(64)
            ))
            .is_some()
        );
        assert!(
            caps(&format!(
                r#"{{"id":"p","name":"{}","version":"1","api":3,"server":"s"}}"#,
                "😀".repeat(65)
            ))
            .is_none()
        );
        for api in ["3.5", "-1", "9007199254740992", "\"3\"", "1e400"] {
            assert!(
                caps(&format!(
                    r#"{{"id":"p","name":"n","version":"1","api":{api},"server":"s"}}"#
                ))
                .is_none()
            );
        }
        assert!(!ok(r#""server":"s","defaults":[]"#));
        assert!(!ok(r#""server":"s","nav":null"#));
        assert!(
            caps(r#"{"__proto__":{},"id":"p","name":"n","version":"1","api":3,"server":"s"}"#)
                .is_none()
        );
        // readFileSync keeps a BOM, which JSON.parse refuses.
        assert!(crate::operator_json::parse("\u{feff}{}").is_err());
    }
}
