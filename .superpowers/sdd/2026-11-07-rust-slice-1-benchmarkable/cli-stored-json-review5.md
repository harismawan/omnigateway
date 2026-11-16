# Narrow re-review, round 6 — eabedf83

**Verdict: REQUEST CHANGES — new Important R6, BLOB quota identity join.** Original I3's 21 projection cases are fixed, but the JSON-only lossless projection exposes structural equality in credential matching. User explicitly accepted I1, I2 and M1 as narrowly documented malformed/hand-altered-store differences; they are not silently fixed or generalized here. Evidence: `/tmp/opencode/cli-fix6-review/`. No product edits, commits, or subagents.

## Important R6 — status JSON attaches quota to separately read BLOB identities

Hand-altered affinity-free credentials/quota tables, usual credential row q/openai/quota/oauth and quota row q/fiveHour/0/1/10/NULL/0/NULL. Apply:

```sql
UPDATE credentials SET id=X'71';
UPDATE quota_windows SET credential_id=X'71';
```

Command on both: `--root <scratch>/root status --json`. Both exit **0**, stderr empty. Frozen credential `id` is `{"0":113}` and **quota is []**. Rust same credential id but **quota contains the full row**: `{"credentialId":{"0":113},"windowType":"fiveHour","startsAt":0,"used":1,"limit":10,"resetsAt":null,"observedAt":0,"windowMs":null}`. Exact full streams retained in `quota-e8gjz67r/identity.json`; same mismatch for X'' and X'0102'. Other injected INTEGER/REAL/NULL/TEXT identities agree (4 equal / 3 different of 7).

Frozen `packages/control/src/credentials.ts:282–296` groups quotas in a Map keyed by raw credentialId, then looks up raw credential id (SameValueZero; objects by identity). Separate Bun SQLite BLOB reads produce distinct Uint8Array objects, not equal by identity. CLI `apps/cli/src/commands/status.ts:80` calls this function. Rust `crates/omni-cli/src/status.rs:118` compares JsValue structural equality. New `status_quota_json` now creates the same indexed-object representation as credential cli_rows, so equal contents join incorrectly. Retain JS Map scalar/object-identity semantics at this filter; do not loosen typed readers or special-case only byte 113. This is **status JSON**, neither accepted human quota/burn nor models-put credential resolution, nor accepted setup/models-show target objects. It is not covered by any of the five documented differences.

**Before/after proof:** separate three-executable run (`quota-po8999_6/identity-regression.json`) confirms own 54d73636 binary matches frozen **7/7**, whereas own eabedf83 binary matches **4/7** and differs on the three BLOB identities. Thus R6 is a measured regression introduced by this range, not just an inherited issue. Driver capture exit0 is not claimed as parity; `identity-regression-assert.json` records exact assertions. Repeated seven-case run is additional reproduction, not seven new case identities.

## I3 CLOSED (21/21 focused cases) and human boundary

Independent touched-source `cargo build --offline -p omni-cli` (alone, own worktree target, requested jobs/debug/incremental environment) produced SHA256 **4d0fa59e3012269d1bfb887a6169b5346692538621120caae2826f93fe9e4375** at **eabedf83072aae7df816da5c2908ec998f86ba33**; copied binary before workspace feature-unifying builds. Initial disk 18 GiB, above 5 GiB cutoff.

Product diff has only two files: `status.rs:105–110` chooses lossless quota projection iff JSON flag; `credentials.rs:345–383` factors existing query/field order into `status_quota_with`. False branch still invokes `sql_value(raw)`, while true invokes `cli_cell::Cell::read(raw).json()`. `sql_value` exact source is byte-identical to 54d73636 (`sql-value-identical.json`); health/typed consumers are untouched. `status_quota_json` has only one in-tree caller, CLI status's JSON branch; HTTP/routing/snapshot/Postgres gain no call path. Typed boundary and frozen apps/packages/bun.lock diffs empty, `.exit` files both 0. Earlier read_key/operator_rows byte-identical restoration remains untouched by this range.

