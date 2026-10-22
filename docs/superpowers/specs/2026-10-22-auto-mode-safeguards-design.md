# Claude Code auto-mode safeguard compatibility

## Intent

Preserve Anthropic's server-side auto-mode classifier results through OmniGateway so
Claude Code can use them instead of falling back to separately billed classifier calls.
Eligibility is still decided by Anthropic for the upstream credential/model/platform;
the gateway must never fabricate a verdict or promise free classification.

References:
- https://code.claude.com/docs/en/auto-mode-classifier-billing
- https://code.claude.com/docs/en/llm-gateway-protocol
- https://code.claude.com/docs/en/permission-modes#server-side-classifier-review

## Evidence

The current ingress forwards unknown top-level body fields, including `safeguards`,
through `request.vendor.anthropic`. Client beta values reach the Anthropic codec.
The decoder discards `message_delta.delta.safeguard_results`, and the egress rebuilds
both streaming and buffered responses without it.

The locally installed Claude Code 2.1.303 reads `safeguard_results` from
`message_delta.delta` and keys the per-tool verdicts by the original tool-use ID.
It recognizes available, unsupported, and unavailable statuses. Treat all of this
as opaque provider data, not a gateway-owned schema.

## Design

1. Carry provider-owned response metadata in optional provider-keyed `vendor` bags
   on canonical terminal events and collected responses. IR does not name Anthropic.
2. Decode safeguard results without interpreting, filtering, or rewriting them.
   Preserve explicit null, empty lists, unsupported/unavailable statuses, and unknown
   nested keys. An absent field stays absent. Read the final delta and, defensively,
   top-level final-frame fields; preserve the actual upstream value, not a default.
3. Fold terminal metadata through `collect()`. Anthropic streaming egress restores
   the field inside `message_delta.delta`; buffered egress restores it at the top
   level of the Messages response. Other egress formats do not expose this metadata.
4. Preserve tool-use IDs and inputs. For requests carrying a non-empty `safeguards`
   list, do not cloak tool names or rewrite the client's system prompt in the
   Anthropic codec. Retain ordinary-request behavior. Do not suppress safeguard
   fields or beta headers to hide an upstream rejection.
   Preserve opaque original system-block fields while taking text/cache placement
   and additions from current IR, so configured Ponytail injection still applies.
5. Forward incoming `anthropic-*` protocol headers through provider-keyed request
   metadata, keeping secrets/authentication under the codec's control. Continue to
   append the upstream OAuth capability when required. Do not invent eligibility
   headers. Preserve custom version/workspace headers rather than using constants.
6. Add end-to-end synthetic HTTP tests using the real Anthropic adapter, dispatch,
   stream collector, and both response paths. No live credentials or provider calls.

These are implementation choices, not additional user requirements. Existing
provider-native content blocks and unknown-event fail-closed handling stay intact;
this change does not silently accept arbitrary new stream event types.

## Boundaries and non-goals

- No billing-policy changes, no local classifier implementation, no forged verdicts.
- No automatic rerouting to an Anthropic credential or changes to virtual-model policy.
- A non-Anthropic target cannot provide Anthropic's classifier simply by translating
  the request. No metadata is invented when the selected upstream omits it.
- Existing gateway policies/transforms remain explicit limitations: this is not a
  promise that every Anthropic request is now a byte-transparent proxy.
- No deployment or production configuration changes in this task.

## Acceptance

- Incoming safeguards and capability headers reach the synthetic Anthropic upstream.
- Available/flagged/not-flagged, unsupported/unavailable, and unknown result data
  survive both streaming and buffered responses unchanged.
- Tool-use IDs remain identical to keys in safeguard results; safeguard requests
  retain tool names, tool inputs, and client system blocks.
- Responses without results never acquire a synthesized result.
- Non-Anthropic surfaces cannot leak Anthropic-only metadata.
- Existing ordinary OAuth requests retain their current transformations.
- Focused tests plus repository CI checks pass, with unavailable external test
  services and any pre-existing failures reported explicitly.
