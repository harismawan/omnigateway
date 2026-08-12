# Remote Control — Design

Date: 2026-08-12
Status: Approved

## Problem

Anthropic's Claude Code Remote Control cannot be used with OmniGateway. Claude Code hard-disables the
feature whenever `ANTHROPIC_BASE_URL` points at a host other than `api.anthropic.com`, surfacing
"Remote Control is only available when using Claude via api.anthropic.com." The feature's bridge host
(`wss://bridge.claudeusercontent.com`) is fixed in the CLI and is never derived from
`ANTHROPIC_BASE_URL`, so no gateway route can serve it. It additionally requires a full-scope
claude.ai OAuth login; API keys are unsupported. See
<https://code.claude.com/docs/en/remote-control>.

Gateway users therefore lose the ability to respond to a session from a phone. This design adds an
independent, self-hosted equivalent scoped to two capabilities: **approve/deny permission prompts**
and **reply at turn end**. It does not attempt to drive a session remotely, and does not interoperate
with Anthropic's Remote Control.

## Scope

In scope:

- Approve or deny a tool-permission prompt from the dashboard.
- Send a reply when a session finishes its turn, or let it stop.
- Arm/disarm the feature globally from the dashboard (any install) and the CLI (local install only).
- Optional outbound webhook notification when an item needs attention.

Out of scope:

- Starting or driving sessions remotely.
- Injecting a message into a session that is idle at the prompt. Claude Code exposes no supported
  mechanism for this; replies land only at turn boundaries (`Stop`) or tool boundaries (`PreToolUse`).
- Web Push / PWA notifications.
- Per-session arming. Arming is global.

## Architecture

Three components.

### 1. Hook client — `apps/cli`

New `omni rc hook` subcommand, invoked by Claude Code hooks. Reads hook JSON on stdin, calls the
gateway, waits for a decision, writes hook JSON on stdout. `omni rc install` writes the `PreToolUse`
and `Stop` entries into `~/.claude/settings.json`.

Gateway URL and RC token resolve through the existing CLI root order: `--root` > `OMNI_ROOT` >
installation in cwd > `~/.config/omnigateway`.

### 2. RC coordinator — `packages/control`

New `rc` module. Caller-type-agnostic per boundary rule 6: no Elysia, cookies, argv, terminal, or
timers of its own. Holds armed state, the pending-request map, decision resolution, and webhook
dispatch. Clock injected.

### 3. Gateway routes — `apps/gateway/src/routes/rc.ts`

Machine side (RC token auth):

- `POST /api/rc/ask` — SSE; creates or rejoins a pending item and streams the decision. One endpoint
  serves both flows, distinguished by a `kind` field (`"approve"` or `"reply"`).
- `GET /api/rc/armed` — cheap armed-state check for the hook hot path.

Human side (admin session auth):

- `GET /api/rc/pending` — SSE list of live items.
- `POST /api/rc/pending/:id/decide`
- `GET | PUT /api/rc/armed` — `GET` accepts either an RC token or an admin session; `PUT` requires an
  admin session.

Dashboard page lives under the existing SPA.

### Flow

`PreToolUse` → hook client → `POST /api/rc/ask` → coordinator creates pending, fires webhook, hook
holds the SSE connection → operator decides on dashboard → coordinator resolves → hook prints
`permissionDecision` → session continues. Disarmed or timed out → hook prints nothing → Claude Code
falls back to the normal terminal prompt.

## Transport and timeouts

Cloudflare returns 524 when no response headers arrive within 100s, so the wait is SSE rather than a
blocking POST.

- `POST /api/rc/ask` responds `text/event-stream`: a `pending` event immediately, `: keepalive`
  comments every 15s, one terminal `decision` event, then close. Mirrors the existing keepalive
  pattern in `apps/gateway/src/routes/proxy.ts`.
- The hook client owns the deadline (default 300s). The `timeout` in `settings.json` is set slightly
  higher (310s) so the hook client, not Claude Code, terminates the wait and exits cleanly.
- On deadline, transport failure, 401, or any error the hook exits 0 with empty stdout. Claude Code
  renders no decision and falls back to the terminal prompt. **Fail open to the terminal, never
  auto-allow.**
- The coordinator expires the item at the same deadline and marks it `expired`. A late dashboard
  decision on an expired item is rejected with an explicit message, never silently applied.
- If the hook's SSE drops before a decision, it retries once with the same `requestId`. The
  coordinator treats this as idempotent: it returns the existing pending item and does not re-fire
  the webhook. A second failure fails open.
- `GET /api/rc/pending` uses the same SSE and keepalive discipline.

## Data model

Persisted in `@omni/store`:

- `rc_tokens`: `id`, `label`, `hash`, `createdAt`, `lastUsedAt`, `revokedAt`. The raw token is
  returned exactly once at creation and only the hash is stored, matching the gateway API key
  contract.
- Settings: `rcArmed` (bool), `rcWebhookUrl` (nullable), `rcDeadlineSeconds` (default 300).

