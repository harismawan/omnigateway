# Provider Model Catalog Design

## Goal

Give operators curated upstream model choices for every supported provider while preserving unrestricted custom model entry. Each provider has one default model used when a dashboard model target is created or changes provider.

This feature improves dashboard model authoring only. It does not add request-time model fallback, seed stored virtual models, restrict accepted upstream model IDs, or change routing semantics.

## Terminology

A **virtual model** is an operator-defined routing pool such as `fast` or `smart`. A virtual model contains one or more provider targets.

A **provider model** is the upstream model ID on a target, such as `claude-opus-5`, `gpt-5.6`, or `k3-256k`.

A **curated choice** is a provider model suggested by the dashboard. It is not an allowlist. Operators may enter any non-empty custom model ID.

## Curated Catalog

A typed provider model catalog lives in `packages/ir`, alongside canonical provider capabilities. The catalog is keyed by `ProviderId`, making omission of a supported provider a TypeScript error.

Each provider entry contains:

- One `defaultModel` ID.
- An ordered list of models, each with an upstream `id` and dashboard `label`.

Initial catalog:

| Provider | Default | Curated choices |
| --- | --- | --- |
| Anthropic | `claude-opus-5` | `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` |
| OpenAI | `gpt-5.6` | `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |
| Kimi | `k3-256k` | `k3-256k`, `k3`, `kimi-for-coding`, `kimi-for-coding-highspeed` |

Labels distinguish variants without changing saved IDs. Anthropic and OpenAI labels match their
IDs exactly. Kimi uses these ID-to-label mappings:

- `k3-256k` → `Kimi K3 — 256K`
- `k3` → `Kimi K3 — up to 1M`
- `kimi-for-coding` → `Kimi K2.7 Code`
- `kimi-for-coding-highspeed` → `Kimi K2.7 Code — High Speed`

`k3-256k` is the Kimi default because Kimi recommends it for everyday coding and it avoids requiring the higher-tier plan needed for K3's 1M context. All curated Kimi IDs are compatible with OmniGateway's existing Kimi Coding endpoint.

Catalog order controls suggestion order. The default need not be inferred from list position; `defaultModel` remains explicit.

## Dashboard Behavior

The model target editor replaces the plain model text field with an editable combobox or equivalent accessible input-plus-suggestions control.

For the currently selected provider:

1. Focusing the model field exposes all curated choices; typing filters them by case-insensitive
   substring match against IDs and labels.
2. Selecting a curated choice writes its exact upstream ID into the target.
3. Typing an arbitrary model ID remains allowed.
4. Saving preserves custom IDs unchanged.
5. A stored custom ID displays normally even when absent from the current catalog.
6. Keyboard navigation and selection follow accessible combobox semantics, and each model field has
   an accessible name identifying its target row.

New target behavior:

- A new virtual model starts with provider `anthropic` and model `claude-opus-5`.
- Adding another target starts with provider `anthropic` and model `claude-opus-5`.

Provider-change behavior:

- Changing a target's provider sets both fields atomically: the selected provider and that provider's `defaultModel`.
- This prevents stale pairs such as provider `kimi` with model `claude-opus-5`.
- After the reset, the operator may select another curated choice or type a custom ID.

No automatic capability changes are included. Existing tools, images, and reasoning controls remain operator-managed. Capability automation would be separate work because support can vary by specific model and account tier.

## Data Flow

1. Dashboard creates a target by reading the selected provider's catalog entry.
2. Dashboard renders suggestions from the same entry.
3. Operator selects a suggestion or enters a custom model ID.
4. Existing `PUT /api/models/:id` request sends the resulting `VirtualModel` unchanged.
5. Gateway validates and persists the target through existing control API and store seams.
6. Router and dispatch receive the saved upstream model exactly as they do today.

The stored `VirtualModel` and `Target` types do not change. No database migration is required.

## Boundaries and Compatibility

- `packages/ir` owns canonical provider metadata without provider SDK or network dependencies.
- Dashboard consumes that metadata for defaults and suggestions.
- Provider adapters continue owning endpoint and wire behavior.
- Router remains pure and unaware of dashboard curation.
- Ingress continues requiring an explicit client-facing virtual model name.
- `/v1/models` continues listing configured virtual models only.
- Existing saved targets are not rewritten during startup, load, edit, or save unless the operator changes them.
- Server validation continues accepting any non-empty upstream model string.

Curated entries are maintained source data. Updating them requires a normal code change and tests; the gateway does not call live provider model-list APIs. This keeps startup deterministic and avoids exposing network-dependent catalog drift.

## Error Handling

The catalog uses an exhaustive `Readonly<Record<ProviderId, ...>>`, so adding a provider without catalog data fails type checking.

Every catalog entry must satisfy these invariants:

- `defaultModel` is non-empty.
- Curated IDs are non-empty and unique within the provider.
- Curated labels are non-empty.
- `defaultModel` appears exactly once among that provider's curated IDs.

A small unit test enforces these invariants. Dashboard reads defaults only from catalog and never
silently falls back to an empty model. Existing API validation handles empty or malformed saved
targets.

A custom ID rejected by an upstream provider follows existing provider error normalization and dispatch behavior; curation does not claim that arbitrary IDs are valid.

## Testing

Focused tests cover:

1. Catalog includes every supported provider.
2. Each default appears exactly once in its provider's curated choices.
3. New virtual model target starts as Anthropic with `claude-opus-5`.
4. Added target starts as Anthropic with `claude-opus-5`.
5. Anthropic, OpenAI, and Kimi show only their own curated choices.
6. Selecting a suggestion fills the exact upstream model ID.
7. Changing provider resets the model to that provider's default.
8. Operator can replace a suggested value with a custom ID and save it unchanged.
9. Existing custom model renders unchanged when absent from catalog.
10. Existing configured targets do not change merely by opening the editor.

Before completion, run focused catalog and dashboard model tests, then full `bun test`, `bun run typecheck`, and `bun run lint`.

## Documentation Sources

Model choices were researched against current provider documentation and OmniRoute's maintained Kimi registry:

- Anthropic model overview: <https://platform.claude.com/docs/en/about-claude/models/overview>
- OpenAI latest-model guidance: <https://developers.openai.com/api/docs/guides/latest-model>
- OpenAI model catalog: <https://developers.openai.com/api/docs/models>
- Official Kimi Coding models: <https://www.kimi.com/code/docs/en/kimi-code/models.html>
- OmniRoute Kimi Coding registry: <https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/open-sse/config/providers/registry/kimi/coding/index.ts>
