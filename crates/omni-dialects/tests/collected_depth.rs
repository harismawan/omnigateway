use omni_dialects::egress::{anthropic, openai, responses};
use omni_ir::{
    deep,
    stream::{ContentBlockStart, Delta, StreamEvent, try_collect},
};

#[test]
fn fragmented_arguments_collect_clone_render_drop_on_small_stack() {
    if std::env::var_os("OMNI_COLLECT_CHILD").is_none() {
        let oracle = std::process::Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../conformance/deep-tool-oracle.ts"
            ))
            .output()
            .expect("mandatory Bun oracle");
        assert!(
            oracle.status.success(),
            "{}",
            String::from_utf8_lossy(&oracle.stderr)
        );
    }
    if std::env::var_os("OMNI_COLLECT_CHILD").is_some() {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                for depth in [150, 512, 40_000, 40_001] {
                    let raw = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
                    let mut events = vec![StreamEvent::BlockStart {
                        index: 0,
                        block: ContentBlockStart::ToolUse {
                            id: "c".into(),
                            name: "f".into(),
                        },
                    }];
                    events.extend(
                        raw.as_bytes()
                            .chunks(7)
                            .map(|part| StreamEvent::BlockDelta {
                                index: 0,
                                delta: Delta::ToolJson {
                                    partial: String::from_utf8(part.to_vec()).expect("ASCII"),
                                },
                            }),
                    );
                    let result = try_collect(events);
                    if depth > deep::MAX_DEPTH {
                        assert!(result.is_err());
                        continue;
                    }
                    let collected = result.expect("in policy");
                    let cloned = collected.clone();
                    let a = anthropic::response(&cloned, "r");
                    assert!(omni_ir::jsjson::to_string(&a).contains(&raw));
                    let o = openai::response(&cloned, "r", 0);
                    assert!(omni_ir::jsjson::to_string(&o).contains(&raw));
                    let r = responses::response(
                        &cloned,
                        &responses::ResponsesRender {
                            request_id: "r".into(),
                            created: 0,
                            custom_tool_names: Default::default(),
                        },
                    );
                    assert!(omni_ir::jsjson::to_string(&r).contains(&raw));
                    drop((a, o, r, cloned, collected));
                }
            })
            .expect("spawn")
            .join()
            .expect("small stack");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args([
            "--exact",
            "fragmented_arguments_collect_clone_render_drop_on_small_stack",
            "--nocapture",
        ])
        .env("OMNI_COLLECT_CHILD", "1")
        .output()
        .expect("child");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
