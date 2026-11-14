# Provider matrix

`bun scripts/bench-gateway.ts --matrix --gateway <argv> --cli <argv>` generates
eight cases per provider: chat/messages/responses × json/stream (64 clients,
one upstream chunk), overhead-c1 (one client), and chunks-2000 (16 clients).
The last two stream through the provider's nearest ingress. `--only` accepts
comma-separated exact names or `*` globs, e.g. `'custom-*'` or `'*.responses.*'`.
An empty selection is an error. Without `--matrix`, existing scenarios and
the legacy JSON schema are preserved, including exact-only `--only` selection.

Available: `custom-chat`, `custom-responses`, `anthropic-key`, `anthropic-oauth`.
The custom variants use CLI-created
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

The provider table lives in `scripts/bench-matrix.ts`. Entries specify id,
provider, credential protocol, nearest ingress, origin and script. Credentials
are CLI-created; OAuth uses the conformance encrypted-SQLite seed format with
expiry in 2100. Anthropic targets pin credential IDs so variants cannot cross-route.
The Anthropic stub serves Messages SSE, usage and token endpoints; arbitrary
mock model names pass through unchanged. Matrix cluster setup is rejected.

Run the complete matrix through `bash scripts/bench-matrix.sh`: it creates a
private network/mount namespace, hosts override and TLS certificate trusted only
through `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`. Two pinned stub processes share
each origin. New providers need a table entry and scripted upstream plus a seed
helper only if their credential is unavailable through `credentials add-key`.

## Functional checks

From this worktree (gateway processes run in scratch directories):

```sh
bash scripts/bench-matrix.sh \
  --gateway /tmp/opencode/merge-anthropic/ts \
  --cli 'bun apps/cli/src/index.ts' --duration 2s --warmup 1s --boots 1 \
  --out /tmp/opencode/bench-matrix/ts-custom.json
OMNI_RUST_BINARY=/tmp/opencode/merge-anthropic/rust \
  bash scripts/bench-matrix.sh --gateway "sh $PWD/scripts/run-rust-gateway.sh" \
  --cli 'bun apps/cli/src/index.ts' --duration 2s --warmup 1s --boots 1 \
  --out /tmp/opencode/bench-matrix/rust-custom.json
```

For measurement on a quiet host:

```sh
export OMNI_RUST_BINARY=/path/to/release/omnigateway
BASE_GATEWAY=/path/to/frozen-ts HEAD_GATEWAY="sh $PWD/scripts/run-rust-gateway.sh" \
CLI='bun apps/cli/src/index.ts' OUT=/tmp/opencode/bench-matrix/real ROUNDS=5 MAX_LOAD=1 \
bash scripts/bench-rounds.sh --duration 20s --warmup 3s --boots 5 \
  --gateway-cpus 0-3 --upstream-cpus 4-5 --load-cpus 6-7
DURATION=20s bash scripts/bench-upstream-check.sh
bun scripts/bench-capacity.ts /tmp/opencode/bench-matrix/upstreams /tmp/opencode/bench-matrix/real/base/*.json /tmp/opencode/bench-matrix/real/head/*.json
bun scripts/bench-compare.ts /tmp/opencode/bench-matrix/real/base /tmp/opencode/bench-matrix/real/head
```

The runner alternates AB/BA round order, retains results, records uptime/load
and refuses high starting load (`ALLOW_BUSY=1` overrides). Comparison reports
successful/total rounds, median and min–max alongside throughput ratios.
Short functional runs on the shared host are not performance evidence.
Fault injection: `OMNI_BENCH_FAULT=500` or `missing-credential` with one selected
scenario checks that fast failures cannot become supported measurements.