In gateway process memory only:

```
PendingItem {
  id, kind: "approve" | "reply",
  sessionId, host, cwd, toolName,
  payload,            // full tool input, or last assistant message
  createdAt, expiresAt,
  state: "waiting" | "decided" | "expired"
}
```

`sessionId` and `cwd` come from hook input. `host` is a machine label the hook client sends, taken
from an `rcHostLabel` config value and defaulting to the OS hostname; it exists so items from several
dev machines are distinguishable in the dashboard.

Pending items are lost on restart by design, consistent with other process-local state (API-key rate
limits, quota cooldowns).

## Auth

- Machine routes require `Authorization: Bearer <rc token>`. Gateway API keys and admin cookies are
  rejected. A revoked token returns 401 and the hook fails open.
- Human routes require the existing admin session, preserving the rule that every `/api/*` route
  outside documented setup/status/login flows checks the admin session.
- `POST /api/rc/ask` is rate limited per token, process-local, matching existing key-limit style.
- Token issuance: `omni rc token create` for a local install, dashboard Settings for a remote one.

CLI arming (`omni rc arm` / `disarm`) administers a **local** installation through `@omni/control`
and never calls `/api/*`, per boundary rule 11. A gateway reachable only over the network is armed
from the dashboard.

## Content and privacy

Remote approval requires showing what is being approved, so RC payloads carry full tool input (whole
bash command, full diff, full path) and, for the reply flow, the last assistant message. This is a
deliberate, bounded exception to the no-prompt-bodies rule:

- Payloads live only in the in-memory pending store. They are never written to `request_logs`,
  `usage`, or `usage_daily`.
- Payloads never pass through `LogFields`. No new free-text log field is added; `LogFields` remains a
  closed allowlist with no index signature.
- Stdout events record `sessionId`, `toolName`, and `decision` only.
- Payloads are dropped when the item resolves or expires, and on restart.

## Reply flow

`Stop` hook, armed only:

1. Hook posts `last_assistant_message`, `session_id`, and `cwd`; coordinator creates a `reply` item.
2. Dashboard shows the message, a text box, and two actions: **Send reply** and **Let it stop**.
3. Reply → hook prints `{"decision":"block","reason":"<text>"}`; Claude continues with that text as
   its next instruction.
4. "Let it stop" or timeout → empty stdout → the session ends normally.

Constraints:

- While armed, every turn end blocks up to the deadline. This is the cost of the reply channel.
  "Let it stop" resolves immediately; disarming lets the next `Stop` pass straight through.
- `stop_hook_active: true` means the turn is already a continuation. We still ask, and the dashboard
  shows a continuation-count badge.
- Claude Code auto-overrides after 8 consecutive `Stop` blocks. At count ≥ 7 the dashboard warns that
  the next reply may be the last unless `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` is raised. OmniGateway does
  not set that variable.
- `transcript_path` is written asynchronously and may lag the current turn, so the reply flow uses
  `last_assistant_message` from hook input and never reads the transcript file.

## Failure modes

| Condition | Behavior |
| --- | --- |
| Gateway unreachable or DNS failure | hook exits 0, empty stdout, terminal prompt |
| RC token revoked or 401 | same, plus a one-line stderr note |
| Disarmed | hook returns immediately; armed-check cached 5s to keep the hot path cheap |
| Deadline hit | item marked `expired`, hook fails open |
| Gateway restart mid-wait | SSE drops, one retry, then fail open; pending items lost by design |
| Two browsers decide at once | first write wins; the second receives 409 with current state |

## Testing

- **Coordinator**: injected clock. Arm/disarm, pending create/resolve/expire, idempotent re-ask on
  the same `requestId` with no duplicate webhook, late decision on an expired item rejected,
  concurrent decide → 409.
- **Gateway routes**: stub clock and in-memory store. Auth matrix across RC token, gateway API key,
  admin cookie, and revoked token on both machine and human routes. SSE emits headers immediately,
  sends keepalives, ends with one terminal `decision` event, and leaves no timers or listeners.
- **Redaction**: assert payload text never appears in `request_logs`, `usage`, or any stdout line.
  Include an anchor test that fails if payload is added to a log field.
- **Hook client**: stdin JSON to stdout JSON with an injected HTTP client; no real network, no writes
  outside temp directories. Cases: allow, deny, expire → empty, 401 → empty, transport error →
  empty, `Stop` reply → `decision: block`, `Stop` let-it-stop → empty.
- **Dashboard**: happy-dom with `test/helpers/fetchStub.ts`, `renderWithProviders`. Pending list
  renders, decide posts, arm toggle works, expired items render disabled. Assert visible text and
  accessible names; re-query after async loads.
- **Gates before completion**: `bun test`, dashboard suite, `bun run typecheck`, `bun run lint`.

## References

- Claude Code Remote Control: <https://code.claude.com/docs/en/remote-control>
- Claude Code hooks reference: <https://code.claude.com/docs/en/hooks>
