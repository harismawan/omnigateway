import type { Store, VirtualModel } from "@omni/store";
import { listCredentials } from "./credentials.ts";
import { type ModelLimits, modelDisplayName, resolveModelLimits } from "./modelLimits.ts";
import { listModels } from "./models.ts";

/**
 * The configuration files an agent needs to talk to this gateway.
 *
 * Generated here rather than in the CLI or the console because both need the
 * same answer: none of these agents reads its context window from
 * `GET /v1/models`, so the window has to be written into what each one reads at
 * startup, and a console that showed one number while `omni setup claude` wrote
 * another would be worse than either alone.
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

export const KEY_PLACEHOLDER = "<your OmniGateway key>";

export type SetupInput = {
  baseUrl: string;
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

/** A pool id as a directory name. Ids may contain a slash; path segments may not. */
function slug(id: string): string {
  return id.replace(/\//g, "-");
}

/**
 * One Claude Code profile per model.
 *
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is one number for one process, so a model
 * each needs a profile each — that is the whole reason this returns a directory
 * of files rather than one file.
 */
export function claudeProfiles(described: readonly Described[], input: SetupInput): SetupFile[] {
  const apiKey = input.apiKey ?? KEY_PLACEHOLDER;
  return described.map(({ model, limits }) => {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: input.baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: model.id,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    };
    // Written only where it would be read. The client consults this variable
    // only for a model its built-in table does not know, and never for an id
    // beginning `claude-`; writing it otherwise produces a file that looks like
    // it configures something and does not.
    if (limits.contextWindow !== undefined && !/^claude-/i.test(model.id)) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(limits.contextWindow);
    }
    return {
      path: `${slug(model.id)}/settings.json`,
      contents: `${JSON.stringify({ env }, null, 2)}\n`,
    };
  });
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
            baseURL: `${input.baseUrl.replace(/\/+$/, "")}/v1`,
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
): Promise<SetupFile[]> {
  const described = await describeModelsForSetup(store);
  return client === "claude"
    ? claudeProfiles(described, input)
    : [opencodeConfig(described, input)];
}
