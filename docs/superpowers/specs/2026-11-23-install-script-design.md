# Install script and release asset names

## Intent

Someone who wants to run OmniGateway SSHes into a server, pastes one line, and
ends with a running gateway they can open from the browser on their laptop. Today
that takes `npm i -g`, a hand-written `.env`, three `omni` commands and a
systemd step, all copied from the README. Node is the only reason npm is needed,
and a server often has none.

Release archives are named after Rust target triples
(`omnigateway-v1.0.0-x86_64-unknown-linux-musl.tar.gz`), which read as noise to
the person downloading them. They change to the names the npm platform
packages already use.

## Goals

- One command: `curl -fsSL <url>/install.sh | sh`, picks OS and CPU itself.
- Two methods: release binary (default, no Node) or npm (`--method npm`).
- Carries on through setup until the gateway answers `/health`: `.env` with an
  encryption key, database, admin password prompt, service, start.
- Ends by printing the dashboard URL(s) reachable from another machine and a
  few next commands.
- Re-running on an installed machine is a safe upgrade.
- Release assets renamed to `omnigateway-<tag>-<os>-<cpu>.tar.gz`.

## Non-goals

- Windows. No build exists; the script says so and exits.
- TLS, reverse proxy, domain or firewall configuration.
- Connecting provider accounts, creating models or keys; the script prints the
  commands for those.
- Old asset names. No fallback: the script supports releases published with
  the new names only.

## Anti-goals

- Never overwrite or edit an existing `.env`. Changing `OMNI_ENCRYPTION_KEY`
  makes every stored credential unreadable.
- Never re-ask or reset an admin password that already exists.
- Never install an archive whose checksum does not match `SHA256SUMS`.
- Never re-implement what `omni` already does (migrate, password policy,
  unit file); the script calls the CLI.

## Users

People installing the gateway on a server, at a terminal, then opening the
console from a different machine. Plain HTTP access must keep working
(decided): the session cookie only becomes `Secure` when `OMNI_BASE_URL` is
https or a proxy says so (`session_cookie`, `crates/omni-gateway/src/api.rs`),
and OAuth connect flows use fixed callback URLs pasted back by hand
(`crates/omni-gateway/src/connect.rs`), so neither depends on the origin.

## Part 1: asset rename (decided)

| Old target triple | New archive suffix |
| --- | --- |
| `x86_64-unknown-linux-musl` | `linux-x64` |
| `aarch64-unknown-linux-musl` | `linux-arm64` |
| `x86_64-apple-darwin` | `darwin-x64` |
| `aarch64-apple-darwin` | `darwin-arm64` |

File name: `omnigateway-${GITHUB_REF_NAME}-<os>-<cpu>.tar.gz`. Archive contents
unchanged. Builds themselves still use the Rust triple (cargo `--target`,
artifact names may keep it); only the published file name changes.

Places that name the archive and must move together:

- `.github/workflows/release.yml`: the matrix gains an `asset` field
  (`linux-x64` …) used by "Package binary and dashboard"; the `image` job's
  extract loop (`amd64 → linux-x64`, `arm64 → linux-arm64`).
- `scripts/build-npm.ts`: `PLATFORMS` drops `target` for the asset suffix (its
  `npm` name already ends in it); `buildPackages` and `verifyPacked` read the
  new names. `scripts/test/build-npm.test.ts` follows.
- Docs naming archives (`README.md`, `docs/rust-packaging.md` if they name a
  file).

## Part 2: `install.sh`

Location: `install.sh` at the repository root. Served two ways (decided):

- `https://raw.githubusercontent.com/harismawan/omnigateway/main/install.sh`
  — always the newest script, installs the latest release by default.
- attached to each GitHub release by `rust-assets`, and listed in
  `SHA256SUMS`. A release's copy defaults to that release's tag: the workflow
  substitutes the tag into a `DEFAULT_VERSION` line when attaching it (the
  committed file says `latest`).

