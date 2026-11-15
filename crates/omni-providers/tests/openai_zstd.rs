#![allow(clippy::unwrap_used)]
use sha2::{Digest, Sha256};
use std::io::Write as _;

#[test]
fn streamed_frames_match_frozen_runtime() {
    let output = std::process::Command::new("bun")
        .arg("tests/openai-zstd-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 24);
    let mut identical = 0;
    for row in rows.as_array().unwrap() {
        let size = usize::try_from(row["size"].as_u64().unwrap()).unwrap();
        let varied = row["varied"].as_bool().unwrap();
        let mut state = 0x1234_5678u32;
        let raw: Vec<u8> = (0..size)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                if varied {
                    state.to_le_bytes()[0]
                } else {
                    97 + u8::try_from(i % 7).unwrap()
                }
            })
            .collect();
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        encoder.write_all(&raw).unwrap();
        let frame = encoder.finish().unwrap();
        if format!("{:x}", Sha256::digest(&frame)) == row["hash"].as_str().unwrap() {
            identical += 1;
        } else {
            eprintln!(
                "frame differs size={size} varied={varied}: Rust length={} header={:02x?}; TS length={} header={}",
                frame.len(),
                &frame[..6],
                row["length"],
                row["header"]
            );
        }
        assert_eq!(zstd::stream::decode_all(frame.as_slice()).unwrap(), raw);
    }
    eprintln!("frames identical for {identical} of 24");
}
