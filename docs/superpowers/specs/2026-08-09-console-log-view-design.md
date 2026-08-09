# Console Log View — Design

Date: 2026-08-09
Status: approved

## Problem

The gateway writes two logs, and they overlap where it hurts and diverge where
it matters.

**They overlap on stdout.** Every finished request produces a `request_logs`
row *and* a terminal access line — `request done`, `request failed`, or
`request cancelled` (`apps/gateway/src/routes/proxy.ts:254-256`, `:297`). The
row is the durable, queryable, prunable record, surfaced by `/api/logs`, the
console's Logs screen, and `omni logs`. The stdout line restates it, less
completely, in a place nothing can query. On a busy gateway that line is most of
what an operator sees scroll past, which makes stdout useless for the thing
stdout is good at: telling you what the process is doing when it is not serving
requests.

**They diverge on everything else.** Token refresh failures, credential
auto-disable, failover between candidates, quota probe rate limiting, boot
failures, store write failures — none of these appear in `request_logs`, and
none is reachable from the console at all. An operator debugging "why did this
account stop working" has to leave the browser, find the host, and know whether
the process runs under systemd or under the CLI's own supervisor.

So: the console shows the log that duplicates stdout, and cannot show the log
that does not.

## Solution

Two changes that meet in the middle.

1. Delete the terminal access lines from stdout. The request log lives in
   SQLite; that is where it is read from.
2. Give the dashboard and the CLI a view of the gateway's *process output* — a
   new Console screen and an `omni console` command, both reading whatever
   captured stdout.

The result is a clean split by question. `Logs` answers "what did clients ask
for", from `request_logs`. `Console` answers "what is the process doing", from
stdout. Neither restates the other.

### What leaves stdout, and what does not

Only the four terminal access lines are deleted. They are exactly the lines that
restate a `request_logs` row.

Everything else request-scoped stays, because none of it is in that row:

- `attempt failed; retrying` and `attempt authentication failed; refreshing
  credential` (`dispatch/index.ts:382`, `:336`) — the row records how many
  attempts happened, never why each one failed.
- `authentication rejected`, `rate limit rejected` (`proxy.ts:163`, `:176`) — a
  rejected request never becomes a row.
- `failed to record request start` / `route` / `persist request log`
  (`apps/gateway/src/logging.ts:58`) — these fire precisely when the row is
  missing, so moving them into the row is circular.
- Dispatch's debug tracing (`routing candidates ranked`, `attempt started`,
  `stream committed`, `preemptive credential refresh`) — what `OMNI_LOG_LEVEL=debug`
  is turned on to see.

`requestId` is the join. A warn line carries it and so does the row, so a
diagnostic on the Console screen leads to a request on the Logs screen and back.
That correlation is why the field stays on the surviving lines.

`packages/store` still writes every row exactly as before. `usage.begin`,
`usage.route`, and `usage.append` are untouched, as is the `usage_daily` rollup.
This change removes a *print*, not a record.

Mechanically, the `log` closure at `proxy.ts:224` survives and only shrinks. It
keeps the cancellation branch that rewrites a zero status to `499`/`interrupted`
and keeps its `finishLog` call; what goes is the `fields` object at `:234` and
the three-way `if` at `:254-256` beneath it. The outer catch keeps its
`finishLog` and loses only the `logger.error` at `:297`. `LogFields` becomes an
unused import; `ErrorCode` does not, since `errorResponse` still takes one.

## Reading the gateway's own output

A process cannot read back what it wrote to stdout. Something else captured it,
and the gateway has to find out what.

### Source resolution

```ts
export type ConsoleSource =
  | { kind: "file"; path: string }
  | { kind: "journal"; unit: string; scope: "user" | "system" }
  | { kind: "none" };
```

In order:

1. **`OMNI_LOG_FILE`**, if set. New configuration, read in
   `packages/control/src/config.ts` and taken literally.
2. **The systemd journal**, if `omnigateway.service` is installed —
   `journalctl -u omnigateway.service -n <lines> --no-pager`, with `--user`
   under a user-scope unit. This is what `apps/cli/src/service.ts:310` already
   does.
3. **`none`.**

`none` is a first-class answer, not an error. Under `bun run dev` the gateway's
stdout goes to a terminal that nothing captured; there is no file and no unit,
and there is nothing wrong. The screen says so, in those words, rather than
rendering an empty table that reads as a failure.