POSIX `sh` (dash, busybox ash, macOS sh). Needs `curl` or `wget`, `tar`,
`sha256sum` or `shasum -a 256`; `openssl` or `/dev/urandom` for the key.
Prompts read `/dev/tty`, since stdin is the script itself under `curl | sh`.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--version <tag>` | `latest` (or the release's own tag) | release to install |
| `--method binary\|npm` | `binary` | how to install |
| `--root <dir>` | `~/.config/omnigateway` | installation root (`.env`, database) |
| `--port <n>` | `9000` | written to a new `.env` only |
| `--base-url <url>` | asked, with a detected default | `OMNI_BASE_URL` for a new `.env` only |
| `--no-service` | off | install and set up, do not install a service or start |
| `--yes` | off | no prompts; fail instead of asking |

Environment: `OMNI_ADMIN_PASSWORD` supplies the password without a prompt.
With `--yes`, no TTY, no password in the environment and no password yet, the
script fails with a message naming `OMNI_ADMIN_PASSWORD`.

### Steps

0. **Find an existing installation** (decided: follow what is there). In
   order: a systemd unit (`~/.config/systemd/user/omnigateway.service`, or
   `/etc/systemd/system/omnigateway.service` as root) gives the root from its
   `WorkingDirectory=`; else `omni`/`omnigateway` on `PATH` gives the method
   (resolved path inside an npm prefix → npm, inside the script's install
   dir → binary) and `omni doctor --json` gives the root it resolves; else
   none. An explicit `--root` or `--method` wins over what is found. When one
   is found the run is an **upgrade** (below), on that root and that method,
   and the script says which root and method it picked before acting.
1. **Detect.** `uname -s` → `linux`/`darwin`; `uname -m` → `x64`
   (`x86_64`, `amd64`) or `arm64` (`aarch64`, `arm64`). Anything else: exit
   with the supported list. On macOS under Rosetta (`sysctl.proc_translated`
   = 1) choose `arm64`.
2. **Install, binary method.** Resolve `latest` through the GitHub releases
   redirect (no API token). Download the archive and `SHA256SUMS` to a temp
   dir, verify, extract into `~/.local/share/omnigateway/<version>/`
   (binary, `omni` link, `public/`, `LICENSE`), then point
   `~/.local/share/omnigateway/current` at it and link `omni` and
   `omnigateway` into `~/.local/bin` through `current`. Running as root uses
   `/opt/omnigateway/<version>` and `/usr/local/bin`. If the bin directory is
   not on `PATH`, say which line to add; the rest of the script uses absolute
   paths.
3. **Install, npm method.** Requires `npm` and Node ≥ 18, else exit naming the
   binary method. `npm i -g omnigateway[@version] --allow-scripts=omnigateway`;
   the binary is found through `command -v omni`.
4. **`.env`.** In the root (created `0700`). Only if no `.env` exists, write it
   (`0600`):
   ```
   OMNI_ENCRYPTION_KEY=<openssl rand -base64 32>
   OMNI_HOST=0.0.0.0
   OMNI_PORT=<port>
   OMNI_BASE_URL=<base url>
   ```
   and print, once, that the key must be kept. An existing `.env` is read for
   `OMNI_PORT`/`OMNI_HOST`/`OMNI_BASE_URL` (for the final URLs) and never
   written.

   `OMNI_BASE_URL` (decided: ask, with a detected default): without it the
   gateway derives `http://0.0.0.0:<port>` (`crates/omni-control/src/config.rs`),
   which `omni setup *` and the console's agent setup write into client
   configs, useless from another machine. Candidates: non-loopback IPv4
   addresses of the machine, plus the public address when one can be learned
   (a single best-effort HTTPS lookup with a short timeout; failure just drops
   the candidate). Default = the public address if found, else the first
   private one. The prompt reads "Address your laptop uses to reach this
   server" and accepts a bare host/IP (becomes `http://<host>:<port>`) or a
   full URL. `--base-url` answers it; with `--yes` and no flag the default is
   taken.
5. **Database.** `omni db migrate --root <root>`.
6. **Admin password.** Ask only when none is set: `omni status --json
   --root <root>` reports `adminConfigured` (`crates/omni-cli/src/status.rs`).
   Pass
   `OMNI_ADMIN_PASSWORD` through stdin to `omni admin set-password` (it reads
   stdin when not a terminal); otherwise let it prompt on `/dev/tty`. Policy
   (≥ 12 characters, typed twice) stays in the CLI.
