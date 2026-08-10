# Claude Setup and Dashboard Scroll Behavior — Design

Date: 2026-08-10
Status: approved

## Problem

Claude Code setup currently generates one profile file per virtual model because
`ANTHROPIC_MODEL` was the only generated model selector. Current Claude Code can
instead select one model for each model class through environment variables. An
operator needs explicit control over those mappings; deriving them from pool
names or ordering would create hidden policy.

Dashboard scrolling also has two usability problems. Main-page scrolling moves
the navigation rail, and the console terminal grows with its log content instead
of occupying the available viewport and scrolling internally.

## Goals

1. Generate one Claude Code `settings.json` with an operator-selected default
   model and optional Fable, Opus, Sonnet, and Haiku mappings.
2. Expose the same explicit mapping flow in dashboard and CLI.
3. Preserve unrelated settings when writing an existing Claude Code settings
   file.
4. Keep desktop sidebar and mobile top navigation stationary while main content
   scrolls.
5. Bound console view to available screen height, scroll inside terminal, and
   initially show latest logs without disrupting an operator reading older logs.
6. Leave opencode setup behavior unchanged.

## Claude model mapping

The control layer accepts one shared mapping:

```ts
interface ClaudeModelMapping {
  defaultModel: string;
  fableModel?: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
}
```

`defaultModel` is required. Class mappings are optional. Every supplied value
must name a virtual model in the current setup model list. One pool may fill
multiple slots. No class is inferred from pool names, provider model names,
context limits, or list order.

The mapping writes these environment variables:

| Mapping field | Claude Code environment variable |
| --- | --- |
| `defaultModel` | `ANTHROPIC_MODEL` |
| `fableModel` | `ANTHROPIC_DEFAULT_FABLE_MODEL` |
| `opusModel` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `sonnetModel` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| `haikuModel` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |

Values use the same client-visible model IDs as current setup generation:
`claude/<pool>` mirrors when aliases are enabled, otherwise real pool IDs.
Gateway connection variables remain in the same `env` object:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`

Per-model `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is removed from Claude setup. One
process-global value cannot accurately describe several selectable model
classes. Claude Code therefore uses its built-in sizing behavior for selected
IDs; opencode keeps its generated per-model limits. This is an explicit
trade-off of replacing isolated profiles with one multi-class settings file.

## Single settings file and merge semantics

Default output is `~/.claude/settings.json`. CLI `--dir` overrides the `.claude`
directory, so output remains `<dir>/settings.json`.

When no file exists, setup creates:

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:9000",
    "ANTHROPIC_AUTH_TOKEN": "<your OmniGateway key>",
    "ANTHROPIC_MODEL": "default-pool",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "fable-pool",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-pool",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet-pool",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku-pool",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

When a file exists, setup parses its JSON and preserves unrelated top-level
properties and unrelated `env` entries. It replaces managed gateway and model
keys. A blank optional model slot removes its corresponding managed environment
key, preventing stale mappings from surviving a later setup run.

Malformed existing JSON is never overwritten. Setup reports the path and parse
failure. File writes use the CLI filesystem seam and preserve the original on a
write failure.

Dashboard preview has no access to the operator's local `~/.claude` file. It
therefore previews the generated settings object merged into an empty object.
CLI dry-run and write paths can show the real merge because they run locally.

## Dashboard and CLI flows

### Dashboard

Settings Agent Setup keeps the Claude/opencode client switch. Selecting Claude
shows five pool selectors:

1. Default — required
2. Fable — optional
3. Opus — optional
4. Sonnet — optional
5. Haiku — optional

Selectors use current pool IDs and may choose the same pool more than once. The
setup request sends the explicit mapping to `GET /api/agent-setup` through
validated query parameters, and the response contains one Claude setup file.
Unknown or stale IDs produce a validation error naming the affected slot. An
empty model list disables generation and preserves the existing empty-model
message.

### CLI

`omni setup claude` loads current pools, prompts for required default mapping,
then prompts for each optional class mapping. Optional prompts allow a blank
choice. Non-interactive and test seams receive the same mapping explicitly so
no selection policy is duplicated outside control.

`omni setup opencode` remains unchanged.

## Dashboard shell scrolling

Authenticated app shell owns viewport height. Browser body does not provide the
normal app scroll surface.

On desktop:

- shell remains a two-column grid;
- navigation rail occupies the full viewport-height sidebar column;
- sidebar position does not move when page content scrolls;
- sidebar may scroll internally only if its own contents exceed viewport;
- main column is the page scroll container and uses `min-height: 0` so grid
  children may shrink correctly.

On narrow layouts, rail becomes horizontal top navigation and remains fixed at
the top of the app shell. Main content scrolls in the remaining height beneath
it.

## Console viewport and scroll behavior

Console board fills available main-column height minus existing page padding.
Its title, source label, and controls remain visible. Terminal panel consumes
remaining height with a `minmax(0, 1fr)` or equivalent flex layout and owns both
vertical and horizontal overflow.

Scroll rules:

1. After first successful log load, scroll terminal to bottom.
2. Before each polling update, record whether terminal is near bottom.
3. If it was near bottom, scroll to new bottom after render.
4. If operator scrolled upward, preserve reading position across refreshes.
5. Empty, loading, and error states remain inside same bounded console region.

“Near bottom” uses a small pixel tolerance so sub-pixel layout differences do
not disable following latest logs.

## Error handling

- Missing default model: validation error.
- Unknown model in any slot: validation error naming slot and value.
- Missing existing settings file: create new file.
- Malformed existing settings JSON: refuse overwrite and report parse failure.
- Blank optional slot: omit new key and remove stale managed key during merge.
- Filesystem write failure: preserve original and surface error.
- Empty pool list: disable form and show existing no-model state.

## Testing

Control tests cover:

- one-file generation;
- all five model keys;
- omitted optional mappings;
- client-visible alias IDs;
- unknown mapping rejection;
- preservation of unrelated settings and env keys;
- stale optional-key removal;
- malformed JSON refusal.

CLI tests cover prompts, default path, `--dir`, dry-run, merged writes, and
filesystem errors. Gateway tests cover mapping query validation and one-file
responses. Dashboard setup tests cover required and optional selectors, repeated
pool choices, request mapping, preview output, stale errors, and empty pools.

Dashboard layout tests cover fixed desktop rail, fixed mobile navigation, and
main-only scrolling. Console tests cover bounded terminal overflow, initial
bottom scroll, follow-at-bottom refreshes, and preserved manual scroll.

Before completion, run:

```bash
bun test
bun run --cwd apps/dashboard test
bun run typecheck
bun run lint
```

## Out of scope

- Persisting model-class mappings in database.
- Inferring class mappings from names or providers.
- Changing opencode setup format.
- Adding WebSocket console streaming.
- Changing console polling cadence.
