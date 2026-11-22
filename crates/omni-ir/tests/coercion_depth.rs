#[test]
fn array_coercion_small_stack() {
    const CHILD: &str = "OMNI_COERCION_DEPTH_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", "array_coercion_small_stack", "--nocapture"])
            .env(CHILD, "1")
            .status()
            .expect("child");
        assert!(status.success(), "coercion child: {status}");
        return;
    }
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            let mut value = serde_json::Value::from(42);
            for _ in 0..39_990 {
                value = serde_json::Value::Array(vec![value]);
            }
            assert_eq!(omni_ir::js::to_string(Some(&value)), "42");
            assert_eq!(omni_ir::js::to_number(Some(&value)), 42.0);
            omni_ir::deep::drop(value);
        })
        .expect("spawn")
        .join()
        .expect("join");
}