Own old/new human run against my round-5 copied binary (SHA256 verified `3d6a2656…`) and my new binary: **91/91 identical stdout/stderr/exit and typed DB state**, all seven columns × thirteen values. `focused.exit=0`, evidence `quota-4an749hz/human.json`. No normalizations. This independently verifies human stability for the entire new corpus, not arbitrary time-boundary invocations or the unbounded SQLite domain.

My exact 21 earlier JSON BLOB cases were rerun separately: empty, two-byte X'0102', and non-UTF8 X'ff' in each of window_type/starts_at/used/limit_value/resets_at/observed_at/window_ms. **21/21 match frozen bytes/exit and typed state**, `i3-21.exit=0`; evidence `quota-rg25zxf9/i3.json`. Frozen raw-cell projection remains `packages/store/src/sqlite/credentials.ts:361–372`; new JSON projection preserves indexed objects instead of UTF8 strings. No I3 waiver needed.

## Corpus acceptance-class audit and bite

`quota-json.py` asserts human equality exactly iff `(column,value)` is **not** in a literal identity set: all 13 explicit values for window_type/starts_at/used (39), plus six explicit limit_value values (6). Thus exactly **45** accepted human identities, not “any human failure”; remaining 46 human rows must equal. JSON mode has no exemption. Every DB snapshot must equal pre-invocation state, and both sides' stderr are decoded for panic checks.

Scratch-copy bite restricted to **window_ms=NULL**, a previously equal/nonaccepted human row, and appended hex `00` to only Rust captured stdout before comparison. The real assertion rejected it at the exact identity check (`bite.exit=1`, expected; `bite.log`). This is deliberate harness mutation, not a product regression. No corpus/product file or earlier evidence changed. Caveat: accepted identities pin where mismatches are allowed, **not the exact differing bytes** within an already accepted identity; the separate 91-case old/new comparison detects changed bytes in those rows in this review.

Six corpus scratch copies change evidence prefixes only; targeted reads scratch neighbors.py. Exact diff in `prefix-only.diff`; originals keep hardcoded implementer evidence roots, which are read-only. Every Bun invocation uses `--no-env-file`; CLI children have explicit scratch HOME/root, no real config.

## Final five documented differences (user-authorized scope)

1. **Human `status` quota/burn over malformed quota_windows cells:** coercion, percentages, ages/window labels/burn arithmetic may differ. Not status JSON, credential provider/label formatting, normal quota data, or HTTP/routing behavior. Example used INTEGER1 / limit TEXT'10': frozen percentage vs Rust unknown; JSON must still match.
2. **`models put` pinned/custom credential resolution with non-string stored id/provider/label/authType:** malformed credential identity/auth comparisons and resulting validation/errors may differ. Not blanket credential tolerance; excludes ordinary string credential fields, provider_data parse, other model commands, setup and gateway typed readers.
3. **I1 setup over malformed stored target JSON objects:** object-valued provider/limit fields may have conversion/error behavior different from frozen property-key/Math.min consumers, including swallowed ToString errors and Number-only limit narrowing. Limited to stored malformed target objects, not validated ordinary setup/config inputs or all setup failures. Prior nonterminal `{"toString":5}` reproductions identify the covered failure; interactive generated limits remain unverified. These malformed JSON payloads can also be injected in stock TEXT columns without changing schema; “hand-altered tables only” must not be mistaken for a schema-affinity precondition.
4. **I2 human `models show` with object-valued target model/credentialId fields:** eager Rust string conversion can change error precedence relative to frozen earlier cost-property errors or eventual table `text.replace` errors. Not JSON output, model list/rm/put, or arbitrary normal model-show errors.
5. **M1 inherited long-radix ToNumber rounding on malformed stored scalar inputs:** digit-by-digit f64 accumulation can differ from Bun's once-rounded large hexadecimal arithmetic (97/1,000 prior probes); no demonstrated current-epoch expiry-state mismatch. Not a general numeric-coercion/expiry waiver: prior 51 broad scalar and 1,500 safe-integer radix boundary inputs matched. No gateway/shared coercion change authorized.

