# OmniGateway CLI — Design

Date: 2026-08-08
Status: approved

## Problem

OmniGateway is administered through the browser console only. Everything an
operator does — connecting a provider account, issuing a gateway key, reading
usage, changing routing settings — requires a running gateway, a browser, and an
admin session. That leaves three gaps:

1. **Bootstrapping.** A fresh install has no admin password and no credentials.
   Setting those up over HTTP means the server must already be running and
   reachable.
2. **Repair.** When the gateway will not start, or the operator has forgotten the
   admin password, the console is exactly the tool that is unavailable.
3. **Automation.** There is no machine-readable path for scripting routine
   operations on the host.

The gateway also has no process story of its own: starting it is `bun
apps/gateway/src/index.ts`, and keeping it running is left to the operator.

## Solution

A single-binary CLI, `omni`, that manages a local OmniGateway installation by
talking directly to its SQLite store, and that owns the gateway process
lifecycle through systemd.

The CLI is a **local, host-side tool**, not a remote client. It requires the
database file and `OMNI_ENCRYPTION_KEY`, and it works whether or not the gateway
is running. This is a deliberate choice over an HTTP client: the commands that
matter most are the ones needed when the server is down.

Writing to the store while the gateway runs is safe. The gateway rebuilds its
routing snapshot from the store on every request, so a CLI change takes effect
immediately with no reload. The state the CLI cannot see is process-local by
design: API-key rate-limit counters, quota-poll cooldowns, in-flight OAuth
flows, and admin sessions. None of it is persisted, and none of it is
authoritative.

## Architecture

Admin logic lives in one place and is used by both front ends.

```
                     packages/control
                   (admin operations)
                     /            \
      apps/gateway routes      apps/cli commands
        (HTTP adapter)          (terminal adapter)
```

### packages/router (new, by move)

`apps/gateway/src/router/**` moves verbatim to `packages/router`, exported as
`@omni/router`. It is already pure, side-effect free, and depends only on
`@omni/ir` and `@omni/store` types — a package-shaped module that happens to
live inside an app. The move is required because dry-run and health reporting
call `buildSnapshot` and `rank`, and a CLI package cannot import from an app.
Making the router a package also hardens architectural constraint 3: purity is
now enforced by what the package is allowed to depend on.

### packages/control (new)

The admin brain. No HTTP server, no console output, no timers.

| Module | Contents |
| --- | --- |
| `schemas.ts` | zod schemas moved out of `routes/admin.ts`: model, keyCreate, settings, credentialPatch, dryRun, grain/dimension, `requireDimension` |
| `credentials.ts` | list projection, patch semantics, remove, force-refresh |
| `models.ts` | list, put (id/body match), remove |
| `dryRun.ts` | hypothetical-request ranking over a snapshot |
| `keys.ts` | list projection, create (raw key returned once), revoke |
| `settings.ts` | get, put |
| `usage.ts` / `logs.ts` | aggregate queries and recent request logs |
| `health.ts` | credential health, token expiry, quota windows |
| `oauth/**` | move of `apps/gateway/src/oauth/` except `scheduler.ts` |
| `connect.ts` | `createConnectFlows({ store, providers, http, now })` → `start` / `finish` / `poll` |
| `adminAuth.ts` | move of `apps/gateway/src/auth/admin.ts` (argon2, session map) |
| `quotaProbe.ts` | the one-shot probe extracted from `quota/poller.ts` |
| `config.ts` | move of `apps/gateway/src/config.ts` |

Each operation takes `{ store, now }`, returns plain data, and throws
`GatewayError`. Nothing in `control` knows about Elysia, cookies, argv, or a
terminal.

`config.ts` moves so that the CLI and the gateway parse `OMNI_*` through one
reader. Two readers of the same environment drift, and the failure mode is a CLI
that writes to a different database than the server reads.

Dependencies: `@omni/ir`, `@omni/store`, `@omni/providers`, `@omni/router`,
`zod`, `@node-rs/argon2`.

