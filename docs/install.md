# Installing OmniGateway

Ways to get the gateway onto a machine, and the first-run setup by hand. Once
it is up, the [README](../README.md) walks the first connect, model and key.

## Requirements

- Linux (x86_64 or aarch64) or macOS (Intel or Apple silicon). The gateway is
  a native binary; npm (Node 18 or later) only installs it. There is no Windows
  build (npm refuses the install there).
- A directory that persists, for the SQLite database.
- At least one Anthropic, OpenAI, or Antigravity account to connect, or a custom
  OpenAI-compatible endpoint.

## The install script

On a Linux or macOS machine, one command installs the release binary (no Node
needed), writes a new `.env`, migrates the database, sets an admin password,
installs a service and waits for `/health`:

```bash
curl -fsSL https://raw.githubusercontent.com/harismawan/omnigateway/main/install.sh | sh
```

Main flags: `--version <tag>`, `--method binary|npm`, `--root <dir>`,
`--port <n>`, `--base-url <url>`, `--no-service`, `--yes` (no prompts; supply
the password via `OMNI_ADMIN_PASSWORD`). Re-running the same command is a safe
upgrade: it follows the existing installation's root and method, never
rewrites `.env` and never resets an existing admin password.

## npm (alternative)

```bash
npm i -g omnigateway
```

One package carries the `omni` CLI, the gateway server, and the admin console
the server hosts. npm picks the matching native build
(`@omnigateway/<os>-<cpu>`); the same binaries are attached to each
[GitHub release](https://github.com/harismawan/omnigateway/releases).

npm 12 blocks install scripts by default. Allowing this package's lets it
replace the `omni` and `omnigateway` launchers with symlinks to the binary:

```bash
npm i -g omnigateway --allow-scripts=omnigateway
# or once: npm config set allow-scripts=omnigateway --location=user
```

Without it everything still works, through a small Node launcher. The
postinstall only creates those links; it never touches a service or a
database.

## Release archives

Each GitHub release attaches `omnigateway-<tag>-<os>-<cpu>.tar.gz` archives
(`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`). Verify them against
the release's `SHA256SUMS`. Archive contents and the allocator launch policy
are in [rust-packaging.md](rust-packaging.md).

## Upgrading an existing installation

The install script above upgrades an installation it finds. By hand, an
upgrade is a fresh install of the binary; nothing is converted for you.
The gateway reads an existing SQLite database as it is (same schema), so to
keep your data point it at the old installation and replace the service
yourself:

```bash
omni stop                                  # or: systemctl --user stop omnigateway
npm i -g omnigateway
omni db backup --root <old root>           # optional: a snapshot first
omni service install --force --root <old root>
systemctl --user restart omnigateway
```

Use the same `.env` and `OMNI_ENCRYPTION_KEY`, or the stored accounts cannot be
decrypted. Plugins (their data stays) are not loaded by 1.x; `omni doctor`
lists what it found. Cluster
installations: after a Postgres restore or replacement, follow
[the bucket sweep procedure](rust-cluster-bucket-sweep.md).

## Manual setup

Pick a directory to hold the database and configuration. `~/.config/omnigateway`
is where `omni` looks by default:

```bash
mkdir -p ~/.config/omnigateway && cd ~/.config/omnigateway
printf 'OMNI_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" > .env
```

That key encrypts your provider credentials at rest. **Keep it. Changing it
makes every stored credential unreadable**, and there is no recovery path
except reconnecting the accounts.

Then set up and start:

```bash
omni db migrate            # create the database
omni admin set-password    # prompts; the console signs in with this
omni start                 # serves the API and the console on 127.0.0.1:9000
```

Connect an account. The CLI prints a URL to open, and waits:

```bash
omni connect anthropic     # or: openai, antigravity, kimi, kilo, grok, muse, qoder
```

Every provider also takes a plain API key, if that is what you hold rather than
a subscription:

```bash
omni credentials add-key anthropic     # prompts for the key, or reads stdin
```

There is a ninth provider, `custom`, which points an existing wire codec at an
origin you supply — an endpoint you host or pay for that is not one of the eight.
It has no subscription to authorize, so there is no `omni connect custom`; it is
an API key plus the endpoint to spend it against:

```bash
omni credentials add-key custom \
  --endpoint-id my-endpoint --endpoint-label 'My endpoint' \
  --origin https://api.example.com --protocol chat-completions
```

`--protocol` is `chat-completions` or `responses`, naming which codec to reuse.
`--origin` is a bare origin — scheme and host, no path, query, or credentials in
the URL.

The console offers the same choice per provider on the Connect dialog.

Next: define a virtual model and mint a key — the
[README quick start](../README.md#quick-start).