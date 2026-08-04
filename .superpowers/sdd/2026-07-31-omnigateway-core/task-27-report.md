# Task 27 Report

## What I built

- Added `apps/gateway/test/e2e/upstream.ts`, an order-preserving `HttpClient` stub that scripts JSON, error, and SSE responses while capturing the exact URL, authorization value, ordered header pairs, raw request body, and parsed request body.
- Added `apps/gateway/test/e2e/gateway.test.ts` with the brief's 12 exact end-to-end test names and assertions. The tests run `createApp` with the real provider adapters and exercise real wire encoding/decoding, client identity headers and order, CCH body signing, streaming, failover, commit-point behavior, OAuth refresh, clean unknown-model errors, health, and log redaction.
- Added dispatch refresh-on-401 behavior. Before client commitment, an `AUTH` failure from an OAuth credential with a refresh token triggers one refresh and one retry of that same candidate.
- Added focused dispatch unit coverage for successful refresh/retry, a second `AUTH`, refresh failure, and avoiding a second sequential refresh after pre-emptive refresh.

## D3 design decision

`maxAttempts` and `log.attempts` count candidate selections, not HTTP exchanges. The one same-candidate refresh retry is nested inside that candidate's slot, so it does not consume an additional `maxAttempts` slot and cannot starve later candidates. Thus a two-credential failover still records `log.attempts === 2`, while a successful refresh and retry of the first candidate records `log.attempts === 1`.

Each candidate has at most one reactive AUTH refresh. A second `AUTH` after that retry falls through to the existing next-candidate behavior. If refresh throws, its classified error becomes that candidate's failure and dispatch proceeds according to the existing retryability rules.

To avoid burning a rotating refresh token, reactive refresh is suppressed when the attempt already required a pre-emptive refresh. Dispatch computes one `attemptNow` timestamp and uses it both to determine whether pre-emptive refresh applies and as the timestamp passed to `attempt()`, avoiding a boundary race between two clock reads. When reactive refresh succeeds, its returned secrets are passed directly into the retry, so `attempt()` neither reloads stale secrets nor pre-emptively refreshes again.

## Deviations from the brief

- Per D1, replaced the brief's explicit `any` response cast with concrete response shapes and `unknown` where appropriate. The CCH token assertion includes an explicit narrowing guard because TypeScript does not infer definedness from the preceding Bun matcher.
- Per D2, used the real final test count rather than the stale expected count. Final result is 435 pass / 0 fail: 419 pre-task tests plus 12 e2e tests and 4 focused dispatch tests.
- Per D3, changed production dispatch code and added focused unit coverage because the planned refresh-on-401 behavior did not previously exist.
- Removed the brief's unnecessary `as StubResponse` cast after `queued.shift()` because the queue is already typed and the code passes strict type checking without it.
- Verification steps 2 and 3 were skipped as directed because booting the server and the curl walkthrough require a live process and are not gateable here.
- Kept the brief-required positional credential wrapper and the `header()` / `headerNames()` produced interfaces. External cleanup suggestions to remove or lazily redesign them were rejected because they would conflict with the exact brief and add complexity to test-only synthetic fixtures.
- A review suggested narrowing reactive refresh to raw HTTP 401 rather than canonical `AUTH`. No change was made: D3 explicitly specifies the dispatch-loop condition as “when an attempt throws and `classify()` yields `AUTH`,” and the dispatch/provider boundary intentionally exposes the canonical gateway error rather than raw HTTP status.

## Verification output

### `bun test`

```text
bun test v1.4.0-canary.1 (91460bcfb)

 435 pass
 0 fail
 1018 expect() calls
Ran 435 tests across 39 files. [3.06s]
```

### `bun run typecheck`

```text
$ tsc -b --pretty false
```

### `bun run lint`

```text
$ biome check .
biome.json:5:13 deserialize  DEPRECATED  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The use of the recommended field has been deprecated, and will removed in the next major version of Biome. Use preset instead.
  
     3 │   "files": { "includes": ["**/*.ts", "**/*.tsx", "**/*.json", "!.superpowers"] },
     4 │   "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
   > 5 │   "linter": {
       │             ^
   > 6 │     "enabled": true,
        ...
  > 11 │     }
  > 12 │   }
       │   ^
    13 │ }
    14 │ 
  
  i Migrate the configuration with the proper command
  
  $ biome migrate
  

Checked 120 files in 23ms. No fixes applied.
Found 1 info.
```

The lint command exited successfully. The only output is a pre-existing Biome configuration deprecation notice.

### Verification step 4: module boundaries

```text
ok
ok
```

Commands:

```bash
grep -rn "@omni/store" packages/providers/src && echo "VIOLATION" || echo "ok"
grep -rn "@omni/providers" apps/gateway/src/router && echo "VIOLATION" || echo "ok"
```

### Verification step 5: no secrets

```text
ok
```

Command:

```bash
grep -rn "sk-ant-[A-Za-z0-9]\|sk-proj-[A-Za-z0-9]" --include='*.ts' packages apps && echo "VIOLATION" || echo "ok"
```

### Verification step 6: no `fetch` on the upstream path

```text
ok
```

Command:

```bash
grep -rn "fetch(" --include='*.ts' packages/providers/src apps/gateway/src/oauth && echo "VIOLATION" || echo "ok"
```
