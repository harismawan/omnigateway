#[test]
fn sqlite_quota_relational_matrix_matches_frozen_router() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("bun")
        .arg(root.join("conformance/e2e/quota-cell-oracle.ts"))
        .output()
        .expect("Bun oracle");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let conn = rusqlite::Connection::open_in_memory().expect("db");
    // No affinity: retain every raw storage class, including schema-excluded
    // NULL used, to close the relational operation over all SQLite cell types.
    conn.execute_batch("CREATE TABLE quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms)").expect("table");
    let mut failures = Vec::new();
    let mut count = 0;
    for line in String::from_utf8(output.stdout).expect("utf8").lines() {
        let v: serde_json::Value = serde_json::from_str(line).expect("vector");
        conn.execute_batch(&format!("DELETE FROM quota_windows; INSERT INTO quota_windows VALUES('c','matrix',0,{},{},4102444800000,0,NULL)", v["used"].as_str().expect("used"), v["limit"].as_str().expect("limit"))).expect("seed");
        let windows = omni_store::quota::list(&conn).expect("read");
        if windows[0].spent() != v["spent"].as_bool().expect("verdict") {
            failures.push(line.to_owned());
        }
        count += 1;
    }
    assert_eq!(count, 100);
    assert!(failures.is_empty(), "mismatches: {failures:#?}");
}
