# X3 paired HTTP storage-class probe
**Confirmed:** Rust refuses HTTP requests that frozen TS accepts, including cells reachable on the shipped schema.
Binaries: frozen `/tmp/opencode/a8/ts`; Rust `049e24c2`; both Rust manifest entries verified before use. No builds/cargo, inference, external requests, product edits or commits.
Evidence: `/tmp/opencode/x3-probe/{results.json,extra-results.json,classified-results.json,differences.md}`; numbered reproductions: `python3 repro.py PAIR_NUMBER` from that directory.
Scripts: `probe.py` setup/API seed, `run.py` matrix, `supplement.py` new-model/last-used probes, `shipped.py` intact-schema checks, `analyze.py` classification; source extracts pinned to both requested commits.
Every mutation uses stopped gateways and identical DB copies; one changed cell, target table recreated without affinity/NOT NULL (PK retained). Each mutation request gets a fresh copy; read-only requests share a boot.
Both admin logins and client login statuses, complete response bodies/content-types/statuses, process state and per-request error log slices are retained. Node UUID/seenAt clocks and JSON property order are normalized, raw bodies retained.
## Totals: pairs / equal / different (includes baseline route gaps)
- baseline: 31 / 24 / 7.
- a: 2586 / 1720 / 866.
- b: 1441 / 966 / 475.
- extra: 35 / 11 / 24.
- a by cell class (P/E/D): integer 370/228/142; real 370/228/142; blob 344/210/134; null 370/237/133; invalidutf 344/241/103; empty 370/272/98; numeric 366/268/98; object 26/18/8; array 26/18/8.
- b by cell class (P/E/D): truncated 131/94/37; bare 131/94/37; empty 131/94/37; object 131/94/37; array 131/96/35; null 131/88/43; integer 131/75/56; real 131/75/56; blob 131/86/45; blobnum 131/79/52; invalidutf 131/91/40.
- extra by cell class (P/E/D): integer 5/1/4; real 5/1/4; blob 5/0/5; null 5/1/4; invalidutf 5/0/5; empty 5/4/1; numeric 5/4/1.
## Classification and reproductions
Counts by outcome (i Rust refusal; ii both fail differently; iii frozen refusal; v both succeed with different payload, a category beyond the requested i–iv):
- a: i=158, baseline-route-gap=686, v-success-payload=17, ii=5.
- b: baseline-route-gap=385, iii=20, i=64, v-success-payload=2, ii=4.
- extra: i=19, ii=5.
Every differing pair has its SQL, request, complete responses and pinned Rust source reference in `differences.md`; admin generic INTERNAL bodies contain no parser details; /v1/models has a distinct error envelope. Logs are retained separately, not treated as HTTP divergences.
Seven baseline gaps: credentials/quota/history, database, database/snapshots, lifecycle, console, requests/:id/body, agent-setup return frozen 200/Rust 404; excluded from X3 conclusions but included in totals as `baseline-route-gap`.
Confirmed key id/label/prefix strict projection: `omni-store/src/keys.rs:326–353,433–435` → `row.rs:16–30`; INTEGER/REAL/BLOB/NULL can refuse key lists and authenticated client/model reads.
Confirmed credential pin/provider/auth-type/label pre-read: `omni-store/src/models.rs:35–43` → `omni-control/src/models.rs:56–71`; INTEGER/REAL/BLOB/NULL/invalid UTF-8 cause strict tuple refusal. New-model PUT supplements avoid the existing-target validation shortcut.
Outside suspects: the same tuple affects `/api/catalog` and `/api/settings` (`omni-control/src/api.rs:794`); raw credential BLOB projection maps to text instead of frozen Uint8Array JSON (`credentials.rs:24–30`).
Model id/strategy/targets operator readers use `omni-store/src/models.rs:140–149`; JSON-column results are separately counted in group b. Empty/numeric text and lossy UTF-8 behavior must be judged per route, not generalized from strict tuples.
## Reachability / limitations
`reachability.json` actually executes updates against untouched shipped-schema copies: BLOB, invalid-UTF-8 TEXT, empty/numeric-looking TEXT are storable in all tested TEXT columns; INTEGER/REAL become TEXT under affinity and require recreated tables to remain numeric.
NULL is reachable for TEXT primary-key ids, credentials.account_email, api_keys.model_allowlist and request_logs.api_key_id/credential_id; NOT NULL blocks other tested TEXT cells. JSON malformed strings/object/array are storable; JSON INTEGER/REAL storage classes require affinity removal.
Nested target credentialId has JSON types, not independent SQLite storage classes: numbers/null/empty/numeric-string/object/array tested; BLOB/invalid-byte TEXT cannot exist as standalone JSON values (whole targets invalid UTF-8 is group b).
Coverage: all GETs in admin_routes.rs route(), extra frozen stored-row GETs, client summary/usage/logs/quota/history, /v1/models; key PATCH (404 on both), PUT smart-routing, DELETE; credential PATCH/DELETE; pinned model PUT/DELETE.
Not covered: provider-reset GET/refresh/redeem (can contact providers), stream subscription, other key PUT variants, settings/password mutations, quota/health table-cell mutations or multiple-row interactions.
Some client reads are 401 after malformed key-id lookup despite a successful client login; statuses retained, not represented as successful authorized coverage.
Frozen hazards: see per-case hazard flags and statuses; generic frozen 500s alone are not content leaks. Three stored-content-quoting /v1/models 500s are listed below; no crash/hang.
Request-log id/api_key_id/credential_id suspicion refuted for tested log, health and join requests across all seven storage classes (see results); this does not generalize to MAX(at), tested separately in extra.
Last-used MAX(at) supplement: integer TS/Rust=200/200, real TS/Rust=200/200, blob TS/Rust=200/500, null TS/Rust=200/200, invalidutf TS/Rust=200/500, empty TS/Rust=200/500, numeric TS/Rust=200/500. Source: omni-control/src/credentials.rs:193–200.
request_logs.at has INTEGER affinity: numeric TEXT becomes INTEGER; BLOB/invalid UTF-8/empty TEXT remain reachable, REAL is reachable, NULL is blocked. Thus the MAX(at) divergence includes shipped-schema inputs.
Intact-schema confirmation (no table recreation), `shipped-results.json`: credentials.id invalid UTF-8 → catalog TS200/Rust500; api_keys.label BLOB → keys TS200/Rust500 (two additional pairs, both class i).
Known-only differences: UUID version/log sanitization produce no HTTP-only class iv pairs here; node id/seenAt volatility is explicitly normalized. Both-success semantic differences are retained as v, not mislabeled iv.
Frozen total 500s: 91; frozen nonzero error logs: 102. Per-case generic 500s remain recorded even when neither content-leaking nor a crash/hang.
Inherited hazard confirmed: /v1/models with bare `broken` in credentials.provider_data, api_keys.model_allowlist or virtual_models.targets returns frozen 500 quoting `JSON Parse error: Unexpected identifier "broken"`; Rust behavior is recorded per pair. No crash/hang observed.
One probe-port collision during intact-schema setup was detected from exited Rust process state; affected pair 2839 was replayed in isolation by repair.py and replaced. Intact-schema checks reran on 19502/19503; no remaining startup/transport failures.
Hazard totals: {"null": 4090, "500-quotes-content": 3}.
Small shipped-schema reproduction: `UPDATE api_keys SET label=X'7178'`; admin `GET /api/keys`: frozen 200 with `label:{"0":113,"1":120}`, Rust 500 `{"error":{"code":"INTERNAL","message":"internal error"}}`; full frozen response in shipped-results.json.
Grand total: 4,093 matrix/supplement pairs, 2,721 equal / 1,372 different; plus 2 intact-schema confirming pairs. Excluding baseline route gaps: 241 i, 14 ii, 20 iii, 19 semantic-success differences (plus 2 intact-schema i).
Cleanup verified via `/proc`: no gateway processes or listeners on 19500–19599; only seed.db retained, total artifacts ~25 MB (`cleanup.json`).
Read CLI generator technique and frozen/pinned sources; executed only the custom probes, never admin-routes.ts. Report contains measurements, no fix recommendation.
