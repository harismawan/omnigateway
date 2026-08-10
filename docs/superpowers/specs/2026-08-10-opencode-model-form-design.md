# opencode Model Form — Design

Date: 2026-08-10
Status: approved

## Problem

Claude Code setup now asks the operator to map Default, Fable, Opus, Sonnet,
and Haiku classes to explicit gateway pools. opencode setup still includes every
configured pool with no form. Both clients should use the same operator-facing
selection flow, while preserving their different configuration formats.

## Goals

1. Show the same five model selectors for Claude Code and opencode.
2. Prompt for the same five mappings in both CLI setup commands.
3. Generate an opencode catalog containing only selected pools.
4. Set opencode's active default model from the required Default selection.
5. Keep resolved per-pool context and output limits unchanged.

## Shared mapping

Rename `ClaudeModelMapping` to `AgentModelMapping` and use it for both clients:

```ts
interface AgentModelMapping {
  defaultModel: string;
  fableModel?: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
}
```

Default is required. Other classes are optional. Every supplied pool ID must
exist in the current setup model list. One pool may fill several slots.
Validation stays in `packages/control`, shared by dashboard API and CLI.

Claude Code behavior remains unchanged: every selected class maps to its
corresponding environment variable, including duplicate pool values.

## opencode generation

opencode uses mappings as selection input rather than class aliases. Selected
pool IDs are collected in slot order and deduplicated. Generated
`provider.omnigateway.models` contains each unique selected pool once, retaining
its resolved display name and limits.

Top-level `model` is:

```json
"model": "omnigateway/<default pool id>"
```

Example: Default=`opus`, Fable=`opus`, Haiku=`haiku` produces:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "omnigateway/opus",
  "provider": {
    "omnigateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniGateway",
      "options": {
        "baseURL": "http://localhost:9000/v1",
        "apiKey": "<your OmniGateway key>"
      },
      "models": {
        "opus": { "name": "Opus", "limit": { "context": 1000000 } },
        "haiku": { "name": "Haiku", "limit": { "context": 200000 } }
      }
    }
  }
}
```

Unknown limits remain omitted rather than written as zero. Base URL
normalization and key placeholder behavior remain unchanged.

## Dashboard flow

Both client tabs render Default, Fable, Opus, Sonnet, and Haiku selectors.
Dashboard keeps separate mapping state per client so switching tabs does not
replace one client's choices with the other's.

Default must be selected before generation. Optional fields may remain blank.
The request to `/api/agent-setup` sends the selected mapping for either client.
The server validates it and generates one client-specific file.

Repeated selections remain visible as entered. Only opencode output deduplicates
them.

## CLI flow

`omni setup claude` and `omni setup opencode` use one shared prompt helper:

1. Default model — required.
2. Fable model — optional.
3. Opus model — optional.
4. Sonnet model — optional.
5. Haiku model — optional.

`omni setup opencode` continues writing `opencode.json` to current directory by
default, with `--dir`, `--key`, and `--dry-run` unchanged. Unlike Claude's
settings file, opencode output remains a generated replacement file; no merge
behavior is added.

## API and errors

`GET /api/agent-setup` requires `defaultModel` for both clients and accepts the
four optional class parameters for both.

Errors:

- missing or blank Default: `BAD_REQUEST`;
- unknown pool in any slot: `BAD_REQUEST` naming slot and value;
- no configured pools: existing empty-state behavior;
- filesystem write failures: existing CLI error behavior.

## Testing

Control tests cover unique selected pools, duplicate collapse, top-level default,
resolved limits, optional slots, and invalid IDs. Gateway tests cover required
mapping and opencode query forwarding. CLI tests cover five prompts and filtered
output. Dashboard tests cover selectors on both tabs, separate state per client,
request parameters, and generated previews.

Before completion, run:

```bash
bun test
bun run --cwd apps/dashboard test
bun run typecheck
bun run lint
```

## Out of scope

- Per-pool limit overrides.
- Generated class alias IDs in opencode.
- Merging generated opencode config into an existing file.
- Persisting mappings in database.
