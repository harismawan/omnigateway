use omni_providers::oauth::FlowResult;
use serde_json::{Value, json};
fn result(value: Value) -> FlowResult {
    FlowResult {
        id_token: None,
        provider_data: serde_json::Map::from_iter([("deep".into(), value)]),
        access_token: vec![97],
        refresh_token: None,
        expires_at: Some(1.0),
        account_email: None,
    }
}
#[test]
fn shallow_clone() {
    let a = result(json!({"keep":[1,true]}));
    let b = a.clone();
    assert_eq!(a.provider_data, b.provider_data);
    assert_eq!(a.access_token, b.access_token);
    assert_eq!(a.expires_at, b.expires_at);
}
#[test]
fn carrier_depth() {
    if let Ok(mode) = std::env::var("FLOW_DEPTH") {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                let mut v = Value::Null;
                for _ in 0..40000 {
                    v = Value::Array(vec![v]);
                }
                let mut a = result(v);
                if mode == "clone" {
                    drop(a.clone());
                }
                if mode == "merge" {
                    let mut data = serde_json::Map::new();
                    for (key, value) in std::mem::take(&mut a.provider_data) {
                        omni_ir::deep::insert(&mut data, key, value);
                    }
                    drop(omni_ir::deep::Owned(Value::Object(data)));
                }
                drop(a);
            })
            .expect("thread")
            .join()
            .expect("join");
        return;
    }
    for mode in ["clone", "drop", "merge"] {
        let out = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", "carrier_depth"])
            .env("FLOW_DEPTH", mode)
            .output()
            .expect("child");
        assert!(
            out.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
