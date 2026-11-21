//! `startOfDay`, `hourOf` and `hostDayOffsetMinutes` against `rollup.ts`.

mod common;

use omni_store::rollup::host_day_offset_minutes;
/// Run by `host_offset_matches_js_get_timezone_offset` in a child process.
#[test]
#[ignore = "helper for host_offset_matches_js_get_timezone_offset"]
fn print_host_offset() {
    println!("HOST_OFFSET={}", host_day_offset_minutes());
}
