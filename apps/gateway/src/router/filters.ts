import type { ChatRequest, ProviderCapabilities } from "@omni/ir";
import type { CredentialView, Target } from "@omni/store";
import { healthKey } from "./snapshot.ts";
import type { Excluded, RankInput } from "./types.ts";

export type Pair = { credential: CredentialView; target: Target };

/** What the request actually needs, so targets can be filtered on it. */
export function requiredCapabilities(request: ChatRequest): ProviderCapabilities {
  const images = request.messages.some((m) => m.content.some((b) => b.type === "image"));
  return {
    tools: (request.tools?.length ?? 0) > 0,
    images,
    reasoning: request.reasoning !== undefined,
  };
}

/**
 * Backoff for an open breaker: base cooldown doubled per failure past the
 * threshold, capped so a long-dead credential is still probed hourly.
 */
function cooldownMs(failures: number, threshold: number, base: number): number {
  const over = Math.max(0, failures - threshold);
  return Math.min(base * 2 ** over, 3_600_000);
}

export function eligible(input: RankInput): { pairs: Pair[]; excluded: Excluded[] } {
  const { request, model, snapshot, now } = input;
  const { breakerThreshold, breakerCooldownMs } = snapshot.settings;
  const need = requiredCapabilities(request);

  const pairs: Pair[] = [];
  const excluded: Excluded[] = [];

  for (const target of model.targets) {
    const missing = (["tools", "images", "reasoning"] as const).find(
      (cap) => need[cap] && !target.capabilities[cap],
    );

    for (const credential of snapshot.credentials) {
      if (credential.provider !== target.provider) continue;

      const drop = (reason: string): void => {
        excluded.push({ credentialId: credential.id, model: target.model, reason });
      };

      if (missing !== undefined) {
        drop(`capability:${missing}`);
        continue;
      }
      if (!credential.enabled) {
        drop("disabled");
        continue;
      }

      // An OAuth credential past expiry is usable only if it can be refreshed;
      // dispatch performs the refresh before the call.
      if (
        credential.authType === "oauth" &&
        credential.expiresAt !== null &&
        credential.expiresAt <= now &&
        !credential.hasRefreshToken
      ) {
        drop("expired");
        continue;
      }

      const h = snapshot.health.get(healthKey(credential.id, target.model));
      if (h !== undefined) {
        if (h.rateLimitedUntil !== null && h.rateLimitedUntil > now) {
          drop("rateLimited");
          continue;
        }
        if (h.breakerState === "open") {
          const elapsed = now - (h.openedAt ?? now);
          if (elapsed < cooldownMs(h.consecutiveFailures, breakerThreshold, breakerCooldownMs)) {
            drop("breaker:open");
            continue;
          }
          // Cooldown elapsed: admitted as a half-open probe.
        }
      }

      const spent = (snapshot.quota.get(credential.id) ?? []).find(
        (w) => w.limit !== null && w.used >= w.limit,
      );
      if (spent !== undefined) {
        drop(`quota:${spent.windowType}`);
        continue;
      }

      pairs.push({ credential, target });
    }
  }

  return { pairs, excluded };
}