### apps/gateway (changed)

`routes/admin.ts` and `routes/connect.ts` become adapters: read the session
cookie, `requireAdmin`, call a control function, map `GatewayError` to a status.
The OAuth token scheduler, the quota poller, maintenance, dispatch, and ingress
are untouched. `scheduler.ts` and the poller loop stay in the gateway because a
timer is a runtime side effect, not an admin operation.

### apps/cli (new)

`@omni/cli`, `bin: { omni: "./src/index.ts" }`, bun shebang, no runtime
dependencies beyond workspace packages. Argument parsing uses `node:util`'s
`parseArgs`, matching the repository's lean-dependency habit.

| Module | Responsibility |
| --- | --- |
| `index.ts` | argv → command dispatch → exit code |
| `args.ts` | `parseArgs` wrapper, global flags, help text |
| `context.ts` | root resolution, env loading, lazy store construction |
| `output.ts` | table and lamp rendering, colour policy, `--json` |
| `service.ts` | systemd detection, unit generation, pidfile supervision |
| `commands/*.ts` | one module per command group |

Exit codes: `0` success, `1` operator error (not found, refused, conflict), `2`
usage error, `3` gateway unreachable when a command required it.

## Installation root resolution

Every command resolves a **root** before doing anything, in this order:

1. `--root <path>`
2. `OMNI_ROOT`
3. the current directory, if it contains a `.env` or an OmniGateway database
4. `~/.config/omnigateway`

The CLI loads `<root>/.env`, then lets the real process environment win over it,
then applies `--db` as a final override of the database path. `omni doctor`
prints the root it chose and the file it read, because a tool that silently
reads the wrong database is worse than one that refuses to run.

The resolved root is baked into the generated systemd unit, so the service and
the CLI always agree on which installation they manage.

## Command surface

```
omni status                        process, credential health, and quota on one screen
omni start [--foreground]
omni stop
omni restart
omni service install [--system] [--enable] [--force]
omni service uninstall
omni doctor
omni logs [-n N] [--follow] [--service]

omni connect <provider> [--label L]
omni credentials list
omni credentials show <id>
omni credentials enable|disable <id>
omni credentials set <id> [--label L] [--tier N] [--weight W]
omni credentials rm <id>
omni credentials refresh <id>
omni credentials add-key <provider> [--label L]

omni models list
omni models show <id>
omni models put <id> (-f model.json | --from-catalog <provider>:<model> ...)
omni models rm <id>
omni models dry-run <id> [--tools] [--images] [--reasoning]

omni keys list
omni keys create [--label L] [--allow <model> ...] [--rate-limit N]
omni keys revoke <id>

omni settings get
omni settings set <dotted.path> <value>

omni usage [--grain daily|raw] [--by DIMENSION] [--since T] [--until T]

omni admin set-password
omni db migrate
```

`omni logs` reads the gateway's request logs from the store. `--service` reads
the process's own output instead — the journal under systemd, the log file under
the pidfile supervisor.

### omni connect

Runs the real authorization flow in the terminal against the same
`createConnectFlows` the console drives:

1. `start` returns an authorize URL, and a user code for device-code providers.
2. The CLI prints both. It does not open a browser: the tool is expected to run
   over SSH as often as not.
3. Device-code providers are polled at the interval the provider reported.
   Redirect providers wait for the operator to paste the callback URL or code,
   which is normalized and state-checked exactly as the console does.
4. On success the credential is written and its id printed.

### omni models put

Two input paths. `-f model.json` validates a full virtual model against the
moved `modelSchema`. `--from-catalog anthropic:claude-opus-4-5` seeds a target
from `@omni/providers/catalog`, including list pricing, then applies flag
overrides. This preserves architectural constraint 9: the catalog is a source of
defaults, and the saved target remains the source of truth for pricing.

## Process management

The unit is `omnigateway.service`.

