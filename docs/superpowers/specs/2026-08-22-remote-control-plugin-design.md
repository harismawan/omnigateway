# Remote Control Plugin — Design (Draft)

Date: 2026-08-22
Status: **Draft — incomplete.** Components, the host change, and the transport decision are
settled. The session model, wire protocol, failure matrix, testing plan, and documentation
changes are not yet written. Do not implement from this file.

Supersedes the scope of
[2026-08-12 Remote Control](2026-08-12-remote-control-design.md) (approved, never implemented:
there is no `rc` module in `packages/control` and no `apps/gateway/src/routes/rc.ts`). That design
predates the plugin host (2026-08-19) and the federated dashboard SDK (2026-08-21), and it stopped
at approve/deny plus reply-at-turn-end. This one drives sessions.

## Problem

Anthropic's Claude Code Remote Control is unusable behind OmniGateway: the CLI hard-disables it when
`ANTHROPIC_BASE_URL` is not `api.anthropic.com`, its bridge host is fixed in the binary, and it
requires a full-scope claude.ai OAuth login. Gateway users lose the ability to answer a session from
a phone. The 2026-08-12 design added a self-hosted equivalent limited to two hook-shaped
capabilities. The requirement now is larger: **start sessions and send messages mid-turn from the
web today, and from a native mobile app later.**

## Decisions

Each of these was chosen explicitly during brainstorming. The reasoning is recorded because several
look arbitrary in isolation.

1. **Scope is a superset of the old design.** Start new sessions, message mid-turn, interrupt — plus
   the old approve/deny and reply-at-turn-end.
2. **Sessions run on any machine, via a persistent agent.** Not gateway-host-only. A daemon on each
   dev box holds an outbound connection to the gateway; the gateway never dials in. NAT and
   firewalls therefore never enter the design.
3. **Two tiers of session, one list.** Agent-spawned sessions are fully drivable. Sessions the user
   started in a terminal are visible and expose only the hook capabilities, because Claude Code
   offers no supported way to attach to a running TUI. The tier is shown per session. tmux keystroke
   injection was rejected: it covers everything and fails silently.
4. **Machine-facing ingress is a new plugin-host capability, not core RC routes.** See below.
5. **Transcripts persist, encrypted with a plugin-held key.** See "Transcript storage".
6. **One route set, two guards.** Operational routes accept an admin session *or* a machine token,
   so the future mobile app is client work only.
7. **Built on the core WebSocket transport**, which lands first. See "Transport".

## Components

Four pieces, three trust zones.

### `omni rc agent` — `apps/cli`

One daemon per dev box, holding a machine token. Outbound only: it opens a WebSocket to
`/api/stream`, authenticates the machine token at upgrade, and subscribes to its own topics —
commands downward, session output upward on `plugin:rc:session:<id>`. Plain `POST` routes under
`/api/plugins/rc/m/…` remain for request-shaped operations (register host, list sessions, mint
nothing) where a stream would be the wrong shape.

It owns the child processes: `claude --input-format stream-json --output-format stream-json
--verbose`, one per driven session. Spawning lives here and never in the gateway — a plugin has no
process capability and should not gain one.

### `omni rc hook` — `apps/cli`

The same binary in hook mode. `PreToolUse` and `Stop` entries in `~/.claude/settings.json`, as in
the 2026-08-12 design, which is what makes tier-2 sessions visible at all. Fails open to the
terminal prompt on any error and never auto-allows.

### RC plugin, server half

Session registry, pending-decision map, encrypted transcript store, routes. Live state lives in the
`setup` closure and dies with the process, consistent with quota cooldowns and the 1m ring.

### RC plugin, UI half

The console panel today; the mobile app later, against the same routes.

### Dev machine requirements

The `omni` binary, not an OmniGateway installation. No install root, no `omnigateway.db`, no
`OMNI_ENCRYPTION_KEY`, no gateway process. Agent config is its own file — `~/.config/omnigateway/rc.json`
holding `{ gatewayUrl, token, hostLabel }`, written `0600` by `omni rc login <url>`, with env
overrides. Deliberately **not** the install-root/`.env` resolution chain: that chain exists to select
a database and there is none here, and staying out of it sidesteps the `--root`/ambient
`OMNI_DB_PATH` suppression trap.

**Boundary carve-out required.** `CLAUDE.md` rule 11 says the CLI administers local installations
through `@omni/control` and never calls `/api/*`. `omni rc agent` and `omni rc hook` do call
`/api/*`. They are **client** roles, not admin roles: machine token only, never an admin session, no
admin operation reachable through them. The rule must say so explicitly rather than leave this
reading as a violation.

A separate `@omnigateway/rc-agent` package was considered — smaller install on the dev box, one more
artifact to publish and version against `api`. Rejected for now; the single binary wins.

## Host change: `routes:machine`

The only core change, and it is generic rather than RC-shaped.

- New manifest capability `"routes:machine"`. Route entries gain `auth?: "admin" | "machine" |
  "either"`, defaulting to `"admin"`, so every existing plugin is unchanged and a plugin declaring
  the new capability against an older host fails closed at manifest parse.
