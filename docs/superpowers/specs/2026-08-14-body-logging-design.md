# Body Logging Design

## Goal

Give operators an opt-in record of request and response bodies for incident forensics, covering both
the client-facing pair and every provider wire pair, without weakening the existing redaction
boundary. Body capture is off by default, encrypted at rest, bounded in both size and row count, and
expires on the existing log retention schedule.

## Prior art

OmniRoute v3.8.48 implements this feature, and its shipped source is the reference for several
decisions below. Three points are load-bearing:

- It stores bodies as JSON artifacts on disk with a database row holding only a pointer. It did not
  start there: `src/lib/db/core.ts` drains a `call_logs_v1_legacy` table into file artifacts, gated on
  `detail_state = 'legacy-inline'`. Inline blobs in SQLite were tried and migrated away from.
- It truncates structurally rather than by byte count, bounding string length, array length, nesting
  depth, and object key count independently.
- It bounds disk with a row cap in addition to a time window, because a time window alone does not
  bound anything under load.

Its artifact schema is at `schemaVersion: 5` and its detail state carries `missing` and `corrupt`,
which is the honest signal that a file and its row will desynchronise and the reader must cope.

OmniRoute is a separate codebase under its own license. It informs the design; no code is copied.
Whether it encrypts its artifacts was not determined and is not assumed either way here.

## Security posture

`LogFields` is not widened, and no body ever reaches a logger sink. Stdout, journald, `OMNI_LOG_FILE`,
and the dashboard console tail carry exactly what they carry today. The closed allowlist in
`packages/ir/src/logger.ts` remains the compile-time redaction boundary; this feature adds a separate
storage path rather than relaxing it.

Headers are never captured at any layer. Anthropic, OpenAI, and Kimi all authenticate through
headers, so `HttpRequest.headers` is where OAuth tokens and API keys live. The capture decorator reads
`HttpRequest.body`, which is a plain string, and never receives the header list.

Excluding headers is necessary but not sufficient, because secrets reach bodies by other routes: a
user pastes an API key into a prompt, or a provider echoes a credential fragment in an error message.
Captured bodies are therefore masked before they are written, replacing bearer tokens, `sk-`/`ak-`/
`pk-` prefixed keys, and long opaque tokens with elided forms.

Masking costs fidelity in exactly the payloads an operator captured in order to read, and a
length-based rule for opaque tokens will also hit base64 image data, content hashes, and minified
source. This is accepted deliberately: a body corpus that leaks a live credential is a worse failure
than one that elides a base64 blob. The masker must be anchored by tests that pin both what it
redacts and what it leaves intact, so the false-positive surface is a known quantity rather than a
discovery made later.

Artifacts are encrypted at rest under the required `OMNI_ENCRYPTION_KEY`, using the same encryption
path as provider credentials. Artifact files copied without the key yield nothing. An operator who
never enables the setting stores nothing at all.

## Configuration contract

Capture requires two independent keys, both of which must be set:

- `OMNI_BODY_LOGGING_ALLOWED=1` in the environment, read at boot. Without it the gateway ignores the
  setting entirely.
- `settings.bodyLoggingEnabled: boolean`, defaulting to `false`, alongside the existing `rtkEnabled`
  runtime boolean.

Two keys mean a compromised admin session cannot by itself start recording prompts, and an operator
can still flip capture on and off mid-incident without a restart once the environment permits it.
Disabling stops new capture; it does not delete artifacts already written.

`settings.bodyLoggingCaptureStreamChunks: boolean`, default `false`, additionally retains raw SSE
frames per attempt. This is the only way to debug stream framing itself, and it is the most expensive
thing this feature can store, so it is separately gated rather than implied by capture being on.

Individual API keys may opt out. An api key with `body_logging_opt_out` set is never captured,
whatever the settings say. This exists so a shared installation can serve a client whose payloads must
not be retained, and it is checked before any capture work begins.

Structural bounds are constants, not settings:

- string values truncated past 64 KB
- arrays reduced to their last 24 items, keeping the most recent conversation turns
- nesting deeper than 6 levels replaced with a marker
- objects reduced to their first 80 keys

Bounding structurally rather than by byte offset keeps the stored artifact valid, readable JSON. A
byte-truncated body is frequently unparseable, which makes it useless for the forensics that motivated
capturing it.

After structural bounding, an artifact still exceeding 512 KB has its bodies replaced with an omission
marker recording the reason, rather than being written oversized or dropped silently.

## Retention and disk bounds

Two independent limits, because either alone fails:

- `settings.logRetentionDays`, the existing window, applied to body rows and their artifacts.
- A row cap of 100000 body rows, pruning oldest first.

The time window is what an operator reasons about. The row cap is what actually bounds disk: at
sustained load a seven-day window over full traffic is unbounded in practice, and the row cap is the
backstop that keeps a busy week from filling the disk.

Pruning deletes the artifact file and the row together. A sweep also removes artifact files with no
corresponding row, since a crash between the two writes leaves an orphan.

Deletion is explicit, not a foreign key cascade. Cascade behavior depends on the `foreign_keys` pragma
being enabled, and a silently disabled pragma would turn expiry into unbounded retention of a prompt
corpus.

## Storage layout

Artifacts live under a `request_bodies` directory beside the configured database file, sharded by
date so no single directory grows without bound and so a whole day can be purged as a unit:

```
<dirname(databasePath)>/request_bodies/YYYY/MM/DD/<requestId>.json.enc
```

The database row holds only the pointer and the integrity metadata:

