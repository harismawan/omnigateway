# OAuth codec decode comparison

Frozen codec.ts:103–132 derives nativeReasoning from the original client's
vendor.openai.include, independently of credentials. OAuth forces encrypted
reasoning in the upstream request but does not thereby enable native decoding.
Both credentials use parseSse → decodeResponses with that same boolean. There
is no OAuth decoder input, error classifier override, usage rule, or collector.
decode.ts:119–125, 266–277, 284–351 confirm shared native folding, terminal,
usage, and error mapping. Buffered clients still request upstream SSE.

`openai-oauth-decode-reference.ts` reuses all 158 shared corpus rows, builds
OAuth and API-key requests, passes their actual decode states through the frozen
codec, and compares events and three buffered dialect renderings to the direct
decoder oracle, at whole/one-byte/seven-byte chunkings. Both credential modes
match on every row; no OAuth-specific upstream event handling was found.

Rust `openai_decode::oauth_codec_decoder_chunkings` builds the OAuth request and
uses ProviderCodec::decoder with its returned state. **152 rows ×3 chunkings =
456 event comparisons and 1,368 buffered byte comparisons**, all pass. The six
non-numeric usage rows stay excluded by the existing X1 filter; the original
ignored test is unchanged. TS-only equality on those rows is not Rust parity.
Native false and true reasoning rows explicitly exercise the forced upstream
include versus client include distinction. Buffered output covers Anthropic
Messages, OpenAI Chat Completions, and Responses. No HTTP transport exercised.

First run: green (`/tmp/opencode/b3/s4d-c2.log`, 3 passed, 1 ignored).
