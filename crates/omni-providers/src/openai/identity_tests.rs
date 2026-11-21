#![allow(clippy::unwrap_used)]
use super::identity::*;
#[test]
fn secrets_generate_and_preserve() {
    let a = ensure_secrets(&serde_json::Value::Null);
    let b = ensure_secrets(&serde_json::Value::Null);
    let uuid = a.installation_id.as_deref().unwrap();
    assert!(is_uuid(uuid));
    assert_eq!(uuid.as_bytes()[14], b'4');
    assert!(b"89ab".contains(&uuid.as_bytes()[19]));
    assert_eq!(a.id_salt.as_deref().unwrap().len(), 64);
    assert_ne!(a.installation_id, b.installation_id);
    assert_ne!(a.id_salt, b.id_salt);
    let data = serde_json::to_value(a).unwrap();
    let kept = ensure_with(
        &data,
        || panic!("UUID reminted"),
        || panic!("salt reminted"),
    );
    assert_eq!(serde_json::to_value(kept).unwrap(), data);
}
