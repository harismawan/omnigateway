# Step 4 compression prerequisite (2026-11-14)

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
