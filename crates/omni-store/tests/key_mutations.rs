use omni_store::{
    SqliteStore,
    keys::{self, KeyEdit},
};

#[test]
fn mutation_is_visible_to_other_connection_and_auth_reader() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("db");
    let writer = SqliteStore::open(&path, 0).expect("writer");
    let reader = SqliteStore::open(&path, 0).expect("reader");
    let raw = "sk-omni-test-only";
    let hash = omni_crypto::apikey::hash(raw);
    writer.connection().execute("INSERT INTO api_keys (id,label,prefix,hash,limits,created_at) VALUES ('k','label','sk-omni-test',?,'{}',1)", [&hash]).expect("seed");
    let version = || {
        reader
            .connection()
            .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
            .expect("version")
    };
    let before = version();
    keys::edit(writer.connection(), "k", KeyEdit::Models(Some("[]"))).expect("models");
    assert_ne!(before, version());
    let key = keys::find_by_hash(reader.connection(), &hash)
        .expect("read")
        .expect("key");
    assert_eq!(key.model_allowlist, Some(vec![]));
    assert!(key.usable(100));
    let before = version();
    keys::edit(writer.connection(), "k", KeyEdit::Expiry(Some(100))).expect("expiry");
    assert_ne!(before, version());
    let key = keys::find_by_hash(reader.connection(), &hash)
        .expect("read")
        .expect("key");
    assert!(key.usable(99));
    assert!(!key.usable(100));
    keys::edit(writer.connection(), "k", KeyEdit::Expiry(None)).expect("never");
    assert!(
        keys::find_by_hash(reader.connection(), &hash)
            .expect("read")
            .expect("key")
            .usable(100)
    );
    keys::edit(writer.connection(), "k", KeyEdit::Revoke(100)).expect("revoke");
    let key = keys::find_by_hash(reader.connection(), &hash)
        .expect("read")
        .expect("key");
    assert!(!key.usable(100));
    assert_eq!(key.hash, hash);
}

#[test]
fn minted_secret_roundtrips_only_as_hash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteStore::open(dir.path().join("db"), 0).expect("store");
    let raw = omni_crypto::apikey::generate();
    let hash = omni_crypto::apikey::hash(&raw);
    let key = keys::ApiKey {
        id: "minted".into(),
        label: "mint".into(),
        prefix: omni_crypto::apikey::prefix(&raw),
        hash: hash.clone(),
        model_allowlist: None,
        lone_allowlist: Vec::new(),
        limits: Some(Default::default()),
        body_logging_opt_out: true,
        created_at: 100,
        revoked_at: None,
        expires_at: Some(200),
        guardrail_policy: None,
        smart_routing: false,
    };
    keys::create(store.connection(), &key).expect("create");
    let found = keys::find_by_hash(store.connection(), &hash)
        .expect("lookup")
        .expect("key");
    assert!(found.usable(199));
    assert!(!found.usable(200));
    assert_eq!(found, key);
    assert_ne!(found.hash, raw);
    keys::edit(
        store.connection(),
        "minted",
        KeyEdit::Limits("{\"concurrency\":2}"),
    )
    .expect("limits");
    assert_eq!(
        keys::find_by_hash(store.connection(), &hash)
            .expect("lookup")
            .expect("key")
            .limits
            .expect("limits")
            .to_json_well_formed()["concurrency"],
        2
    );
}

fn indexmap_is_empty<K, V>(m: &indexmap::IndexMap<K, V>) -> bool {
    m.is_empty()
}

/// A5: the `/api` surface stores what `JSON.stringify` writes for a client's
/// JS strings, lone surrogate escapes included. `JSON.parse` reads them, so a
/// key, a model and the settings row carrying one stay readable: the key is
/// admitted (not marked unreadable), the model is routable, the settings
/// keep their other fields.
#[test]
fn lone_surrogate_escapes_in_stored_json_read_as_js_does() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("db");
    let store = omni_store::SqliteStore::open(&path, 0).expect("store");
    let c = store.connection();
    c.execute(
        r#"INSERT INTO api_keys(id,label,prefix,hash,created_at,limits,model_allowlist) VALUES('k','k','p','h',1,'{"models":{"\ud800":{"concurrency":1}}}','["\ud800","b"]')"#,
        [],
    )
    .expect("key");
    c.execute(
        r#"INSERT INTO virtual_models VALUES('m','[{"provider":"anthropic","model":"\udc00x","tier":1,"weight":1,"costPerMTok":{"input":0,"output":0},"capabilities":{"tools":true,"images":false,"reasoning":false}}]','score',0)"#,
        [],
    )
    .expect("model");
    c.execute(
        r#"INSERT INTO settings(key,value) VALUES('settings','{"maxAttempts":7,"x":"\ud800"}')"#,
        [],
    )
    .expect("settings");
    let key = keys::find_by_hash(c, "h").expect("read").expect("key");
    // Review A5-I1: kept as exact UTF-16, never folded into U+FFFD.
    let limits = key.limits.as_ref().expect("limits read, not unreadable");
    assert!(limits.models.as_ref().is_some_and(indexmap_is_empty));
    assert!(limits.has_lone_override(&[0xd800]));
    assert!(!limits.has_lone_override(&[0xfffd]));
    assert!(limits.model_override("\u{fffd}").is_none());
    assert_eq!(key.model_allowlist.as_deref(), Some(&["b".to_owned()][..]));
    assert_eq!(key.lone_allowlist, vec![(0, vec![0xd800])]);
    assert!(key.allows("b", None));
    assert!(!key.allows("\u{fffd}", None), "U+FFFD is not \\ud800");
    assert!(key.allows("\u{fffd}", Some(&[0xd800])));
    assert!(!key.allows("\u{fffd}", Some(&[0xd801])));
    let models = omni_store::models::list(c).expect("models");
    assert!(models[0].is_ok(), "{models:?}");
    assert_eq!(
        omni_store::settings::get(c).expect("settings").json["maxAttempts"],
        7
    );
}

