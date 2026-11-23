# Provider and model notes

Provider- and model-specific behaviour worth knowing before you deploy. The
general scope of the gateway is in the [README](../README.md#scope-and-limits);
what is missing on purpose or for now is in [roadmap.md](roadmap.md).

## Thinking controls

**Thinking controls retain their wire intent.** Anthropic `between_tools` passes
through; other providers treat it as off and report a degradation. Unparsed
Anthropic thinking fields (including beta controls) pass through only to
Anthropic; supply any required beta header yourself. Hidden adaptive display
omits generated Responses reasoning summaries, without inventing a default.

## Claude Code auto mode

**Claude Code auto mode supports Anthropic server-side classifier results.**
On Anthropic targets, the gateway forwards `safeguards`, protocol headers, and
original `safeguard_results` in both streaming and buffered replies. Safeguard
requests retain the client's system blocks and tool names/IDs rather than the
ordinary OAuth system/tool transformations. Eligibility and no-charge checks
still depend on Anthropic's rollout for the upstream credential/model; routing
to another provider does not supply them. This is not a byte-transparent proxy:
gateway policies and other request normalization still apply.
After deploying this version, start a **new Claude Code session** and check
`/status` → **Auto mode server: Enabled**. If the upstream is not eligible,
`CLAUDE_CODE_AUTO_MODE_SERVER=0` before starting Claude Code uses its separate
classifier calls instead; these remain billed as token usage. See
[Anthropic's notice guide](https://code.claude.com/docs/en/auto-mode-classifier-billing).

## OpenAI OAuth (ChatGPT) presents as Codex

**An OpenAI OAuth (ChatGPT) target presents itself as Codex, and answers like
it.** Requests on that leg follow Codex 0.170.0's captured TUI shape, which
changes model behaviour for every client routed there, Claude Code included:
one tool call per turn (`parallel_tool_calls: false`), terser answers
(`text.verbosity: "low"`), and a request that names no reasoning effort —
including adaptive thinking with no effort — runs at the model's Codex catalog
default (`low` or `medium`) rather than `medium`. A client's own `text`,
`reasoning` or tool choice still wins field by field. OpenAI API-key targets
are unaffected. Credentials connected before this pick up their per-credential
identity on their next token refresh. Details:
[the fingerprint design](superpowers/specs/2026-10-16-codex-0163-fingerprint-design.md).

## GPT-6.2 Sol and Astra

**GPT-6.2 Sol and Astra** are available for OpenAI API keys and ChatGPT OAuth.
The existing default model is unchanged. API input caps are 922K; OAuth uses
Codex's defaults, 500K for Sol and 272K for Astra (128K output on both legs).
Catalog prices are the short-context tier: above 272K input, input/cache rates
double and output is 1.5× for the whole request. Adjust saved target prices if
routinely using the long tier.

## Pricing a flat per-target rate cannot express

Two providers price in ways a flat per-target rate cannot express — xAI above
200K context and Kilo's `kilo-auto/*` routers.

## Qoder provider

Served by the Rust gateway. Experimental Qoder global account login,
server-derived models and native streaming are available without installing
its CLI. The model catalog is dynamic: the OAuth flow stores the account's
`providerData.modelCatalog` snapshot, which the console merges into the
catalog. See [Qoder setup and limitations](qoder.md).
Live account compatibility is not yet verified; unknown prices are not free usage.