Both writers set the file when they can. The CLI's pidfile supervisor already
passes `logFile` to its spawner (`apps/cli/src/service.ts:19`) and will set
`OMNI_LOG_FILE` to the same path in the child's environment. `unitFile()` gains
a `StandardOutput=append:` line pointing at that path, so a newly installed unit
has a file too. Journald remains the fallback for units installed before this
change — an operator is not required to reinstall.

### The reader

One implementation, in `packages/control/src/console.ts`, with every side effect
injected. It knows nothing about Elysia, argv, or a terminal.

```ts
export type ConsoleDeps = {
  /** null when the file does not exist. */
  readFile: (path: string) => string | null;
  /** The same CommandRunner seam apps/cli/src/service.ts uses. */
  run: CommandRunner;
};

export function resolveConsoleSource(input: {
  logFile: string | undefined;
  unitInstalled: boolean;
  scope: "user" | "system";
}): ConsoleSource;

export async function readConsole(
  deps: ConsoleDeps,
  source: ConsoleSource,
  opts: { lines: number; level?: LogLevel; since?: number },
): Promise<ConsoleRead>;

export type ConsoleRead = {
  source: ConsoleSource["kind"];
  /** Present only for kind: "file". */
  path?: string;
  lines: ConsoleLine[];
};
```

`serviceLogs` in `apps/cli/src/service.ts:310` collapses into a call to
`readConsole`, so there is one implementation rather than two that drift.

`readConsole` reads the tail: the last `lines` entries, newest last, after
filtering. `since` returns only entries strictly newer than that timestamp,
which is what `--follow` and the dashboard's poll use to avoid reprinting.
An unparsable line has no timestamp and is therefore never returned by a
`since` query — it appears on a full read only.

### Parsing a line back

`ConsoleLine` is the raw line plus whatever can be recovered from it:

```ts
export type ConsoleLine = {
  /** The line exactly as it was written. Always present. */
  raw: string;
  at: number | null;
  level: LogLevel | null;
  msg: string | null;
};
```

The parser is a pure function in `packages/ir/src/logger.ts`, beside
`formatLine` that produced the format. It reads the fixed head —
`<iso> LEVEL msg  k=v k=v` — and stops there. Structured fields are *not*
parsed into an object: they are already rendered in `raw`, which is what both
surfaces display, and re-deriving them would create a second definition of a
format that has exactly one.

Two things force `null`. Journald carries lines the gateway did not write —
systemd's own `Started omnigateway.service`, or anything the runtime printed
outside the logger. And a `reason` field can contain a newline, so a rendered
line is not guaranteed to survive a naive split. Unparsable lines pass through
as `raw` with null fields and are shown, never dropped: the line that explains a
crash is often the one that did not come from the logger.

`level` filtering applies only to lines that parsed. A level filter is a
narrowing of the gateway's own output, and silently swallowing everything else
would hide exactly the foreign lines an operator went looking for.

Colour is stripped before parsing. `createLogger` is constructed with
`color: Boolean(process.stdout.isTTY)` (`apps/gateway/src/index.ts:12-23`), so
a gateway started on a TTY by the pidfile supervisor writes ANSI escapes into
its log file. The parser removes them; the surfaces re-apply their own.

## Surfaces

### API

`GET /api/console?lines=&level=` in `apps/gateway/src/routes/admin.ts`,
admin-gated like every neighbour, calling `readConsole`. Returns `ConsoleRead`.
`lines` clamps to 1..500, matching `logLimit`
(`packages/control/src/usage.ts:46`); the default is 200.

`source` is part of the response, not an internal detail. The page states which
log it is showing, and cannot state it without being told.

Shelling out from a request handler is new for the gateway. The argv is fixed
and no request value reaches it — `lines` is a clamped integer, `level` is a
parsed enum, and neither is interpolated into a shell string. The call goes
through the injected `CommandRunner`, so no test spawns a process.

The route is admin-only for the same reason `/api/logs` is: these lines carry
credential ids, provider names, model names, and upstream error text. They carry
no prompt bodies, tokens, or keys — `LogFields` is a closed allowlist and that
property is what makes this screen safe to build at all. This design does not
widen it.

### Dashboard

One new nav entry, `Console` → `/console`, beside the existing `Logs`
(`apps/dashboard/src/components/RailNav.tsx:23`). Logs keeps its route, its name,
and its meaning; nothing is renamed and no operator's bookmark breaks.

- Route: `apps/dashboard/src/routes/_app.console.tsx`, four lines, matching
  `_app.logs.tsx`.