- The host enforces that any route whose `auth` is not `"admin"` mounts under
  `/api/plugins/<id>/m/…`, so the guard is readable off the URL and `omni plugin verify` and the
  catalog can report which routes a token reaches without reading plugin code.
- Tokens are **host-owned**. New core table `plugin_machine_tokens` (`id`, `pluginId`, `label`,
  `hash`, `createdAt`, `lastUsedAt`, `revokedAt`). The raw value is returned exactly once and only
  the hash is stored, matching the gateway API-key contract. Minted by `POST /api/plugins/:id/tokens`
  (admin session) and `omni plugin token create <id>` through `@omni/control`. A plugin never mints
  or verifies a token.
- The plugin still writes no guard and still never receives headers. The host verifies the bearer and
  injects `machine: { tokenId, label } | null` into `PluginRequest`.
- A bearer and an admin cookie on the same request is a conflict and is rejected, matching the
  `/v1/*` rule.
- Per-token rate limit, process-local.

**To be stated plainly in the docs:** a machine token for the RC plugin is admin power over every
session that plugin can reach. The capability context remains a guardrail rather than a sandbox;
this capability widens who may knock, not what a plugin can do once inside.

## Transcript storage

Driving a session pushes full prompt and response text through the gateway — precisely what core
never logs. Two documented properties were at stake: no prompt bodies in logs, and "snapshot is the
database alone, so a downloaded snapshot is never a prompt corpus."

Chosen: **persist transcripts in plugin storage tables, encrypted with a key the plugin generates and
keeps at `<root>/plugins/rc/data/rc.key`**, which snapshots exclude. This is the argument that
already makes snapshots inert — the ciphertext travels, the key does not — so deep scrollback
survives a restart while a leaked snapshot still is not a prompt corpus.

Accepted costs:

- Restoring onto a fresh box yields unreadable history unless the key is copied by hand.
- The plugin does its own crypto; `OMNI_ENCRYPTION_KEY` is deliberately out of reach.
- Snapshot *size* still tracks prompt volume, which the current documentation also denies. That
  sentence must be corrected.

A retention cap — age plus a per-session row cap, configurable — bounds the corpus rather than
letting it grow forever.

Rejected: memory-only tails with deep scrollback fetched from the agent's own
`~/.claude/projects` (loses history when the agent is offline); plaintext rows (makes every snapshot
a prompt corpus).

## Transport

**Depends on [the WebSocket transport design](2026-08-22-websocket-transport-design.md), which lands
first.** RC is born on the socket; no long-poll transport is written and later deleted.

Long-poll was the earlier plan, on the reasoning that a plugin route cannot stream and a 45s poll
sits under Cloudflare's 100s header deadline. It was rejected on sequencing: RC needs
keystroke-latency commands downward and token deltas upward, so long-poll would only have been a
worse socket, written and tested twice.

What RC consumes from that design:

- `/api/stream`, one multiplexed connection, machine-token auth at upgrade for the agent and the
  future mobile app, admin-session auth for the console panel.
- The `channels` plugin capability: the plugin receives `{ onMessage, send, onClose }` for topics
  namespaced `plugin:rc:*` and never touches a socket or a header.
- The `stream:` delivery class — monotonic `seq` per topic, a bounded replay ring, and an explicit
  `gap` frame when a reconnecting agent has fallen behind it. RC never claims a gapless transcript;
  a `gap` sends the client to the REST transcript fetch.
- Bounded per-subscriber queues that drop rather than grow.

RC therefore needs no transport of its own, and the fallback question belongs to that design rather
than this one: an operator whose proxy strips `Upgrade` gets a degraded console, and RC session
driving is unavailable rather than silently slow.

## Sequencing

1. [WebSocket transport](2026-08-22-websocket-transport-design.md) — approved, lands first.
2. `routes:machine` host capability and `plugin_machine_tokens` (described above). The WebSocket
   design already assumes this table for machine-token upgrades, so the two are adjacent.
3. This plugin, once both exist.

## Open — not yet designed

- Session model: identity, lifecycle, tier transitions, what "interrupt" means per tier, cwd and
  repo association, multi-agent/multi-host listing.
- RC's own message set over `plugin:rc:*`: command vocabulary, resume after agent restart, how a
  `gap` is surfaced in the panel.
- Console panel: layout, live-switch integration, what a tier-2 session renders.
- Notifications: the 2026-08-12 outbound webhook, and what mobile push would need later.
- Failure modes table, testing plan, and the documentation changes listed above
  (`CLAUDE.md` rules 11 and 15, `ARCHITECTURE.md`, `README.md` snapshot claims,
  `docs/writing-a-plugin.md`).

## References

- [2026-08-22 WebSocket transport design](2026-08-22-websocket-transport-design.md) — prerequisite
- [2026-08-12 Remote Control design](2026-08-12-remote-control-design.md)
- [2026-08-19 Plugin host design](2026-08-19-plugin-host-design.md)
- [2026-08-21 Federating the SDK](2026-08-21-federating-the-sdk-design.md)
- Claude Code Remote Control: <https://code.claude.com/docs/en/remote-control>
- Claude Code hooks reference: <https://code.claude.com/docs/en/hooks>
