import {
  type ServingCredential as ControlServingCredential,
  modelDisplayName,
  resolveModelLimits,
} from "@omni/control";
import type { VirtualModel } from "@omni/store";

/**
 * One entry of `GET /v1/models`, in both dialects at once.
 *
 * The gateway serves Anthropic-compatible and OpenAI-compatible clients from a
 * single listing, so an entry carries both spellings of the same facts rather
 * than the surface being split in two: `object`/`created`/`owned_by` are what
 * an OpenAI client reads, `type`/`display_name`/`created_at`/`max_input_tokens`
 * what an Anthropic one reads. Neither is troubled by the other's keys.
 *
 * `max_input_tokens` is read by OpenAI-dialect clients and by agents such as
 * opencode. Claude Code is not among them: measured against 2.1.226, it ignores
 * this field entirely and assumes 200K for any model id its built-in table does
 * not know. Sizing a Claude Code session is a configuration problem, not a
 * response-body one — see the agent-client spec and `omni setup claude`.
 */
export type ModelDescription = {
  id: string;
  object: "model";
  type: "model";
  display_name: string;
  created: number;
  created_at: string;
  owned_by: string;
  max_input_tokens?: number;
  max_tokens?: number;
  /** Present only on a discovery mirror: the real virtual model it stands for. */
  root?: string;
};

export type ModelListBody = {
  object: "list";
  data: ModelDescription[];
  has_more: false;
  first_id: string | null;
  last_id: string | null;
};

export type ServingCredential = ControlServingCredential;

/** Virtual models carry no creation time, so every entry reports the epoch. */
const CREATED_AT = new Date(0).toISOString();

export function describeModel(
  model: VirtualModel,
  credentials: readonly ServingCredential[],
): ModelDescription {
  const limits = resolveModelLimits(model, credentials);
  return {
    id: model.id,
    object: "model",
    type: "model",
    display_name: modelDisplayName(model),
    created: 0,
    created_at: CREATED_AT,
    owned_by: "omnigateway",
    ...(limits.contextWindow === undefined ? {} : { max_input_tokens: limits.contextWindow }),
    ...(limits.maxOutputTokens === undefined ? {} : { max_tokens: limits.maxOutputTokens }),
  };
}

export function modelListBody(
  models: readonly VirtualModel[],
  credentials: readonly ServingCredential[],
): ModelListBody {
  const data = models.map((model) => describeModel(model, credentials));
  return {
    object: "list",
    data,
    // The listing is never paginated: an installation configures tens of
    // models, not thousands, and a client that follows the cursor would loop.
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}
