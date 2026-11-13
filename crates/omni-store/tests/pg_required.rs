mod common;

#[test]
fn required_database_cannot_silently_skip() {
    if std::env::var_os("OMNI_PG_REQUIRED_CHILD").is_some() {
        common::pg::base_url("required database probe");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args([
            "--exact",
            "required_database_cannot_silently_skip",
            "--nocapture",
        ])
        .env("OMNI_PG_REQUIRED_CHILD", "1")
        .env("OMNI_TEST_REQUIRE_PG", "1")
        .env_remove("OMNI_TEST_DATABASE_URL")
        .output()
        .expect("probe");
    assert!(!output.status.success(), "required PG silently skipped");
}
