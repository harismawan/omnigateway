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

## X3 multirow blast radius follow-up
Evidence: `/tmp/opencode/x3-probe/multirow/{results.json,summary.json,differences.md,quota-recovery.json,progress.log,cleanup.json}`. Frozen and Rust 049e24c2 binaries; Rust manifest checksum verified. No builds/product edits/external requests.
Two keys, two same-provider credentials and two pinned models seeded through frozen APIs. Provider `custom` uses only localhost:19510 SSE stub; both baseline inference requests return 200 and reach the stub. A stays intact; only B cell changes.
159 mutation cases plus baseline, 19 paired requests each. Key cases cover both actual rowid orders (SQL and live cellcheck evidence in progress.log); other tables B follows A. INTEGER/REAL and forbidden NULL use recreated target tables; other inputs keep shipped schema.
Totals: 3040 pairs; {"equal": 2645, "rust-refuses-malformed": 189, "rust-refuses-admin": 111, "both-refuse-different": 29, "frozen-refuses": 43, "both-succeed-different": 21, "rust-refuses-healthy": 2}. Per-cell/class/request totals and every healthy refusal are in summary.json.
Headline: healthy-identity Rust-only refusals occurred.
- Rust-only healthy refusal: credentials.provider_data/integer/after, /api/client/quota, frozen 200/Rust 500; `UPDATE credentials SET provider_data=1 WHERE rowid=2`; recreated=True. crates/omni-control/src/client_quota.rs:481 → credentials.rs:47–57,32–43: whole-table provider_data validation, as_bytes rejects numeric SQL values.
- Rust-only healthy refusal: credentials.provider_data/real/after, /api/client/quota, frozen 200/Rust 500; `UPDATE credentials SET provider_data=1.5 WHERE rowid=2`; recreated=True. crates/omni-control/src/client_quota.rs:481 → credentials.rs:47–57,32–43: whole-table provider_data validation, as_bytes rejects numeric SQL values.
Shared healthy failures (including equality): [{"case": 121, "cell": "credentials.provider_data/integer/after", "path": "/api/client/quota", "sql": "UPDATE credentials SET provider_data=1 WHERE rowid=2", "recreated": true, "ts": 200, "rust": 500}, {"case": 122, "cell": "credentials.provider_data/real/after", "path": "/api/client/quota", "sql": "UPDATE credentials SET provider_data=1.5 WHERE rowid=2", "recreated": true, "ts": 200, "rust": 500}, {"case": 123, "cell": "credentials.provider_data/blob/after", "path": "/api/client/quota", "sql": "UPDATE credentials SET provider_data=X'7178' WHERE rowid=2", "recreated": false, "ts": 500, "rust": 500}, {"case": 125, "cell": "credentials.provider_data/invalidutf/after", "path": "/api/client/quota", "sql": "UPDATE credentials SET provider_data=CAST(X'71ff' AS TEXT) WHERE rowid=2", "recreated": false, "ts": 500, "rust": 500}, {"case": 126, "cell": "credentials.provider_data/empty/after", "path": "/api/client/quota", "sql": "UPDATE credentials SET provider_data='' WHERE rowid=2", "recreated": false, "ts": 500, "rust": 500}, {"case": 128, "cell": "credentials.provider_data/truncated/after", "path": "/api/client/quota", "sql": "UPDATE credentials SET provider_data='\"canary_multi' WHERE rowid=2", "recreated": false, "ts": 500, "rust": 500}, {"case": 129, "cell": "credentials.provider_data/bare/after", "path": "/api/client/quota", "sql": "UPDATE credentials SET provider_data='broken' WHERE rowid=2", "recreated": false, "ts": 500, "rust": 500}].
Mechanism: `/api/client/quota` validates every credential provider_data before projecting accounts: `omni-control/src/client_quota.rs:481` → `credentials.rs:47–57` → `32–43`. One unreadable B row becomes whole-request failure; INTEGER/REAL fail as_bytes although frozen JSON.parse coerces numbers.
Shipped-schema scope: malformed TEXT (empty, invalid UTF-8, truncated/bare JSON) and BLOB provider_data can break healthy client quota on BOTH binaries. Numeric SQL storage requires no-affinity recreation; numeric-looking TEXT remains parseable on shipped schema.
Routing isolation: `omni-store/src/keys.rs:526–533` plus read_key_entry isolates key errors; `credentials.rs:288–309` isolates credential errors; `models.rs:179–227` isolates models. Healthy-key /v1/models and local inference results are enumerated below.
- Healthy /v1/models: {"(200, 200)": 145, "(500, 200)": 15}.
- Healthy /v1/chat/completions: {"(200, 200)": 149, "(500, 200)": 11}.
- Healthy /api/client/login: {"(200, 200)": 160}.
- Healthy /api/client/summary: {"(200, 200)": 160}.
- Healthy /api/client/usage: {"(200, 200)": 160}.
- Healthy /api/client/logs: {"(200, 200)": 160}.
- Healthy /api/client/quota: {"(200, 200)": 153, "(200, 500)": 2, "(500, 500)": 5}.
All Rust processes stayed alive: True. Healthy model list + inference after SQL repair: {"cases": 159, "recovered": 159, "max_seconds": 0.003321825060993433}. These immediate successes measure continued availability where A never failed, not proof of B snapshot convergence.
Quota recovery, same A session/no restart: integer: 500→200 in 0.0025s; real: 500→200 in 0.0016s; blob: 500→200 in 0.0015s; invalidutf: 500→200 in 0.0017s; empty: 500→200 in 0.0030s; truncated: 500→200 in 0.0015s; bare: 500→200 in 0.0021s.
Key B raw secret is always supplied. Altered hash makes it unresolvable; strict metadata/JSON refusal, absent client cookie after failed login, and unusable model/credential are separately visible as response statuses. B identity for credential/model cases is key B requesting model B.
Admin lists/catalog/settings measured in every case; source references and full responses in differences.md. Keys with tied created_at can differ by list ordering; request UUID/created timestamps are normalized for equality, raw responses retained.
Not covered: non-custom providers, quota history, key mutation routes, multiple corrupt rows, concurrent traffic, B recovery timing. Client usage/logs queried before inference to avoid UUID/time-generated log differences; empty histories do not establish join behavior under load.
Key row-order effects on HTTP status pairs: [].
Cleanup: {"listeners": [], "gateway_processes": [], "remaining_databases": ["seed.db"], "artifact_bytes": 12128204}. Measurements only; no recommendation.
