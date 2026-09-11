# OmniGateway Roadmap

Candidate features identified from the repository and a September 2026 comparison with other
self-hosted AI gateways. This is a prioritized backlog, not a commitment. Each item requires a
separate design before implementation.

## Fix before adding features

### Reverse-proxy-safe session cookies

Derive the `Secure` cookie policy from the configured public `OMNI_BASE_URL`, not the backend
request URL. TLS-terminating reverse proxies otherwise risk receiving privileged session cookies
without `Secure`.

Evidence: `apps/gateway/src/routes/http.ts`, `apps/gateway/src/routes/admin.ts`,
`docs/deploying.md`.

### Causally ordered credential-health transitions

Prevent an older, slow success from clearing breaker or rate-limit protection established by a
newer failure. Add an ordering token or transition revision across both store implementations.

Evidence: `apps/gateway/src/dispatch/index.ts`, `packages/store/src/sqlite/credentials.ts`,
`packages/store/src/postgres/credentials.ts`.

## Near-term features

### 1. Scheduled snapshots

Automatically create snapshots from the existing maintenance loop. Reuse the current retention,
disk-headroom, lease, and snapshot machinery; keep the feature disabled by default and report the
last outcome in database status.

**Value:** High  
**Estimated scope:** 3–5 days

Evidence: `README.md`, `apps/gateway/src/maintenance.ts`,
`packages/control/src/database.ts`.

### 2. Store-aware readiness endpoint

Keep `/health` as a cheap liveness endpoint. Add `/readyz` with a bounded store check and report
not-ready during store failure, restore, or quiescence. Do not require configured models or
credentials by default.

**Value:** High for Kubernetes and clustered deployments  
**Estimated scope:** 2–5 days

Evidence: `apps/gateway/src/app.ts`, `k8s/deployment.yaml`, `docs/deploying.md`.

### 3. Paginated request-log investigation and export

Add stable `(at, id)` cursor pagination, server-side time/status/provider/model/key filters, and
metadata-only JSONL/CSV export. Do not include captured request bodies in bulk exports.

**Value:** High for incident investigation  
**Estimated scope:** 5–8 days

Evidence: `packages/control/src/usage.ts`, `packages/store/src/types.ts`,
`packages/store/src/sqlite/usage.ts`, `packages/store/src/postgres/usage.ts`,
`apps/dashboard/src/features/logs/LogsBoard.tsx`.

### 4. Gateway-key rotation

Mint a replacement key that copies the old key's policy, reveal it once, and optionally set the old
key's expiry to provide an overlap window. Reuse existing expiry behavior rather than adding a
rotation scheduler.

**Value:** High for routine and emergency secret rotation  
**Estimated scope:** 4–7 days

Evidence: `packages/control/src/keys.ts`, `apps/gateway/src/routes/admin.ts`,
`apps/cli/src/registry.ts`.

### 5. Manual quota refresh

Expose the existing safe quota probe as “refresh account” and optionally “refresh all” operations in
the control layer, CLI, and dashboard. Preserve cooldowns, leases, coalescing, and the rule that a
probe failure never disables a credential.

**Value:** Medium–high  
**Estimated scope:** 2–4 days

Evidence: `packages/control/src/quota/poll.ts`, `apps/gateway/src/quota/poller.ts`,
`apps/cli/src/commands/quota.ts`.

### 6. Bounded scheduled OAuth refresh

Replace serial scheduled refresh with the bounded-worker pattern already used by quota polling.
Retain per-credential coalescing and cluster coordination.

**Value:** Medium–high for installations with several OAuth accounts  
**Estimated scope:** 2–4 days

Evidence: `apps/gateway/src/oauth/scheduler.ts`, `packages/control/src/quota/poll.ts`.

### 7. Plugin starter repository

Publish one maintained starter showing a server route, migration, channel, provider stub, dashboard
panel, correct shared externals, archive packaging, and `omni plugin verify`. Defer a public testkit
until more than one external plugin needs it.

**Value:** Medium; potentially high if the plugin ecosystem grows  
**Estimated scope:** 3–6 days

Evidence: `docs/writing-a-plugin.md`, `packages/plugin-api/package.json`,
`packages/testkit/package.json`.

## Plugin opportunities

### Signed operational alerts

Build a plugin that sends deduplicated, rate-limited, signed webhooks for approaching budget or
quota exhaustion, persistent provider errors, no usable credentials, traffic spikes, coordination
degradation, and repeated authentication failures. Provider-specific Slack, email, or PagerDuty
adapters can remain outside core.

### Off-host snapshot delivery

Build a bounded post-snapshot hook or plugin that receives the snapshot path, checksum, reason, and
timestamp. Let operators connect existing S3, restic, rclone, or backup tooling instead of adding
object-storage SDKs to core.

## Strategic candidates

These require demonstrated operator demand and an architectural design before implementation.

1. **Projects and aggregate budgets** — group keys under project-level permissions, budgets, and
   usage attribution without building a full enterprise directory.
2. **Target tags and residency policy** — constrain target eligibility by region, environment,
   hosting class, or retention policy before routing and failover.
3. **Deterministic policy pipeline** — ordered pre-dispatch inspect, block, redact, or annotate
   hooks. Start with credential patterns and operator-defined regular expressions, not classifiers.
4. **Exact-response caching** — isolated by key or project, explicitly bypassable, and invalidated
   across replicas. Semantic caching remains out of scope until exact caching proves valuable.
5. **Mock provider and sanitized replay** — reproduce translation, retry, timeout, failover, and
   breaker scenarios without live provider calls or mandatory production-body retention.
6. **Declarative GitOps import/export** — validate, diff, and apply secret-free models, limits,
   routing policy, and plugin configuration through existing control operations.
7. **Embeddings and reranking APIs** — add provider-neutral contracts without forcing non-chat
   operations through chat IR.

## Not currently recommended

- **Semantic caching:** similar is not identical; unsafe defaults for agents, authorization-sensitive
  requests, and changing facts.
- **Prompt management:** makes OmniGateway responsible for versioning and deploying application
  content rather than gateway configuration.
- **MCP aggregation:** introduces a separate tool-discovery, authorization, credential, and audit
  security surface.
- **Broad media APIs:** realtime audio, image, and video need distinct contracts and should follow
  demonstrated demand.
- **More routing strategies:** operational controls around the existing request path have higher
  value than another ranking heuristic.

## Suggested order

1. Fix secure-cookie derivation.
2. Design and implement scheduled snapshots.
3. Add `/readyz`.
4. Add paginated log investigation and export.
5. Add gateway-key rotation.
6. Expose manual quota refresh.
7. Fix causal ordering of health transitions before further breaker work.
8. Add bounded OAuth refresh concurrency.
9. Publish the plugin starter.
10. Validate demand before choosing a strategic candidate.

No open GitHub issues currently establish demand for the strategic candidates. Re-rank them when
operator reports provide concrete workflows and constraints.
