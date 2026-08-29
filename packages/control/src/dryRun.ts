import { type ChatRequest, GatewayError, type ProviderId } from "@omni/ir";
import type { ProviderDescriptors } from "@omni/providers/descriptors";
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
  // `providers` is a dependency and not a default, because the two callers see
  // two different installations. The gateway's registry holds every plugin it
  // loaded at boot; the CLI's is built by `readPluginProviders` from the
  // manifests on disk. Defaulting it to `PROVIDER_DESCRIPTORS` here is what made
  // `omni models dry-run` report `provider:missing` for a target the running
  // gateway was serving — the wrong answer, and the more specific-looking one,
  // against a `doctor` on the same install that called the configuration healthy.
  deps: { store: Store; now: () => number; providers?: ProviderDescriptors },
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
            { kind: "portable", name: "probe", description: "", inputSchema: { type: "object" } },
          ],
        }
      : {}),
    ...(need.reasoning ? { reasoning: { mode: "adaptive" as const } } : {}),
  };
  // No load: this request is hypothetical, so it has no peers in flight. A
  // dry run answers "where would this go on an idle gateway", which is the
  // question an operator reading it is asking.
  const result = rank({
    request: probe,
    model,
    snapshot,
    now,
    rand: 0,
    load: new Map(),
    ...(deps.providers === undefined ? {} : { providers: deps.providers }),
  });

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
    // Projected field by field like `candidates` above, rather than passed
    // through. `Excluded` also carries the router's `kind` discriminator, which
    // exists so dispatch can decide what to redact; structural typing would let
    // it ride along into a response the dashboard's own type does not declare.
    excluded: result.excluded.map((e) => ({
      credentialId: e.credentialId,
      model: e.model,
      reason: e.reason,
    })),
  };
}
