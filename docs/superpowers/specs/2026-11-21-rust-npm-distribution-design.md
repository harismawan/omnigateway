# Rust gateway on npm — design

Status: draft for approval. Supersedes one non-goal of
[the Rust migration design](2026-11-07-rust-gateway-migration-design.md)
(`:109–110`, `:173–174`, `:315–316`): npm stops being "frozen at the last TS
release" and becomes a delivery channel for the Rust binary.

## Intent

People install OmniGateway with `npm i -g omnigateway` today, both to try it on
a laptop (`omni start`) and to run it on a server (`omni service install`). The
Rust port shipped as GitHub release archives and a Docker image only, which
would strand every npm user on the last TS version. The owner wants npm users to
**move to Rust by updating the package they already have**, with no manual
migration, while the gateway itself runs as the native binary. Node/npm only
installs it.

## Goals

1. `npm i -g omnigateway` / `npm update -g omnigateway` installs the Rust
   gateway and CLI for Linux x86_64/aarch64 and macOS x86_64/aarch64. No Bun.
2. The running gateway is the Rust binary itself, never a JS process wrapping it.
3. An existing TS **single-node systemd service** written by `omni service
   install` migrates automatically during the update: stop TS, back up the
   database, rewrite the unit to the Rust binary, start, check health.
4. Later Rust→Rust npm updates restart an active service onto the new binary.
5. Same release, same bytes: npm binaries are the binaries of the GitHub release
   archive for the same tag.
6. Users of features Rust does not serve are told exactly what stopped working.

## Non-goals

- Windows Rust binaries (none exist). Windows stays on TS `0.15.x`.
- Automatic migration of **cluster** (Postgres/Redis) installations.
- Automatic rollback to TS.
- A launchd service on macOS (neither implementation has one).
- Changing gateway/CLI behavior, routes, providers or plugins. Plugins remain
  unsupported; Grok/Kimi/Kilo/Muse/Qoder remain deferred.
- Republishing or changing `@omnigateway/plugin-api` / `@omnigateway/dashboard-sdk`
  (stay separate and frozen).
- A staged/`next` channel or a final TS release (see decisions).

## Anti-goals (failure even if it "works")

- TS and Rust running against the same data at any moment.
- A migration that starts Rust without a backup, or silently swallows a failed
  start.
- Rewriting a unit the operator customised, or a unit this project did not write.
- A root service whose `ExecStart` is a binary a non-root user can replace.
- `ExecStart` pointing at a Node shim.
- npm binaries that differ from the reviewed release archive bytes.

## Decisions taken with the owner

| Decision | Choice |
|---|---|
| Who installs via npm | Both laptop users and server/service users |
| Upgrade path | Same name `omnigateway`, version **`1.0.0`**; `npm update -g` moves users to Rust |
| Promotion | CI publishes `1.0.0` **straight to `latest`** on tag push; pushing the tag is the sign-off |
| Users of unsupported providers/plugins | Still move to Rust; told what no longer runs |
| Running service on update | Migrated **automatically** |
| Rust fails to start/health after migration | **Leave the service stopped**, record it, print the rollback steps; no automatic rollback |
| Windows | Main package excludes `win32`: npm refuses with `EBADPLATFORM`, the TS install stays untouched |
| Rust→Rust updates | **Restart automatically** when the active service runs a replaced binary; health-checked, same failure rule |

## npm facts the design relies on

- `npm update -g` ignores semver ranges: a global package's wanted version is the
  `latest` dist-tag (npm docs, *Updating Globally-Installed Packages*). So `1.0.0`
  on `latest` reaches every `0.x` user who updates.
- npm (7+) runs lifecycle scripts after the new package is extracted, so the old
  TS files (`…/node_modules/omnigateway/gateway.js`) are already gone when
  `postinstall` runs. A running TS gateway keeps running from memory, but its
  unit can no longer restart it.
- npm hides lifecycle-script output for a successful script unless
  `--foreground-scripts`. Output alone cannot be relied on to reach the user.