/// Review A5-I1: two lone surrogates and U+FFFD are three overrides, and
/// every schema rule (name length in code points, the 64 cap, a scope that
/// limits something) still applies to the lone ones.
#[test]
fn lone_surrogate_override_keys_are_distinct_and_validated() {
    let dir = tempfile::tempdir().expect("dir");
    let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
    let c = store.connection();
    let put = |id: &str, limits: &str| {
        c.execute(
            "INSERT INTO api_keys(id,label,prefix,hash,created_at,limits) VALUES(?,'l','p',?,1,?)",
            rusqlite::params![id, format!("h-{id}"), limits],
        )
        .expect("key");
        keys::find_by_hash(c, &format!("h-{id}"))
            .expect("read")
            .expect("key")
            .limits
    };
    let l = put(
        "a",
        r#"{"models":{"\ud800":{"concurrency":1},"\udc00":{"concurrency":2},"\ufffd":{"concurrency":3}}}"#,
    )
    .expect("readable");
    assert!(l.has_lone_override(&[0xd800]) && l.has_lone_override(&[0xdc00]));
    assert_eq!(l.lone_models.len(), 2);
    assert!(l.model_override("\u{fffd}").is_some());
    assert!(
        put("b", r#"{"models":{"\ud800":{}}}"#).is_none(),
        "an empty override"
    );
    assert!(
        put("c", r#"{"models":{"\ud800":{"bogus":1}}}"#).is_none(),
        "strict scope"
    );
    assert!(
        put("d", r#"{"\ud800":{"concurrency":1}}"#).is_none(),
        "a lone top-level key"
    );
    let many: Vec<String> = (0..64)
        .map(|i| format!(r#""m{i}":{{"concurrency":1}}"#))
        .collect();
    assert!(
        put(
            "e",
            &format!(
                r#"{{"models":{{{},"\ud800":{{"concurrency":1}}}}}}"#,
                many.join(",")
            )
        )
        .is_none(),
        "65 overrides in all"
    );
    let long = "x".repeat(255);
    assert!(
        put(
            "f",
            &format!(r#"{{"models":{{"{long}\ud800":{{"concurrency":1}}}}}}"#)
        )
        .is_some(),
        "256 code points"
    );
    assert!(
        put(
            "g",
            &format!(r#"{{"models":{{"{long}x\ud800":{{"concurrency":1}}}}}}"#)
        )
        .is_none(),
        "257 code points"
    );
}

/// Review A5-I2: an unreadable key row is that key's own
/// error in the snapshot read, with `JSON.parse`'s message; fractional and
/// REAL dates are numbers, not errors.
#[test]
fn an_unreadable_row_is_isolated_in_the_snapshot_read() {
    let dir = tempfile::tempdir().expect("dir");
    let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
    let c = store.connection();
    c.execute_batch(
        "INSERT INTO api_keys(id,label,prefix,hash,created_at,limits,model_allowlist) VALUES('bad','l','p','hb',1,'{}','{bad');
         INSERT INTO api_keys(id,label,prefix,hash,created_at,limits,expires_at,revoked_at) VALUES('frac','l','p','hf',1700000000000.5,'{}',4102444800000.5,NULL);
         INSERT INTO api_keys(id,label,prefix,hash,created_at,limits,revoked_at) VALUES('rev','l','p','hr',1,'{}',1.5);
         INSERT INTO api_keys(id,label,prefix,hash,created_at,limits) VALUES('ok','l','p','ho',1,'nope');",
    )
    .expect("rows");
    let entries = keys::list_entries(c).expect("one bad row does not fail the read");
    let bad = entries.iter().find_map(|e| e.as_ref().err()).expect("bad");
    assert_eq!(
        (bad.id.as_str(), bad.hash.as_str(), bad.message.as_str()),
        ("bad", "hb", "JSON Parse error: Expected '}'")
    );
    let get = |id: &str| {
        entries
            .iter()
            .filter_map(|e| e.as_ref().ok())
            .find(|k| k.id == id)
            .expect(id)
    };
    // `expiresAt > now` stays exact for integer `now`.
    assert!(get("frac").usable(4_102_444_800_000));
    assert!(!get("frac").usable(4_102_444_800_001));
    assert!(!get("rev").usable(0), "a fractional revokedAt is revoked");
    assert!(
        get("ok").limits.is_none(),
        "unparseable limits are unreadable, not a row error"
    );
    assert!(
        keys::list(c).is_err(),
        "the admin listing still fails, as `keys.list()` throws"
    );
    // An empty column is `JSON.parse("")`'s error, not `Request.json()`'s
    // empty-body wording (review A5 r1 minor 2).
    c.execute("UPDATE api_keys SET model_allowlist='' WHERE id='bad'", [])
        .expect("empty");
    let entries = keys::list_entries(c).expect("read");
    let bad = entries.iter().find_map(|e| e.as_ref().err()).expect("bad");
    assert_eq!(bad.message, "JSON Parse error: Unexpected EOF");
    assert!(matches!(
        keys::find_entry_by_hash(c, "hb").expect("read"),
        Some(Err(_))
    ));
}