```sql
CREATE TABLE request_bodies (
  request_id   TEXT PRIMARY KEY,
  at           INTEGER NOT NULL,
  rel_path     TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT,
  detail_state TEXT NOT NULL DEFAULT 'none',
  truncated    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_request_bodies_at ON request_bodies (at DESC);
```

`detail_state` is one of `none`, `ready`, `missing`, or `corrupt`. A reader that cannot find or cannot
decrypt an artifact records the state on the row and returns the metadata rather than failing, because
a body corpus and its index will drift and the reader is where that has to be survivable.

`sha256` is taken over the stored bytes, so on-disk truncation or corruption is detectable without the
encryption key.

## Artifact shape

One artifact per request, holding the client pair and every wire pair together:

```json
{
  "schemaVersion": 1,
  "requestId": "...",
  "at": 0,
  "client": { "request": {}, "response": {}, "truncated": false },
  "attempts": [
    {
      "attempt": 1,
      "provider": "anthropic",
      "request": {},
      "response": {},
      "streamChunks": null,
      "truncated": false
    }
  ],
  "error": null
}
```

`client` is what arrived at `/v1/*` and what the gateway returned. `attempts` are the wire pairs in
dispatch order. A failover incident therefore reads as one ordered story in one file: client payload,
what went to the first provider, what it returned, what went to the second.

`streamChunks` is populated only when `bodyLoggingCaptureStreamChunks` is on; otherwise streaming
responses appear as the reassembled final response.

`schemaVersion` is present from the first release. OmniRoute is on its fifth revision of this shape,
so the field is not speculative.

## Capture path

Client-facing capture hooks the `finishLog` choke point in `apps/gateway/src/routes/proxy.ts`, which
already runs exactly once per request id on both the success and error paths, and therefore inherits
the existing single-write guarantee.

Wire capture wraps the `HttpClient` injected into each dispatch attempt through `AdapterRequest.http`.
`HttpClient` is a single function type, so capture is a decorator: `nodeHttpClient` is unchanged, the
rule that all outbound provider HTTP goes through `HttpClient` is unchanged, and the decorator knows
its provider and attempt number without threading extra context.

Captured pairs accumulate in memory during the request. Masking, structural bounding, encryption, and
the artifact write all happen at `finishLog`, after the response has completed.

Streaming provider responses require teeing `HttpResponse.body`. A tee whose second branch is not
drained builds backpressure until the first branch stalls, which would make body logging a latency bug
under load. The implementation must hold these rules:

- The adapter's branch is byte-identical to the uncaptured stream and is never delayed by capture.
- The capture branch is always drained to completion, discarding bytes past the cap. It is never
  abandoned mid-stream.
- An error or cap hit in the capture branch never propagates to the adapter branch. Capture failure
  degrades to a missing artifact, never to a failed request.
- No artifact write happens on the commit path.
- Pre-commit failover and post-commit stream semantics are unchanged.

Client cancellation still writes an artifact. The captured response is whatever completed before the
disconnect, marked truncated.

## Access

`GET /api/requests/:id/body` decrypts and returns the artifact, or returns the row's `detail_state`
when the artifact is missing or corrupt. It requires an admin session like every other `/api/*` route.
The dashboard shows the artifact on request log row expansion. No CLI command in this change.

## Tests

Configuration and gating:

- Setting defaults to `false`; with it off, nothing is written.
- Setting on but `OMNI_BODY_LOGGING_ALLOWED` unset writes nothing.
- Both keys set writes an artifact.
- An api key with `body_logging_opt_out` is never captured while another key on the same gateway is.

Content and correctness:

- The artifact holds the client pair and one entry per provider attempt, ordered, with correct
  provider per attempt.
- Streaming and non-streaming paths both capture.
- `streamChunks` is null unless the stream-chunk setting is on, and populated when it is.
- Client cancellation mid-stream still writes a truncated artifact.

Redaction, the load-bearing properties:

- A distinctive marker in a prompt appears nowhere in the captured stdout sink while capture is on.
  This is the regression test that fails if `LogFields` is later widened.
- A synthetic bearer token in upstream request headers appears nowhere in any artifact.
- A synthetic API key embedded in a prompt body is masked in the stored artifact.
- The masker leaves a specified set of non-secret long strings intact, pinning the false-positive
  surface.
- Stored artifact bytes do not contain the plaintext marker, so a refactor that skips encryption fails
  rather than passing a green suite.

Bounds and lifecycle:

- A string past 64 KB, an array past 24 items, nesting past 6 levels, and an object past 80 keys are
  each bounded, and the result parses as JSON.
- An artifact still over 512 KB after bounding is written with the omission marker.
- Retention sweep removes rows and their artifact files at the configured window.
- The row cap prunes oldest rows and their files once exceeded.
- An artifact file with no row is removed by the sweep.
- A row whose artifact was deleted underneath it reads as `missing`, not as an error.
- A row whose artifact fails to decrypt reads as `corrupt`.

Non-interference:

- Bytes delivered to the adapter are identical with capture on and off.
- A slow capture branch does not delay adapter-side stream delivery.

The access route rejects an unauthenticated caller. Full core, dashboard, typecheck, and lint suites
run before completion.

## Scope

Add the settings fields and their schema validation, the api key opt-out column, the store migration
and body repository, the artifact writer and reader with masking and structural bounding, the capture
decorator and its wiring into dispatch, the `finishLog` write, the retention and row-cap sweeps, the
admin route, and the dashboard row expansion.

Do not widen `LogFields`, do not capture headers at any layer, do not change `nodeHttpClient`, do not
store bodies inline in SQLite, and do not alter existing retention defaults or stream commit
semantics.