Items 3–5 are accepted only for the hand-altered/malformed stored-cell scenarios ruled on by the user; no authorization to relax validated input or normal-storage behavior. Their documented scope does not include I3's JSON BLOB projection, which must be fixed.

## Inherited behavior and verification limits

Retain frozen exact bytes/error precedence outside the exceptions; direct table non-strings throw, flags use ===1, guardrail only NULL means absent, numeric TEXT date display is em dash while expiry relational checks coerce, BLOB is Uint8Array (comma-byte ToString, indexed JSON), nonfinite JSON serializes null but survives until interpolation/comparison, invalid key limits fail closed. R1–R5 prior closures and comparator bite remain applicable; this range does not change them.

Six existing neighbors exclusions remain **two random-create and four unimplemented credential mutations**, not newly accepted differences or equivalence passes. Stored-cells checks streams/exit only; targeted additionally unchanged-state flag; other three old corpora and new quota use typed snapshots. No independent rerun of controller's 53-driver matrix, exhaustive interactive config generation, arbitrary nested JSON/all cell domains, full malformed pinned/custom combinations, or intermediate historical builds. Prior interrupted round-5 wide stderr gap remains historical and is not erased; this re-review's complete-run scan will be recorded separately.

Pending: six corpus results, extracted 21 formerly failing BLOB cases, workspace/clippy/fmt results and final panic count. No completion/approval asserted yet.

## R6 complete streams, representative X'71' reproduction

All three exit0, all stderr empty; literal equal fixture paths retained.

ts:

```json
{
  "process": {
    "supervisor": "none",
    "running": false,
    "pid": null,
    "state": null,
    "unitPath": null,
    "logFile": "/tmp/opencode/cli-fix6-review/quota-po8999_6/home/state/omnigateway/gateway.log"
  },
  "adminConfigured": false,
  "credentials": [
    {
      "id": {
        "0": 113
      },
      "provider": "openai",
      "label": "quota",
      "enabled": true,
      "quota": []
    }
  ],
  "storeError": null
}
```

old:

```json
{
  "process": {
    "supervisor": "none",
    "running": false,
    "pid": null,
    "state": null,
    "unitPath": null,
    "logFile": "/tmp/opencode/cli-fix6-review/quota-po8999_6/home/state/omnigateway/gateway.log"
  },
  "adminConfigured": false,
  "credentials": [
    {
      "id": {
        "0": 113
      },
      "provider": "openai",
      "label": "quota",
      "enabled": true,
      "quota": []
    }
  ],
  "storeError": null
}
```

rust:

```json
{
  "process": {
    "supervisor": "none",
    "running": false,
    "pid": null,
    "state": null,
    "unitPath": null,
    "logFile": "/tmp/opencode/cli-fix6-review/quota-po8999_6/home/state/omnigateway/gateway.log"
  },
  "adminConfigured": false,
  "credentials": [
    {
      "id": {
        "0": 113
      },
      "provider": "openai",
      "label": "quota",
      "enabled": true,
      "quota": [
        {
          "credentialId": {
            "0": 113
          },
          "windowType": "fiveHour",
          "startsAt": 0,
          "used": 1,
          "limit": 10,
          "resetsAt": null,
          "observedAt": 0,
          "windowMs": null
        }
      ]
    }
  ],
  "storeError": null
}
```

Independent red corpus rerun with my prior 54d73636 binary: **182 pairs = 116 equal / 45 accepted human / 21 JSON failures**, red.exit1. It reproduces the claimed red state, not a new current-binary failure. Exact focused 21 cases green; full new corpus green result pending.

R6 explicit parity gate `identity-parity.py` asserts old/frozen equality first, then fails on exactly `[X'', X'71', X'0102']` for new/frozen: `identity-parity.exit=1`. Capture script exit0 is not passed off as a green parity check. This gate consumes immutable captured records; actual fresh paired invocations are in the two identity scripts/logs.
