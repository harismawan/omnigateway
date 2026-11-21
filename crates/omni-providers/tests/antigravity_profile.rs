#[test]
fn profile_matches_frozen_codec() {
    if let Ok(expected) = std::env::var("ANTIGRAVITY_PROFILE_EXPECTED") {
        omni_providers::antigravity::profile::initialize();
        use omni_providers::codec::{CodecInput, Credentials};
        let request = serde_json::from_str(r#"{"model":"m","stream":false,"messages":[]}"#)
            .expect("canonical request");
        let mut credentials = Credentials {
            access_token: Some("token".into()),
            api_key: None,
            provider_data: Default::default(),
        };
        omni_ir::deep::insert(
            &mut credentials.provider_data,
            "projectId".into(),
            "project".into(),
        );
        let actual = omni_providers::antigravity::codec::AntigravityCodec
            .build_request(&CodecInput {
                request: &request,
                model: "m",
                credentials: &credentials,
                request_id: None,
                auto_cache_enabled: None,
                max_output_tokens: None,
                request_started_at: None,
            })
            .expect("inference request")
            .request
            .headers;
        assert_eq!(
            serde_json::to_string(&actual).expect("headers"),
            expected.trim()
        );
        return;
    }
    let vectors = [
        ("", "", ""),
        ("9.1", "", ""),
        (
            "9.1",
            "custom agent",
            "Accept,User-Agent,Authorization,Content-Type",
        ),
        ("bad\n", "bad\t", " ,\n,"),
        ("é", "🔥", "accept,ACCEPT,unknown"),
        (" ", " ", "\u{feff}User-Agent\u{a0}, Content-Type"),
        ("2", "agent", "User-Agent,User-Agent"),
    ];
    let mut vectors: Vec<(String, String, String)> = vectors
        .into_iter()
        .map(|(a, b, c)| (a.into(), b.into(), c.into()))
        .collect();
    vectors.push(("v".repeat(200), "u".repeat(200), "x".repeat(200)));
    vectors.push(("v".repeat(201), "u".repeat(201), "x".repeat(201)));
    for (version, ua, order) in vectors {
        let vars = [
            ("OMNI_ANTIGRAVITY_IDE_VERSION", version),
            ("OMNI_UA_ANTIGRAVITY", ua),
            ("OMNI_ORDER_ANTIGRAVITY", order),
        ];
        let oracle = std::process::Command::new("bun")
            .args(["--no-env-file", "tests/antigravity_profile-reference.ts"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .envs(vars.clone())
            .output()
            .expect("bun");
        assert!(
            oracle.status.success(),
            "{}",
            String::from_utf8_lossy(&oracle.stderr)
        );
        let child = std::process::Command::new(std::env::current_exe().expect("executable"))
            .args(["--exact", "profile_matches_frozen_codec"])
            .envs(vars)
            .env(
                "ANTIGRAVITY_PROFILE_EXPECTED",
                String::from_utf8(oracle.stdout).expect("utf8"),
            )
            .output()
            .expect("child");
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stdout)
        );
    }
}
