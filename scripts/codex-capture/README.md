# Codex capture harness

The OpenAI OAuth leg presents itself as the latest Codex release, field by field
(`docs/superpowers/specs/2026-10-16-codex-0163-fingerprint-design.md`). Source
tells you what Codex *can* send; only a capture tells you what it *does* send
for a given model and entry point. This directory runs the real client against a
local server that records every request byte for byte, with a synthetic login.

Current measured release: **0.165.0** (2026-10-28), fixture
`packages/providers/test/fixtures/codex-0.165.0.json`. See the design's "Current
fingerprint" section for additions and deliberate gaps.

Nothing here talks to OpenAI. The login is unsigned and fake, the server answers
locally, and the captures never leave the machine.

| File | What it does |
|---|---|
| `capture.ts` | Raw-socket (optionally TLS) server: writes `NNN.head.txt` (headers in wire order and casing) and `NNN.body.bin` (body as sent) per request, answers `/accounts/check` and `/responses` |
| `mkauth.ts` | Writes a synthetic ChatGPT `auth.json` and a `config.toml` pointing Codex at the server, into a throwaway `CODEX_HOME` |
| `tui.py` | Runs the interactive TUI under a pseudo-terminal for a fixed time |
| `show.ts` | Prints one capture: headers (auth redacted) and a body summary, zstd decoded |

## Procedure for a new Codex release

Work in a scratch directory outside the repository; `$W` below. Captures carry a
local installation id, thread ids and local paths, so **raw captures are never
committed**.

1. **Install the release** without touching the global one:

   ```bash
   mkdir -p $W/pkg && cd $W/pkg && npm install @openai/codex@<version>
   CODEX_BIN=$(find $W/pkg/node_modules/@openai -path '*bin/codex' -type f | head -1)
   $CODEX_BIN --version
   ```

2. **Make a throwaway CA and server certificate.** Codex refuses a non-HTTPS
   workspace backend origin, and trusts an extra CA through
   `CODEX_CA_CERTIFICATE`. Delete the directory afterwards.

   ```bash
   mkdir -p $W/tls && cd $W/tls
   openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=capture-ca \
     -keyout ca.key -out ca.pem
   openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout srv.key -out srv.csr
   printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > san.ext
   openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
     -extfile san.ext -out srv.pem
   ```

3. **Start the server and write the login:**

   ```bash
   CAPTURE_TLS=$W/tls bun scripts/codex-capture/capture.ts 18765 $W/cap &
   bun scripts/codex-capture/mkauth.ts $W/home 18765
   mkdir -p $W/work
   ```

4. **Capture the interactive TUI** — the identity the profile claims:

   ```bash
   CODEX_BIN=$CODEX_BIN CODEX_HOME=$W/home CODEX_CA_CERTIFICATE=$W/tls/ca.pem \
     CODEX_WORKDIR=$W/work python3 -I scripts/codex-capture/tui.py 40 gpt-6-astra "say hi"
   ```

   For a history replay, restart the server with `CAPTURE_TOOL=1` into a fresh
   directory and run `codex exec` with the same environment:
   `$CODEX_BIN exec -m gpt-6-astra "wait a moment then say hi"`. The first
   answer is a reasoning item, a message and a `clock.sleep` call; the second
   `POST …/responses` is the follow-up carrying them.

5. **Read the captures.** `cat $W/cap/index.txt` lists every request; the
   `POST /backend-api/codex/responses` entries are the ones that matter (the
   TUI also sends a short title-generation request before the turn).

   ```bash
   bun scripts/codex-capture/show.ts 083 $W/cap
   ```

6. **Compare against the gateway** and update, in one change:
   - `packages/providers/src/openai/profile.ts` — version, originator, UA
     shape, header order, body order;
   - `packages/providers/src/openai/codexCatalog.ts` — per-model values from
     `codex-rs/models-manager/models.json` at the release tag, with the release
     noted in `CODEX_CATALOG_RELEASE`;
   - `packages/providers/src/openai/codexLite.ts` — input item shapes, turn
     metadata keys, `client_metadata` members;
   - `packages/providers/test/fixtures/codex-<version>.json` — a new
     hand-sanitized fixture: ids, timestamps and the installation id replaced
     with placeholders, Codex's own prompt items and tool inventory removed, no
     paths. Point `openaiCodexFingerprint.test.ts` at it;
   - the two specs' "current" tables (client-identity and the fingerprint spec).

   The version and the shape move together or not at all: a release that
   changes the shape and a profile that only bumps the number is the
   half-fingerprint the design rules out.

7. **Clean up:** stop the server, delete `$W` (CA key included).

## What a capture cannot tell you

A capture shows what Codex sends, not what the backend accepts from someone
else. Whether a shape change is safe to send is a live question, answered by a
probe against a real account — not by this harness, and never from a test.
