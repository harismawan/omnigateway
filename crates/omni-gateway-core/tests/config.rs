//! Contract tests for `load_config`: the pinned outcome, field for field,
//! or the pinned error text.

use omni_gateway_core::config::load_config;
/// No `.env` is read: a `.env` beside the working directory changes nothing.
#[test]
fn config_reads_the_process_environment_and_no_dotenv() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        dir.path().join(".env"),
        "OMNI_PORT=1234\nOMNI_ENCRYPTION_KEY=from-dotenv-0123456789\n",
    )
    .expect("w");
    let exe = std::env::current_exe().expect("exe");
    let out = std::process::Command::new(exe)
        .args([
            "--exact",
            "probe_config_in_child",
            "--nocapture",
            "--include-ignored",
        ])
        .current_dir(dir.path())
        .env("OMNI_PROBE", "1")
        .env("OMNI_ENCRYPTION_KEY", "from-process-0123456789")
        .env_remove("OMNI_PORT")
        .output()
        .expect("child");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        stdout.contains("PROBE port=9000 key=from-process-0123456789"),
        "{stdout}"
    );
}

#[test]
#[ignore = "run by config_reads_the_process_environment_and_no_dotenv"]
fn probe_config_in_child() {
    if std::env::var("OMNI_PROBE").is_err() {
        return;
    }
    let c = load_config(&omni_gateway_core::config::process_env(), || 0).expect("config");
    println!("PROBE port={} key={}", c.port, c.encryption_key);
}
