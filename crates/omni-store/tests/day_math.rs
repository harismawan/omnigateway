//! `startOfDay`, `hourOf` and `hostDayOffsetMinutes` against `rollup.ts`.

mod common;

use common::{bun_available, bun_script, ts};
use omni_store::rollup::{host_day_offset_minutes, hour_of, start_of_day, start_of_day_ms};
use std::process::Command;

const INSTANTS: [f64; 12] = [
    0.0,
    1.5,
    -1.0,
    86_399_999.0,
    86_400_000.0,
    1_794_037_960_689.0,
    1_794_037_960_689.75,
    1_793_984_399_999.0,
    1_793_984_400_000.0,
    4_102_444_800_000.0,
    -86_400_001.0,
    9_007_199_254_740.0,
];
const OFFSETS: [i64; 9] = [0, 60, 420, -300, -330, 345, 1440, -1440, 1];

#[test]
fn day_and_hour_buckets_match_rollup_ts() {
    // Known values, computed by Bun for `startOfDay` in rollup.ts.
    assert_eq!(start_of_day(1.5, 60), -3_600_000.0);
    assert_eq!(start_of_day(1_794_037_960_689.0, 420), 1_793_984_400_000.0);
    assert_eq!(start_of_day(1_794_037_960_689.0, -300), 1_794_027_600_000.0);
    assert_eq!(start_of_day(-1.0, 0), -86_400_000.0);
    assert_eq!(hour_of(1_794_037_960_689.5), 498_343.0);
    for at in INSTANTS {
        for offset in OFFSETS {
            if at.fract() == 0.0 {
                #[allow(clippy::cast_possible_truncation)]
                let whole = at as i64;
                #[allow(clippy::cast_precision_loss)]
                let via_int = start_of_day_ms(whole, offset) as f64;
                assert_eq!(via_int, start_of_day(at, offset), "{at} {offset}");
            }
        }
    }
    if !bun_available("day_and_hour_buckets_match_rollup_ts") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let script = format!(
        r#"
import {{ startOfDay, hourOf }} from "{}";
const {{ instants, offsets }} = JSON.parse(await Bun.stdin.text());
const out = [];
for (const at of instants) for (const o of offsets) out.push([startOfDay(at, o), hourOf(at)]);
console.log(JSON.stringify(out));
"#,
        ts("packages/store/src/sqlite/rollup.ts")
    );
    let stdin = serde_json::json!({ "instants": INSTANTS, "offsets": OFFSETS }).to_string();
    let expected: Vec<(f64, f64)> =
        serde_json::from_str(&bun_script(dir.path(), &script, &stdin)).expect("json");
    let mut i = 0;
    for at in INSTANTS {
        for offset in OFFSETS {
            assert_eq!(
                start_of_day(at, offset),
                expected[i].0,
                "startOfDay({at}, {offset})"
            );
            assert_eq!(hour_of(at), expected[i].1, "hourOf({at})");
            i += 1;
        }
    }
}

#[test]
fn host_offset_matches_js_get_timezone_offset() {
    if !bun_available("host_offset_matches_js_get_timezone_offset") {
        return;
    }
    // Each zone runs in a child of this test binary so `TZ` is set before the
    // process reads it, the way it is for a gateway at boot.
    for zone in [
        "UTC",
        "Asia/Jakarta",
        "Asia/Kolkata",
        "America/St_Johns",
        "Pacific/Chatham",
        "America/New_York",
    ] {
        let js = Command::new("bun")
            .args(["-e", "console.log(-new Date().getTimezoneOffset() || 0)"])
            .env("TZ", zone)
            .output()
            .expect("bun");
        let js: i64 = String::from_utf8_lossy(&js.stdout)
            .trim()
            .parse()
            .expect("js offset");
        let rust = Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", "print_host_offset", "--nocapture", "--ignored"])
            .env("TZ", zone)
            .output()
            .expect("child");
        let text = String::from_utf8_lossy(&rust.stdout);
        let line = text
            .lines()
            .find_map(|l| l.strip_prefix("HOST_OFFSET="))
            .unwrap_or_else(|| panic!("child printed no offset: {text}"));
        assert_eq!(
            line.trim().parse::<i64>().expect("rust offset"),
            js,
            "TZ={zone}"
        );
    }
}

/// Run by `host_offset_matches_js_get_timezone_offset` in a child process.
#[test]
#[ignore = "helper for host_offset_matches_js_get_timezone_offset"]
fn print_host_offset() {
    println!("HOST_OFFSET={}", host_day_offset_minutes());
}