- A failing `postinstall` fails the install. That is why the hook always exits 0.
- **npm 12 blocks install scripts by default, for global installs too.** It
  was measured on npm 12.0.2: `npm i -g` of a package with a `postinstall`
  prints `install scripts blocked … not covered by allowScripts`, and the script
  runs only with `--allow-scripts=<name>` or the matching config. So
  `postinstall` cannot be the only migration trigger; see the bridge below.

## The `gateway.js` bridge *(owner decision)*

`omnigateway@1.x` ships a file at the old path `gateway.js`, so a 0.x unit's
`ExecStart=<bun> …/node_modules/omnigateway/gateway.js` still finds something
the next time systemd starts it (restart, reboot, crash restart). That file is a
dependency-free script, runnable by Bun or Node. It runs
`<platform binary> omni service migrate --bridge` with inherited stdio, env and
cwd, forwards signals, and exits with that process's code.

In bridge mode the migration runs **as** the service, not against it:

- TS is not running (the bridge took its place), so there is no stop step.
- The writer check still applies: nothing may hold the database open.
- After the backup, and **before** the unit is touched, the migrator durably
  records `verifying` with a `handoff` object: scope, unit, root, the database
  path it backed up, the probe address, the backup id and the saved unit
  (written, fsynced, renamed, directory fsynced). If that record cannot be
  written it records `failed-record` where it can, leaves the unit unchanged
  and the service stopped, and exits 0. Only then does the rewrite add one line
  after `ExecStart=`: `ExecStartPost=<binary> omni service migrate
  --verify-start`. It reloads, releases the lock, and its **last** act is
  `systemctl restart --no-block omnigateway.service`; it exits 0. systemd stops
  the bridge and starts the binary as a plain `MainPID`; the bridge never
  spawns, relays signals to, or waits on the gateway. *(owner decision, fourth
  rereview: a child gateway could not tell a slow boot from a drain)*
- The verifier runs on every start while the line is there (`MAINPID` set by
  systemd). It judges against the **recorded** handoff, never the current
  `.env`: `/health` at the recorded address, listener attribution to
  `MAINPID`, the backed-up database held, no other holder. Success records
  `migrated` and only once that is on disk removes its own line and reloads.
  Failure records `failed-start` with the handoff's rollback first, and its
  last act is queueing `systemctl stop --no-block` (a non-zero exit alone lets
  `Restart=on-failure` start Rust again — measured on systemd 257; with the
  queued stop the unit ends failed and inactive); it exits 1 and the line
  stays, so a restart that the stop did not prevent is judged again, never
  trusted. A queued stop is not reported as a confirmed stop: the message
  says to check `systemctl status` first. No record file, or a record with no
  armed handoff, is a stale hook: exit 0. An armed handoff it cannot read (bad
  JSON, missing fields, no `MAINPID`) fails closed: stop, exit 1.
- An unverified handoff (`verifying`, e.g. a verifier that was killed) is an
  unresolved state like a failure: `omni doctor`/`status` announce it, its
  rollback is carried as `pendingFailure`, later runs keep the handoff, and
  only a serving verdict against the recorded database (by the verifier or by
  `omni service migrate` seeing the service serve it) clears it.
- Every bridge refusal exits **0**, so `Restart=on-failure` does not loop
  and the service is left stopped with the record written.
- Started outside systemd (no legacy unit found), the bridge prints that
  `gateway.js` is a migration bridge, points at `omni start`, and exits 1.

So the migration is automatic either at install time (scripts allowed) or at
the service's next start (scripts blocked). Until then the TS process keeps
serving from memory, and the CLI banner says a migration is pending.

## Packages

- `omnigateway@1.0.0`, the main package: `bin/omni` and `bin/omnigateway`
  (Node launcher, no dependencies), `postinstall.js`, the `gateway.js` bridge,
  README, LICENSE.
  `optionalDependencies` lists the four platform packages at the exact version.
  `os: ["linux","darwin"]` and `cpu: ["x64","arm64"]`, so Windows and other
  hosts get `EBADPLATFORM` and keep what they have. `engines.node >= 18`.
- `@omnigateway/linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`:
  exactly the release archive payload (`omnigateway`, `public/`, LICENSE), with
  `os`/`cpu` set so npm installs only the matching one. Linux carries the musl
  static binaries from the existing `rust-binaries` matrix.
- The version is the tag (`releaseVersion`, as today). The first tag after this
  lands is `v1.0.0`.

