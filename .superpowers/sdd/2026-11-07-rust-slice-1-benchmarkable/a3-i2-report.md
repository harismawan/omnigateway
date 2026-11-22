# I2 — raw-cell body reader

Commit: `478294f8c9b726ed4328704865b57252bc05d7f8` on `fix/a3-body-reader`. Worktree clean. No I1-owned files changed; body_route.rs test formatting adjusted for the read carrier.

## Frozen branch walk / implementation

Verified the imported frozen store/control/artifact/encryption files are identical to 1780bb39 (`i2-frozen.diff` empty). The independent Bun reference imports the actual frozen SQLite repository and control operation and opens the **same SQLite file and encrypted artifact** as Rust. No Rust metadata is fed to the reference.

* SELECT uses the supplied string request ID without coercing the stored primary key first. No match returns requestId from the argument, none/false/0/null/null.
* request_id, at, size_bytes pass through without type checks. JS number conversion rounds INTEGER 2^53+1, preserves REAL until stringify (including negative zero -> 0 and 1e308); TEXT remains text, BLOB becomes Uint8Array index properties, NULL remains null.
* detail_state recognizes only strict string ready/missing/corrupt; everything else is none. None promises no file and short-circuits path validation.
* truncated uses strict numeric equality to 1, not integer decoding or truthiness (REAL 1 equals 1; numeric TEXT does not unless SQLite affinity already converted it).
* rel_path null short-circuits with the mapped state unchanged; otherwise, for a state other than none, path.join requires a string and throws on number/BLOB. Empty TEXT joins to the directory, whose acquisition fails as missing. Missing/corrupt/ready observations update detail_state as frozen does.
* sha256 null disables digest checking; all other values require strict equality to the hex digest. Non-string non-null values therefore corrupt a readable artifact. This comparison occurs after acquisition; a missing file still reports missing.
* Handler projects requestId/detailState/truncated/sizeBytes/at/artifact in frozen insertion order, excluding relPath/sha256, using the existing JS stringify implementation for exact bytes.

Moved/reused X3's Cell reader/projection into omni-store::operator_cell, re-exporting it from omni-control::cli_cell. Separate BodyReadRow carries JS values; write metadata remains typed. PG typed metadata converts into that same read carrier, with a unit test covering rounded large integers. No PG runtime assertion. Capture gates and gateway auth/routing/snapshot readers unchanged.

## Red -> green

On unmodified 660e1872 product code: 98 production-affinity cells, **24 mismatches** (`i2-red2.log`, exit 101). Earlier `i2-red.log` retained: test setup failed decoding a BLOB ID cast as UTF-8 before completing; corrected test selects IDs according to actual string-query semantics.

Final oracle: **196 cases / 0 mismatches**: all seven columns x 14 inputs, once with production affinities and nullable columns, once without affinities so TEXT/numeric TEXT and REAL 1.0 survive storage. Inputs: integer 0/1/2; REAL 0.5/1.0/1.5/-0.0/1e308; integer 9007199254740993; text, numeric text, empty text, BLOB, NULL. Every case starts with a valid encrypted artifact; reference state updates are reset before Rust reads. Primary-key BLOB/NULL cannot match a string query and correctly produce absent results. NULLs impossible under production NOT NULL constraints are exercised using the nullable fixture.

Review's three probes copied read-only into i2 evidence and rerun in private loopback namespaces: both gateways now return 200, ready, and the correct at=0.5 / sizeBytes=10.5 / truncated=false. Viewer/anonymous remain 401. `i2-probe-check.py` asserts these facts independently of the review driver's misleading equality banners. Review driver still prints DIFFER for route **strings** containing different generated UUIDs/timestamps; full responses are retained, not claimed byte-equal. No normalizer was changed in product/tests for this work.

## Gates and limitation

Package tests: 91 successful summaries. Workspace: 212 successful summaries, no failures and no flake/retry. Clippy/fmt pass. Maintenance black-box passes inside unshare -Urn. No admin-routes run. Cargo sequential/offline, jobs=2/incremental=0/debug=0, private HOME; disk 16 -> 15 GiB.

**X3 gate blocked, not green:** requested conformance/e2e/x3-operator.py does not exist on this branch (nor its accepted manifest). Exact requested command retained with exit 2. Recovered the latest existing corpus+manifest from git object 478a974f into evidence only; isolated rerun exits 1 at `accepted auth body drift`, unrelated to body reads. Did not expand scope to modify accepted auth behavior or add another branch's corpus. Controller must resolve which X3 corpus/baseline applies before treating all gates as complete.

### Exact command / exit lines (verbatim .exit files)

- `i2-build.exit`: `cargo build --offline -p omni-gateway --bin omnigateway: 0`
- `i2-clippy.exit`: `cargo clippy --offline --workspace --all-targets -- -D warnings: 0`
- `i2-fmt-write.exit`: `cargo fmt --all: 0`
- `i2-fmt.exit`: `cargo fmt --all -- --check: 0`
- `i2-green.exit`: `cargo test --offline -p omni-control --test body_cells -- --nocapture: 0`
- `i2-green196.exit`: `cargo test --offline -p omni-control --test body_cells -- --nocapture: 0`
- `i2-maintenance.exit`: `unshare -Urn bash -c ip link set lo up; bun --no-env-file conformance/e2e/maintenance.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a3/i2-gateway: 0`
- `i2-oracle-final.exit`: `cargo test --offline -p omni-control --test body_cells -- --nocapture: 0`
- `i2-packages.exit`: `cargo test --offline -p omni-store -p omni-control -p omni-gateway: 0`
- `i2-probe-check.exit`: `python3 /tmp/opencode/a3/i2-probe-check.py: 0`
- `i2-probes.exit`: `bash /tmp/opencode/a3/i2-probe-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/i2-gateway /tmp/opencode/a3/i2-probes: 0`
- `i2-red.exit`: `cargo test --offline -p omni-control --test body_cells -- --nocapture: 101`
- `i2-red2.exit`: `cargo test --offline -p omni-control --test body_cells -- --nocapture: 101`
- `i2-workspace.exit`: `cargo test --offline --workspace: 0`
- `i2-x3-requested.exit`: `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/a3/i2-gateway python3 conformance/e2e/x3-operator.py: 2`
- `i2-x3.exit`: `unshare -Urn bash -c ip link set lo up; env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/a3/i2-gateway python3 /tmp/opencode/a3/i2-x3-operator.py: 1`

## Binary

Built after committing, copied out to `/tmp/opencode/a3/i2-gateway`.

```
6cd31db45826b508a8bd9a63dee73323bc13131a0b42738a0502c807e5ef9c94  /tmp/opencode/a3/i2-gateway
478294f8c9b726ed4328704865b57252bc05d7f8
```

## A11 reader note (report only)

SQLite maintenance uses omni-control/src/database.rs: remove_body_rows selects only request_id/rel_path using raw bun_cell, not typed BodyRow. at filtering/cap ordering remain SQLite comparisons/order; size_bytes/sha256/detail_state/truncated are not read and cannot create the old I2 integer decoding failure. Null paths skip deletion, text paths join/unlink, numeric/BLOB paths throw before SQL deletion, as frozen. Raw request IDs are bound for deletion. Thus no observed storage-class divergence in prune/cap for these classes; maintenance does not share the old typed get reader. No A11 code changed. PG maintenance is typed and was not runtime exercised.