7. **Service.** Skipped with `--no-service`.
   - systemd, non-root: `omni service install --enable --force`, then
     `loginctl enable-linger "$USER"` so it survives logout and reboot;
     if linger fails, warn that the gateway stops at logout.
   - systemd, root (decided: the gateway runs as root; no dedicated user):
     `omni service install --system --enable --force`. The unit stays as the
     CLI renders it (no `User=`).
   - no systemd (macOS, containers): `omni start` (pidfile supervisor) and say
     it will not come back after a reboot.
   - Then start: fresh install `omni start` (plus `--system` as root). On
     upgrade: user unit or pidfile → `omni restart`; system unit →
     `systemctl restart omnigateway.service` directly, because `omni stop` and
     `restart` reject `--system` (pinned by `frozen_flags` in
     `crates/omni-cli/src/service.rs`; the CLI is not changed).
   - Health is judged by the script polling
     `http://127.0.0.1:<port>/health` (about 15 s), not by `omni start`'s exit
     code: `omni start` probes `OMNI_BASE_URL`, and a cloud server often
     cannot reach its own public address. So `omni start`'s "never answered"
     exit is tolerated; only the script's own loopback poll decides. A failure
     prints the last lines of `omni console` and exits non-zero.
8. **Finish.** Print:
   - the dashboard at `OMNI_BASE_URL`, then the other candidate addresses
     (`http://<ip>:<port>`), plus a note that plain HTTP is unencrypted and
     the port must be open in the firewall / security group. When `OMNI_HOST`
     is not `0.0.0.0` (an older `.env`), the local URL and a line saying how
     to listen publicly.
   - next commands: `omni connect anthropic`, `omni models catalog`,
     `omni models put fast --from-catalog …`, `omni keys create --label laptop`,
     a `curl` example, `omni status`.

### Upgrade (re-run on an installed machine)

Same command, on the root and method step 0 found. Binary: install the new
version beside the old one and move `current`. npm: `npm i -g
omnigateway[@version]`. Then migrate, skip `.env` (and so `--port` /
`--base-url`, which are ignored with a note), skip the password if
`adminConfigured`, re-run `omni service install --force` with the scope of
the existing unit — required, because the CLI writes the **canonicalized**
binary path into `ExecStart` (`gateway_at`, `service.rs`), so the old unit
names the old version directory — restart (step 7), check `/health`. Older
version directories are kept; the script prints the path of the previous one
for rollback.

## Testing

- `scripts/test/build-npm.test.ts` on the new names.
- `install.sh`: `shellcheck` (added to the `verify` job) and a bun test in
  `scripts/test/` (so it runs in `verify` with `bun run test`) that runs it
  against a local fake release (a temp dir served over HTTP holding a fake
  archive and `SHA256SUMS`; base URL and `uname` overridable by env vars for
  tests only), `--no-service --yes` with `OMNI_ADMIN_PASSWORD`.
- The archive holds a **stub** `omnigateway` (my call): a shell script that
  answers `omni status --json` with a chosen `adminConfigured` and records
  every invocation and its stdin. The `verify` job has no Rust build, and
  what `migrate` / `set-password` do is already pinned by Rust tests; this
  test pins what the script asks of the CLI.
- Assertions: binary and `current` links, `.env` mode and contents
  (`OMNI_BASE_URL` from `--base-url` and from a bare host), an untouched
  pre-existing `.env`, the CLI called with `migrate` then `set-password` with
  the password on stdin, no `set-password` when `adminConfigured` is true,
  upgrade reusing the root found, a checksum mismatch refusing, and an
  unsupported `uname -m` refusing.
- No test touches GitHub, npm or systemd.

## Left to the builder

- Exact output wording and colour (none when stdout is not a TTY).
- The release-download base-URL override variable name for tests.
- How the release workflow stamps `DEFAULT_VERSION` (sed is fine).
