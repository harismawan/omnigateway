import { type ChatRequest, GatewayError, type ProviderId } from "@omni/ir";
import { buildSnapshot, rank } from "@omni/router";
import type { Store } from "@omni/store";
import { dryRunSchema, parseOrThrow } from "./schemas.ts";

export type DryRunCandidate = {
  credentialId: string;
  credentialLabel: string;
  provider: ProviderId;
  model: string;
  tier: number;
  score: number;
  reasons: Record<string, number>;
};

export type DryRunResult = {
  modelId: string;
  strategy: string;
  deterministic: boolean;
  rankedAt: number;
  candidates: DryRunCandidate[];
  excluded: Array<{ credentialId: string; model: string; reason: string }>;
};

/**
 * Ranks a hypothetical request against the live snapshot.
 *
 * `rand` is pinned to zero: an operator asking "where would this go" wants the
 * answer the router would give, not a sample from a weighted draw. That is what
 * `deterministic` reports.
 */
export async function dryRun(
  deps: { store: Store; now: () => number },
  modelId: string,
  input: unknown,
): Promise<DryRunResult> {
  const need = parseOrThrow(dryRunSchema, input);
  const now = deps.now();
  const snapshot = await buildSnapshot(deps.store, now);
  const model = snapshot.models.get(modelId);
  if (model === undefined) {
    throw new GatewayError("MODEL_UNAVAILABLE", `no virtual model "${modelId}"`);
  }

  const probe: ChatRequest = {
    model: modelId,
    messages: [
      {
        role: "user",
        content: need.images
          ? [{ type: "image", mediaType: "image/png", data: "" }]
          : [{ type: "text", text: "" }],
      },
    ],
    stream: false,
    ...(need.tools
      ? {
          tools: [
            { provider: "custom", name: "probe", description: "", inputSchema: { type: "object" } },
          ],
        }
      : {}),
    ...(need.reasoning ? { reasoning: { mode: "adaptive" as const } } : {}),
  };
  const result = rank({ request: probe, model, snapshot, now, rand: 0 });

  return {
    modelId: model.id,
    strategy: model.strategy,
    deterministic: model.strategy !== "weighted",
    rankedAt: now,
    candidates: result.candidates.map((candidate) => ({
      credentialId: candidate.credential.id,
      credentialLabel: candidate.credential.label,
      provider: candidate.credential.provider,
      model: candidate.target.model,
      tier: candidate.target.tier,
      score: candidate.score,
      reasons: candidate.reasons,
    })),
    excluded: result.excluded,
  };
}