`omni service install` writes it to `~/.config/systemd/user/` by default, or
`/etc/systemd/system/` with `--system`. The unit sets `WorkingDirectory` to the
resolved root, `EnvironmentFile` to `<root>/.env`, `ExecStart` to the resolved
`bun` binary running the gateway entrypoint, and `Restart=on-failure`. Install
then runs `daemon-reload`, and `systemctl enable` when `--enable` is passed. An
existing unit file is never overwritten without `--force`.

`omni start` checks whether a unit is installed. If it is, start, stop, restart,
and status delegate to `systemctl` — systemd is the supervisor, and the CLI does
not compete with it. If no unit is installed, the CLI spawns the gateway
detached, writing a pidfile and a log file under
`$XDG_STATE_HOME/omnigateway/`. Start then polls `/health` until the gateway
answers or a timeout expires, so a successful `omni start` means the gateway is
serving, not merely spawned.

`omni stop` is `systemctl stop`, or SIGTERM followed by a grace period and then
SIGKILL. A pidfile whose pid is not alive, or whose process cmdline does not
match the gateway, reads as stopped and the stale file is cleared. The pidfile
is never trusted as evidence on its own.

## Security

- The encryption key is never printed. `omni doctor` reports presence and length
  only.
- Provider secrets are never printed, in any format, including `--json`.
- A raw gateway API key is printed exactly once, at `keys create`, matching the
  existing control-API behaviour. It exists in plaintext nowhere else.
- `omni admin set-password` and `omni credentials add-key` read secrets from an
  interactive prompt with echo disabled, or from stdin when piped. Never from
  argv, which is world-readable in the process table, and never from an
  environment variable that would land in shell history.
- `credentials rm`, `models rm`, `keys revoke`, and `service uninstall` prompt
  for confirmation on a TTY and require `--yes` when stdout is not a TTY.
- Diagnostics go to stderr so that `--json` on stdout stays parseable.

## Output

Human-readable by default: aligned tables, and the same state vocabulary the
console uses. Colour is used only for provider identity and state, never
decoratively, and is disabled when stdout is not a TTY or `NO_COLOR` is set.

`--json` on any command emits a single JSON document on stdout. This is the
scripting contract; table layout is not.

## Testing

- **control**: unit tests per operation against a temporary SQLite store and a
  stub `HttpClient`. Connect flows are covered for both the redirect and
  device-code shapes, including state mismatch and expiry.
- **gateway**: the existing route, OAuth, and dispatch tests must pass
  unedited. That is the proof the extraction preserved behaviour. A test that
  needs editing to pass is a signal that behaviour changed, not that the test
  was wrong.
- **cli**: commands are tested as functions against an injected context — a
  temporary store, a fake process spawner, and a fake `systemctl` runner. No
  test starts a real process or writes outside a temporary directory. Root
  resolution is covered as a table test over the four cases. Output formatting
  and the `--json` shape are asserted directly.
- `apps/cli` joins the root `bun test`; it needs no DOM and is not excluded like
  the dashboard suite.

## Non-goals

- Remote administration. The CLI manages a local installation. Operators
  administering a remote gateway use the console or SSH.
- Replacing the console. The dashboard remains the primary interface for
  browsing usage and health.
- Init systems other than systemd. The pidfile supervisor is the fallback
  everywhere else and is not presented as a production supervisor.
- Multi-instance management. Version 1 is single-node and single-operator; one
  root means one gateway.
- Shell completions. Deferred until the command surface has settled.

## Risks

The extraction moves roughly 1400 lines of working gateway code. The existing
test suite is the safety net, and the move is mechanical, but it is the largest
part of this work and it lands before any CLI code is useful.

The generated systemd unit depends on an absolute `bun` path resolved at install
time. If bun is later reinstalled elsewhere, the unit breaks until
`omni service install --force` regenerates it. `omni doctor` checks that the
unit's `ExecStart` binary still exists.