- Feature: `apps/dashboard/src/features/console/ConsoleBoard.tsx`.
- Hook: `useConsole` in `apps/dashboard/src/api/queries.ts`, polling on the LIVE
  cadence exactly as `useLogs` does.

Lines render monospace, one per row, newest last. Level uses the state palette
already in the theme — no new decorative colour. The three query states use
`Failure`/`SkeletonRows`/`Empty` from `ui/States.tsx`.

**The source hint.** The page always shows which log it is reading and how to
change it, as a footer note under the lines — not only when empty. An operator
looking at a file who expected the journal needs to know that as much as one
looking at nothing.

- `file` — “Reading `<path>`, set by `OMNI_LOG_FILE`.”
- `journal` — “Reading the systemd journal for `omnigateway.service`. To read a
  file instead, set `OMNI_LOG_FILE=/path/to/gateway.log` and restart the
  gateway.”
- `none` — carried by the empty state instead of a footer: “This gateway's
  output is not being captured, so there is nothing to show. Under `bun run dev`
  it goes to your terminal. To capture it, set
  `OMNI_LOG_FILE=/path/to/gateway.log` and restart the gateway, or run it under
  systemd with `omni service install`.”

The same three sentences are what `omni doctor` prints, which already reports
what it resolved.

### CLI

`omni console [-n N] [--follow] [--level L]`, in
`apps/cli/src/commands/console.ts`, registered in `apps/cli/src/registry.ts:42`
and grouped in `apps/cli/src/help.ts:3` under Gateway.

`--follow` polls at 2s and prints only lines newer than the newest already seen,
the shape `omni logs --follow` uses (`apps/cli/src/commands/usage.ts:115-126`).
`--json` emits the `ConsoleRead` structure and, as elsewhere, short-circuits
follow mode.

`omni logs --service` stays, as a thin alias that calls the same reader. It is
documented in the README and may be in an operator's scripts; the flag is not
worth breaking, and the two verbs now differ only in which one is discoverable.

The CLI reads the file or the journal **directly**, never through `/api/*`.
That is repository constraint 11, and here it is also the point: the question
"why will the gateway not start" is asked when the gateway is not answering
HTTP. A CLI that needed an admin session to read a crash log would be useless at
exactly the moment it is needed.

## Testing

- `readConsole` against a fake `readFile` and `CommandRunner`, covering all
  three sources, the `lines` tail, `since`, and `level` filtering. No test
  touches a real file or spawns a process.
- The parser round-trips against `formatLine`: a line the formatter produced
  parses back to the level, timestamp, and message it was given, with and
  without colour. Foreign and newline-broken lines survive as `raw`.
- The route: admin gate, `lines` clamp, and each `source` shape.
- `apps/gateway/test/routes/proxy.test.ts` inverts. The four assertions on
  `request done` / `request failed` / `request cancelled`
  (`:88-105`, `:119`, `:147-155`, `:675-682`) become assertions that those lines
  are absent *and* that the `request_logs` row was still written with the same
  status and tokens. That pairing is the real contract: the print left, the
  record did not.
- Dashboard: one test per source, each asserting the operator-visible hint text,
  per the convention of asserting on visible text rather than internals.

## What this does not do

- **No log streaming.** Both surfaces poll, matching the existing Logs screen
  and `omni logs --follow`. The control surface has no WebSocket and this does
  not add one.
- **No new storage.** Nothing is written to SQLite, no table is added, and no
  retention sweep is introduced. Log rotation belongs to whatever captures
  stdout — journald, or the operator's own tooling around `OMNI_LOG_FILE`.
- **No in-process buffer.** The view shows what was captured, so it survives a
  restart and can show the crash that caused one. The cost is that an
  uncaptured gateway shows nothing, which the `none` state states plainly.
- **No change to `LogFields`.** The allowlist is the redaction mechanism.
  Making these lines visible in a browser does not loosen what may go into one.

## Known consequences

- A gateway that has never been run under systemd or the CLI supervisor, and
  that has no `OMNI_LOG_FILE`, shows an empty Console screen. This is the
  `bun run dev` case, and it is reported rather than hidden.
- `OMNI_LOG_FILE` is read once at boot, like every other configuration value.
  Changing it takes effect on restart.
- The file grows without bound unless something rotates it. Journald rotates on
  its own; a file set by the CLI supervisor does not.
- Under a unit installed before this change, the journal is read and
  `OMNI_LOG_FILE` is unset, so the hint tells the operator how to switch. No
  reinstall is required to keep working.
