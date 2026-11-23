# Contributing to OmniGateway

Contributing, or running from a checkout? See
[ARCHITECTURE.md](ARCHITECTURE.md) for how the system fits together,
[CLAUDE.md](CLAUDE.md) for the repository map, architectural boundaries, and
conventions, and `docs/superpowers/specs/` for the design documents
behind each feature.

The gateway is Rust (toolchain pinned in `rust-toolchain.toml`); the console is
built with Bun 1.4.4.

```bash
git clone https://github.com/harismawan/omnigateway.git
cd omnigateway
bun install
bun run build:dashboard       # the gateway serves this build
export OMNI_ENCRYPTION_KEY="$(openssl rand -base64 32)"
cargo run -p omni-gateway --bin omnigateway   # gateway on 9000; reads no .env
cargo test --workspace
```

For dashboard development, run `bun run dev:dashboard` in another terminal
(port 5173, API/health proxied to 9000). Bun rebuilds after source changes and
reloads the page; component state resets, with no React Fast Refresh.
`bun run --cwd apps/dashboard preview` serves an existing build on port 4173.
Both commands accept `--host`, `--port` and `--upstream` options.

Releases are published to npm from a `v*` tag, with provenance attesting which
commit produced them.

## Checks

Rust, from repo root (toolchain pinned in `rust-toolchain.toml`):

```bash
cargo build --workspace
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
RUSTDOCFLAGS=-Dwarnings cargo doc --locked --workspace --no-deps
cargo run -p omni-gateway --bin omnigateway          # gateway; config from process env only
cargo run -p omni-gateway --bin omnigateway -- omni --help   # the CLI through the gateway binary
```

Console and scripts, with Bun 1.4.4:

```bash
bun install --frozen-lockfile
bun run test               # scripts/ suite, then console suite (happy-dom)
bun run typecheck          # scripts + console
bun run lint               # biome
bun run fmt
bun run check:claims       # stale-claims; reads git history
bun run check:dead         # dead exports
bun run build:dashboard            # typecheck + production build into apps/dashboard/dist
bun run dev:dashboard              # 5173; rebuild + full reload; proxies /api, /health to 9000
bun run --cwd apps/dashboard test  # console suite alone
```

Before claiming done, run focused changed-behaviour tests and every check in
`.github/workflows/ci.yml` (`rust` and `verify` jobs).