## Launch path

- The launcher resolves `@omnigateway/<platform>-<arch>/package.json` with
  `require.resolve` from its own package, then `spawnSync` runs the binary with
  `stdio: 'inherit'`, forwards SIGINT/SIGTERM/SIGHUP, and exits with the child's
  code or signal. `bin/omni` passes a leading `omni` argument, so the binary's
  existing dispatch (`crates/omni-gateway/src/main.rs:22–31`) runs the CLI.
  Missing platform package: one line naming the platform, the supported list,
  and the reinstall command.
- `postinstall` replaces `bin/omni` and `bin/omnigateway` inside the main
  package with **symlinks** to the platform binary. The global bin links already
  point at those files, so normal use has no Node in the path (esbuild's
  pattern). With `--ignore-scripts` the JS launcher stays and still works.
  *(controller call)*
- `omni` reaches the binary through a symlink named `omni`, which matches the
  argv[0] dispatch. `gateway_at` (`crates/omni-cli/src/service.rs:50–59`)
  canonicalises to the platform package's `omnigateway`, so `omni service
  install` writes `ExecStart=<platform pkg>/omnigateway`.
- **One product change:** `default_static_dir`
  (`crates/omni-gateway/src/lib.rs:114–135`) must canonicalise `current_exe()`
  before looking for `<exe dir>/public`. Linux already returns the resolved
  path; macOS returns the invoked path, which through the npm symlink is
  `<prefix>/bin`, so the dashboard would not be found. *(controller call)*

## `omni service migrate`

A new CLI subcommand that does the migration. `postinstall` runs it as
`<binary> omni service migrate --from-npm` for global installs
(`npm_config_global=true`), the bridge runs it with `--bridge`, and operators
can run it by hand. Without units it records `nothing-to-migrate` (macOS always).
It is transitional, so `omni --help` does not list it (keeping the frozen help
surface unchanged); `omni service migrate --help` and the docs describe it.

### Which units it may change *(controller call)*

It looks only at the two paths the TS CLI ever wrote:
`~/.config/systemd/user/omnigateway.service` (user scope) and
`/etc/systemd/system/omnigateway.service` (system scope). Every TS release from
`v0.9.0` to `v0.15.5` wrote the same template (`apps/cli/src/service.ts:112–134`).

A unit is **legacy TS** only when all of these hold:

- exactly one `ExecStart=` line, of the form
  `ExecStart=<abs bun> <abs path>/node_modules/omnigateway/gateway.js`, and no
  other line names that package directory;
- `WorkingDirectory=<root>` and `EnvironmentFile=<root>/.env`, so the CLI and the
  service read the same configuration;
- systemd reports no drop-ins (`DropInPaths` is empty);
- only one of the two scopes has a unit.

The migration **replaces only the `ExecStart=` line** and keeps every other line
byte for byte, so operator additions such as `StandardOutput=append:` survive
(the owner's own unit has them).

A unit is **npm Rust** when its single `ExecStart=` is this install's platform
binary.

Anything else is left alone, and the user is told the manual steps: drop-ins,
both scopes present, an unrecognised `ExecStart`, or a Rust unit pointing
outside this install (`foreign-unit`, informational only). System scope additionally needs euid 0, and the platform binary
and every parent directory must be root-owned and not group- or
other-writable. Otherwise the tool prints the exact
`sudo <abs binary> omni service migrate` command and changes nothing.

### Legacy TS → Rust

1. **The unit as systemd loaded it.** `systemctl show` must report
   `FragmentPath` = the file, `NeedDaemonReload=no`, no `DropInPaths`, no
   `Environment`, `EnvironmentFiles` = exactly `<root>/.env (ignore_errors=no)`,
   and an `ExecStart` argv equal to the file's. The file itself must be the
   template line for line: every line a section header or `Key=Value` with
   nothing around `=`, only template keys plus `StandardOutput`/`StandardError`,
   the interpreter an absolute `…/bun`. Anything else is `skipped-unit`. *(review
   finding 1–2)*
2. **Mode** from that `.env` (unreadable → refuse): any of `OMNI_DATABASE_URL`,
   `OMNI_REDIS_URL`, `OMNI_CLUSTER_MODE` → `skipped-cluster`. The whole file must
   be in the grammar systemd and the CLI read alike — ASCII only, empty lines,
   `#`/`;` comments at column 0, `NAME=VALUE` with no `export` (systemd discards
   `export NAME` as an invalid name; the CLI strips the word), no whitespace
   around `=` or at either end, and a plain value or one single-line quoted
   value with no `\`, `$`, backtick or nested quote — else `skipped-unit`.
   `OMNI_*` in either manager's environment (`show-environment`: user exports
   or the system manager's `DefaultEnvironment`) is refused; `OMNI_HOST` must be
   an IP or `localhost`, and that one address is used for occupancy, `/health`
   and listener attribution. `localhost` resolves as the gateway's bind does:
   the resolver's first address (`::1` on an IPv6-first host). A wildcard bind
   is probed on its family's loopback. **Conservative attribution:** for an
   IPv4 probe, a listener on `[::]:port` also counts as serving it, because
   `/proc/net/tcp6` does not say whether that socket is `IPV6_V6ONLY`. If such
   a socket belongs to another process, attribution fails and the migrated
   service is stopped with rollback even when it was serving — a refusal, never
   a false success. Free the port or bind the other server elsewhere.
3. **Preflight, nothing touched yet:** no process other than `MainPID` visible
   holding the database; the snapshot directory exists, is writable, has 1.1× the
   database free; the ledger is readable and has no unknown id; the binary runs
   `omni --version`.
4. **Stop TS** and confirm through systemd (`inactive`/`failed`, `MainPID=0`).
5. **Exclusivity, as far as SQLite can show it:** with systemd confirming the
   stop, nothing may answer on the port; then `PRAGMA locking_mode=EXCLUSIVE;
   BEGIN EXCLUSIVE` with no busy wait. It fails while another connection holds
   a shared lock (any that has read and not finished, whatever user or link) and
   keeps every new reader out while held. It cannot see a process that opened
   the file and never read it; after the start (step 8) only holders visible
   in `/proc` are checked, so that case stays within the accepted limitation.
   Held through steps 6–7. *(review finding 3)*
6. **Back up** through the locked connection (`VACUUM INTO`) into
   `<db dir>/snapshots/db_<stamp>_preRust.sqlite`; save the old unit under
   `<state>/pre-rust/`.
7. **Rewrite `ExecStart=`** only (temp file + rename), `daemon-reload`, then
   release the lock.
8. **Start** (only if it was active) and accept it only when `/health` answers,
   the listening socket serving the probed address belongs to systemd's
   `MainPID`, that process runs this binary and holds the backed-up database,
   and no other visible process holds it. *(finding 3, 5)*
   **Accepted limitation (owner, 2026-11-21):** not an exclusive handoff — a
   second TS gateway on the same file starting between unlock and Rust's open
   is detected only when `/proc` shows it, and only after both ran. Auto
   migration assumes no other gateway uses the database.
9. **Failure after step 4 leaves the service stopped** (npm already removed the
   TS files, so TS cannot be restarted): stop again and confirm (when it cannot
   be confirmed, say so and give the stop command first), record `failed-*` —
   kept, with its backup and saved unit, until a later run sees the service
   running this binary — and print branch-specific rollback — no restore step when nothing
   was written, `omni db restore --root <root> <id>` and copying the saved unit
   back when it was. *(finding 4)*
10. **Idempotent.** A unit already migrated takes the Rust→Rust path.

### Rust → Rust (later npm updates)

For an **npm Rust** unit that is active, restart only on positive evidence:
`/proc/<MainPID>/exe` reads ` (deleted)` or names another file. Unreadable is
not evidence (`current`). Success requires the same health + identity check;
`runningVersion` in the record is the last version that ran healthy and is the
rollback target, or the message says it is not recorded. With install scripts
blocked nothing runs at update time; `omni service migrate` does the restart.
*(finding 7)*

### The bridge's own rules

The migrator runs as the bridge only when systemd's `MainPID` is one of its
ancestors (it was started by the unit, not by hand). It skips the stop, holds
the same lock, and after the rewrite hands the start to systemd as above. The
`verifying` record is durable before the verifier is armed, and the restart
request is the bridge's last act, since it may end the bridge at once. A unit
still carrying the verifier
line (the verifier never ran) is still classified as ours. Every refusal, and
every launcher failure in `gateway.js` (missing or non-executable platform
binary), exits **0**, so `Restart=on-failure` does not loop. *(finding 6)*

### Not a service

A TS gateway started with `omni start` (a live pidfile, and no unit) is never
touched. The tool records `skipped-foreground` and tells the user to stop it and
run `omni start` again. With no unit and no pidfile, it records `nothing-to-migrate` and prints
the one-paragraph what-changed note.

### Making the outcome visible *(controller call)*

Because npm hides script output, the outcome is written to
`<state dir>/npm-migration.json`, the CLI state dir from `service.rs:38–48`,
holding the status, timestamps, backup id, versions and message. `omni doctor`
and `omni status` print a one-line stderr banner while the status is
`failed-*` or `skipped-*`, or a legacy unit is still installed. Every other
command's output stays byte-identical to the frozen CLI *(owner decision, after
the keys-list conformance driver caught the banner on `keys list`)*. A later successful `omni service migrate` clears
the banner. The README and release notes tell server operators to update with
`--foreground-scripts`, so the report also shows live. When scripts never ran,
those two commands print the same banner for a legacy TS unit, recommending
`omni service migrate`.

`postinstall` always exits 0. A non-zero exit would make npm fail the install
while TS may already be stopped.

## Release workflow

The `publish` job in `release.yml` changes from bundling TS with `build:npm` to:

1. Depend on `rust-binaries` (already the case) and download the four target
   archives.
2. A rewritten `scripts/build-npm.ts` (no gateway bundling) unpacks each archive
   into its platform package, writes `package.json` with exact `os`/`cpu`,
   checks that the SHA-256 of the binary equals the archive's, and runs
   `--version` where the runner can execute it. It then assembles the main
   package with `optionalDependencies` at the exact version.
3. Publish order (irreversible, so risk first, as today): the SDK step
   unchanged, then the four platform packages, then the main package last, on
   `latest`. A failure before the main package leaves `latest` on the previous
   version.
4. The existing test, typecheck and lint gates before publishing stay. The Rust
   workspace gate already runs in CI.

One-time owner action: create the four `@omnigateway/*` names with a token
(`0.0.1`, `--tag bootstrap`) and configure trusted publishing for each, as was
done for the SDKs.

## Notices *(controller call)*

No final TS release. `0.15.5` is the rollback and Windows version (a build
constant in the launcher and migrator). The draft
`docs/rust-npm-final-notice.md` becomes the 1.0.0 README section "Upgrading from
0.x", which covers what migrates, what stops working, cluster steps, rollback
and Windows. The cutover runbook gets an npm section.

## Testing

- Launcher: platform mapping, missing package, `omni` argument dispatch,
  signal and exit forwarding.
- `service migrate`, with injected `systemctl` and a temp root, never real
  systemd:
  - legacy template detection, plus refusal for customised units, drop-ins and
    both scopes
  - cluster `.env` → no stop and no rewrite
  - foreign writer → skipped
  - happy path: TS stop observed before any Rust database open; backup exists,
    opens, and has a TS-restorable id; unit equals `render_unit`; start only if
    it was active; health called; record written
  - backup failure and start failure → stopped, recorded, rollback text
  - idempotent rerun
  - Rust→Rust restart on a replaced binary, and no restart on an unchanged one
  - system-scope ownership refusal
- `default_static_dir` resolves `public/` through a symlinked invocation.
- End to end in a private environment:
  - `npm pack` all five packages, then install globally into a temp prefix with
    a fake `systemctl` on PATH, a TS-written unit, and a database created by the
    frozen TS oracle
  - assert the outcome above, that the bin links are symlinks to the binary, and
    that `omni --version` works
  - `--ignore-scripts` variant: the launcher works, and the first-run banner
    appears
  - a Windows platform-mismatch check via `npm install --os=win32 --dry-run`
- Release dry run: build all five packages from archives, run
  `npm publish --dry-run`, compare hashes.

## Left to the builder

Exact package directory layout, launcher code structure, message wording (keep
it short), record field names, and test fixture shapes.
