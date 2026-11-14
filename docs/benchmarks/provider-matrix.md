# Provider matrix

`bun scripts/bench-gateway.ts --matrix --gateway <argv> --cli <argv>` generates
eight cases per provider: chat/messages/responses × json/stream (64 clients,
one upstream chunk), overhead-c1 (one client), and chunks-2000 (16 clients).
The last two stream through the provider's nearest ingress. `--only` accepts
comma-separated exact names or `*` globs, e.g. `'custom-*'` or `'*.responses.*'`.
An empty selection is an error. Without `--matrix`, existing scenarios and
the legacy JSON schema are preserved, including exact-only `--only` selection.

Currently available: `custom-chat` and `custom-responses`. Both use CLI-created
custom credentials on distinct endpoint IDs, upstream model
`mock-c<chunks>-d0`, and a two-process upstream on port 18100. Both codecs always
request upstream SSE, independently of ingress response mode.

Each scenario is smoked before measurement: HTTP status, content type and
ingress-specific text location are checked. Capability/request rejection
(400/404/405/422/501) is `unsupported` with the response error recorded; other
errors or invalid 200 bodies are `failed`. Supported smoke proceeds through
the existing load, status, request-log and writer-barrier checks. A failed
matrix makes the process exit nonzero. Unsupported cases retain their name
and reason and have no metrics. Metrics for measured cases are nested in
`metrics`; provider, ingress, mode and classification are explicit.

The provider table lives in `scripts/bench-matrix.ts`. Additional custom-wire
entries specify id, provider, credential protocol, nearest ingress, origin and
script. New non-custom providers still need credential/model setup and upstream
launch support; the Anthropic extension is not implemented at this checkpoint.
Matrix cluster setup is explicitly rejected.

## Functional checks

From this worktree (gateway processes run in scratch directories):

```sh
bun scripts/bench-gateway.ts --matrix \
  --gateway /tmp/opencode/merge-anthropic/ts \
  --cli 'bun apps/cli/src/index.ts' --duration 2s --warmup 1s --boots 1 \
  --out /tmp/opencode/bench-matrix/ts-custom.json
OMNI_RUST_BINARY=/tmp/opencode/merge-anthropic/rust \
  bun scripts/bench-gateway.ts --matrix --gateway "sh $PWD/scripts/run-rust-gateway.sh" \
  --cli 'bun apps/cli/src/index.ts' --duration 2s --warmup 1s --boots 1 \
  --out /tmp/opencode/bench-matrix/rust-custom.json
```

For measurement use `--duration 20s --warmup 3s --boots 5`, explicitly pin
gateway/upstream/load CPU sets, use a quiet host and retain multiple interleaved
rounds. Ceiling calibration and an automated interleaved runner are pending;
short functional runs on the shared host are not performance evidence.
