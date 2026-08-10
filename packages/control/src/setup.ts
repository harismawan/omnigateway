import type { Store, VirtualModel } from "@omni/store";
import { listCredentials } from "./credentials.ts";
import { type ModelLimits, modelDisplayName, resolveModelLimits } from "./modelLimits.ts";
import { listModels } from "./models.ts";

/**
 * The configuration files an agent needs to talk to this gateway.
 *
 * Generated here rather than in the CLI or the console because both need the
 * same answer. Claude Code needs explicit model-class mappings, while opencode
 * needs each model's context window in its own configuration. A console that
 * showed one value while the CLI wrote another would be worse than either alone.
 *
 * Nothing here touches a filesystem. A caller that writes files decides where
 * they go; a caller that renders them decides how.
 */

export type SetupClient = "claude" | "opencode";

export type SetupFile = {
  /** Where this belongs, relative to the client's own configuration root. */
  path: string;
  contents: string;
};

export type ClaudeModelMapping = {
  defaultModel: string;
  fableModel?: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
};

export const KEY_PLACEHOLDER = "<your OmniGateway key>";

export type SetupInput = {
  baseUrl: string;
  /** Whether Claude Code discovery mirrors are exposed by `/v1/models`. */
  discoveryMirrors?: boolean;
  /** Defaults to a placeholder: a generated file with a live key in it ends up in a screenshot. */
  apiKey?: string;
};

type Described = { model: VirtualModel; limits: ModelLimits; label: string };

/** Every model, with the limits the `/v1/models` listing would report for it. */
export async function describeModelsForSetup(store: Store): Promise<Described[]> {
  const models = await listModels(store);
  const credentials = (await listCredentials(store)).map((credential) => ({
    provider: credential.provider,
    authType: credential.authType,
    enabled: credential.enabled,
  }));
  return models.map((model) => ({
    model,
    limits: resolveModelLimits(model, credentials),
    label: modelDisplayName(model),
  }));
}

const CLAUDE_MAPPING_KEYS = {
  defaultModel: "ANTHROPIC_MODEL",
  fableModel: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  opusModel: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnetModel: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haikuModel: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
} as const;

function settingsObject(existing: string | undefined): Record<string, unknown> {
  if (existing === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings root is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`cannot parse existing settings.json: ${reason}`);
  }
}

/** One Claude Code settings file with an explicit pool for each selected model class. */
export function claudeSettings(
  described: readonly Described[],
  input: SetupInput,
  mapping: ClaudeModelMapping,
  existing?: string,
): SetupFile {
  if (mapping.defaultModel === "") throw new Error("default model is required");

  const ids = new Set(described.map(({ model }) => model.id));
  const visibleId = (slot: keyof ClaudeModelMapping, id: string): string => {
    if (!ids.has(id)) throw new Error(`${slot} names unknown virtual model "${id}"`);
    const useMirror = input.discoveryMirrors === true && !/^(?:claude|anthropic)/i.test(id);
    return useMirror ? `claude/${id}` : id;
  };

  const settings = settingsObject(existing);
  const currentEnv = settings.env;
  const env: Record<string, unknown> =
    typeof currentEnv === "object" && currentEnv !== null && !Array.isArray(currentEnv)
      ? { ...(currentEnv as Record<string, unknown>) }
      : {};

  for (const key of Object.values(CLAUDE_MAPPING_KEYS)) delete env[key];
  delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  env.ANTHROPIC_BASE_URL = input.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = input.apiKey ?? KEY_PLACEHOLDER;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";

  for (const [slot, key] of Object.entries(CLAUDE_MAPPING_KEYS) as Array<
    [keyof ClaudeModelMapping, string]
  >) {
    const id = mapping[slot];
    if (id !== undefined && id !== "") env[key] = visibleId(slot, id);
  }

  return {
    path: "settings.json",
    contents: `${JSON.stringify({ ...settings, env }, null, 2)}\n`,
  };
}

/**
 * One opencode provider entry covering the whole catalog.
 *
 * opencode names a window per model inside its own config, so unlike Claude
 * Code one file describes every pool.
 */
export function opencodeConfig(described: readonly Described[], input: SetupInput): SetupFile {
  const models: Record<string, unknown> = {};
  for (const { model, limits, label } of described) {
    // An unknown window is left out entirely rather than written as zero:
    // opencode reads `limit.context: 0` as no limit and disables its own
    // compaction, which is worse than falling back to its default.
    const limit =
      limits.contextWindow === undefined
        ? undefined
        : {
            context: limits.contextWindow,
            ...(limits.maxOutputTokens === undefined ? {} : { output: limits.maxOutputTokens }),
          };
    models[model.id] = { name: label, ...(limit === undefined ? {} : { limit }) };
  }

  const contents = `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        omnigateway: {
          npm: "@ai-sdk/openai-compatible",
          name: "OmniGateway",
          // opencode drives the OpenAI-compatible surface, served here at
          // `/v1/chat/completions`.
          options: {
            baseURL: `${input.baseUrl.replace(/\/+$/, "").replace(/(?:\/v1)+$/i, "")}/v1`,
            apiKey: input.apiKey ?? KEY_PLACEHOLDER,
          },
          models,
        },
      },
    },
    null,
    2,
  )}\n`;

  return { path: "opencode.json", contents };
}

/** Every file for one client, from a store. */
export async function setupFiles(
  store: Store,
  client: SetupClient,
  input: SetupInput,
  mapping?: ClaudeModelMapping,
): Promise<SetupFile[]> {
  const described = await describeModelsForSetup(store);
  if (client === "opencode") return [opencodeConfig(described, input)];
  if (mapping === undefined) throw new Error("defaultModel is required for Claude setup");
  return [claudeSettings(described, input, mapping)];
}
