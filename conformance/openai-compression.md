# Step 4 compression prerequisite (2026-11-14)

## Implemented (2026-11-15)

The HTTP client compresses nonempty encoded bodies with a level-3 streaming
encoder, one `write_all` then `finish`, with no size threshold (frozen
`http-client.ts:160–207`). The source string stays uncompressed. The compressed
allocation is reused for the final wire request, retaining only the source and
its compressed form, plus the small header buffer and encoder working storage.
Compression operates on already-serialised bytes; no JSON value is held by this path.
The supplied headers retain the existing wire ordering/casing rules; appended
Content-Length counts compressed bytes (`http-client.ts:97–100`). The transport
does not invent content-encoding. OAuth supplies it (`openai/mod.rs` and frozen
`openai/codec.ts:97–124`). Unencoded requests use the existing encoder entry point.

Before URL parsing or network activity, encoded requests with any content-length
or without exactly one content-encoding whose trimmed, case-insensitive value
is zstd are refused (`codecAdapter.ts:64–74,341`). Frozen GatewayError UPSTREAM
maps to Rust HttpError::InvalidEncodedRequest, retaining the complete message:
`{provider} codec buildRequest did not return a usable request`
(`codecAdapter.ts:23–33`). This is a transport-level check in Rust; frozen checks
it in the adapter. Compression IO errors map to HttpError::Compression.

Observed frozen empty-body wire request (raw TCP, Bun reference script):
`POST / HTTP/1.1\r\ncontent-encoding: zstd\r\nHost: fixture\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\n`
followed by hex `390d0a28b52ffd00580100000d0a300d0a0d0a`:
one 9-byte frame `28b52ffd0058010000`, then the terminating chunk.
Evidence: `/tmp/opencode/b3/s5b-empty.log`. This confirms unconditional empty
compression and write (`http-client.ts:154,179–181,203–204`) without explicit
length (`99–100`). The existing writer handles explicit chunking, but deriving
implicit chunking from a nonempty encoded/empty source requires a new branch.
Per controller instruction, Rust refuses empty encoded bodies with
HttpError::EmptyEncodedBody; decision on extending implicit chunking remains
open. OAuth's serialised JSON object is nonempty.

First wire test failed with UnsupportedEncoding(Zstd), saved in
`/tmp/opencode/b3/s5b-red.log`. `http_zstd` captures raw TCP requests and invokes
the frozen nodeHttpClient via `http-zstd-reference.ts`. Source byte lengths
37, 131091, 3145746 and the real OAuth codec request all have equal complete
header lists/order, correct Content-Length, and exactly equal decompressed
source bytes. Compressed bytes were identical for all these comparisons,
also for the 2-byte mixed-case/whitespace encoding-header acceptance probe.
OAuth bytes include generated identity data; its measured frame length can vary.
`s5b-green.log` records the observations. Tests also cover supplied length,
missing/wrong/duplicate encoding, and frozen-empty/Rust-refusal behavior.
Known differences: empty-body refusal; Rust error type rather than GatewayError;
compressed identity is diagnostic, not required (earlier empty encoder probes
below differ). No frozen TypeScript production file was modified.

## Encoder decision and measured prerequisite

Controller approved exact `zstd = { version = "=0.14.4", default-features = false }`.
Offline resolution/check and gateway build passed. Lock adds zstd 0.14.4,
zstd-safe 8.3.0, zstd-sys 2.1.3+zstd.1.5.7, and jobserver 0.1.35 through cc;
no existing package versions changed. Fetched Cargo.toml licences are
**BSD-3-Clause**, **BSD-3-Clause**, and **BSD-3-Clause AND BSD-2-Clause** respectively.
These supersede the provisional licence guesses below. Raw blocks and external
executables are rejected by controller decision. Dependency-internal unsafe is
approved; no application unsafe added.

`openai_zstd` compares level-3 write::Encoder/write_all/finish against the real
frozen zstdEncode. Sizes: 0, 1, 7, 62000, 131071/2/3, 507000,
2097151/2/3, 8388608, each with repeating bytes and deterministic xorshift bytes.
Frames **identical for 22 of 24** by SHA-256. The two empty-body rows differ:
Rust 9 bytes, header `28 b5 2f fd 20 00`; TS 9 bytes, `28 b5 2f fd 00 58`.
All 24 Rust frames decode exactly with libzstd. The probe has no OAuth corpus
yet; this is encoder availability evidence, not item 4 completion.

RED initially used uncompressed bytes and failed against TS; then the encoder
comparison first failed for size 0. Since compressed byte equality is diagnostic
rather than required, test reports differing cases and checks decompression.
Logs: s4-zstd-red.log, s4-zstd-green.log, s4-zstd-resolution.log,
s4-zstd-gateway-build.log, s4-zstd-tests.log, s4-zstd-clippy.log, s4-zstd-fmt.log
under /tmp/opencode/b3. Full three-crate tests, all three source tripwires,
clippy and fmt passed. HTTP implementation/refusal is still unchanged.

Identity persistence: frozen codec.ts:43–45 only reads codexSecretsFrom.
oauth.ts:146–170 returns ensureCodexSecrets(prior) in OAuth result providerData
on exchange/refresh, not on request encoding. Step 5 host must persist that
OAuth result providerData with the credential update; provider OAuth port must
call ensure_secrets(prior) when constructing that result. No request-time write.

## Original offline inspection (superseded blocker)

Inspected frozen `packages/providers/src/http-client.ts:160–207`: UTF-8
Buffer, `new CompressionStream("zstd", {level: 3})`, one write then close,
concurrent output drain. No size threshold. Streaming does not pledge size;
the source documents no content size, not single segment, 2 MiB window.
Those frame details have not been independently measured in this increment.

`openai/codec.ts:80,97–124` supplies `content-encoding: zstd` before
`content-type` in protocol assembly; profile ordering determines final position
(default after accept, before content-type). Body remains JSON for capture.
Transport copies supplied headers without removing any; appends
`Content-Length` using **compressed** byte count when nonempty source body and
no supplied length. `codecAdapter.ts:64–74` rejects encoded requests with any
content-length or without exactly one matching content-encoding; it does not
strip headers. `http-client.ts` does not add content-encoding itself.

Offline inspection: Cargo.lock has no zstd crate. Registry cache contains only
`ruzstd-0.7.3.crate`; its manifest describes a decoder (MIT), and lib.rs exports
FrameDecoder/StreamingDecoder, no encoder. No usable cached encoder found.
Rust refusal is `crates/omni-providers/src/http/mod.rs:248–249`.

Item 0 is blocked; item 4 is deferred. No compression code/dependency added.
Options requiring controller decision:
- Fetch `zstd` (MIT; native zstd via zstd-safe/zstd-sys, upstream BSD-3-Clause),
  including its dependency closure; use streaming level 3, offline builds only
  possible after provisioning. Licence statements here identify the proposed
  family; exact fetched package metadata still needs verification.
- Authorize raw/uncompressed zstd blocks: valid standard frames, slightly larger
  than JSON, no actual compression; requires explicit decision and decoder tests.
- A preinstalled external encoder could avoid a Cargo dependency but introduces
  a runtime executable requirement and process/error overhead; availability was
  not checked. Direct system-library FFI would violate the no-unsafe rule here.

Required acceptance remains exact decompressed frozen JSON, exact encoding
header/order, valid standard-decodable frame. Compressed byte identity has not
been compared because there is no Rust encoder.
