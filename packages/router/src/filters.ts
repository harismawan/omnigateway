import type { ChatRequest, ProviderCapabilities } from "@omni/ir";
import { ANTHROPIC_NATIVE_TOOLS } from "@omni/ir";
import type { CredentialView, Target } from "@omni/store";
import { healthKey } from "./snapshot.ts";
import type { Excluded, RankInput } from "./types.ts";

export type Pair = { credential: CredentialView; target: Target };

/**
 * Whether the request can only be served by a provider that speaks Anthropic's
 * own tool and block formats.
 *
 * History counts, not just the tool list. A client that ran a web search on one
 * turn replays the `server_tool_use` and its result on the next, often without
 * redeclaring the tool — routing that turn elsewhere would drop the blocks and
 * change the conversation the model sees. Asking here, before dispatch, is what
 * turns "no target can do this" into one clear routing failure rather than an
 * adapter discovering it mid-encode.
 */
export function needsAnthropicNative(request: ChatRequest): boolean {
  if (request.tools?.some((t) => t.provider === "anthropic") === true) return true;
  return request.messages.some((m) => m.content.some((b) => b.type === "anthropicNative"));
}

/** What the request actually needs, so targets can be filtered on it. */
export function requiredCapabilities(request: ChatRequest): ProviderCapabilities {
  const images = request.messages.some((m) => m.content.some((b) => b.type === "image"));
  return {
    tools: (request.tools?.length ?? 0) > 0,
    images,
    // An explicit opt-out is not a requirement for a reasoning-capable target.
    reasoning: request.reasoning !== undefined && request.reasoning.mode !== "off",
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
  const needNative = needsAnthropicNative(request);

  const pairs: Pair[] = [];
  const excluded: Excluded[] = [];

  for (const target of model.targets) {
    // Read from the provider table rather than the stored target: whether a
    // target speaks Anthropic's wire format is decided by the adapter serving
    // it, not by a setting an operator could switch on for a provider that
    // cannot honour it.
    const missing =
      needNative && !ANTHROPIC_NATIVE_TOOLS[target.provider]
        ? "anthropicTools"
        : (["tools", "images", "reasoning"] as const).find(
            (cap) => need[cap] && !target.capabilities[cap],
          );

    // Whether the account a pinned target names was reachable at all. Set once
    // the pin matches a credential that already cleared the provider and
    // endpoint checks, so a pin at another provider's account counts as unseen
    // rather than as a way around those checks.
    let pinSeen = false;

    for (const credential of snapshot.credentials) {
      if (credential.provider !== target.provider) continue;
      if (
        target.provider === "custom" &&
        credential.providerData.endpointId !== target.endpointId
      ) {
        continue;
      }
      // Silent, like the two checks above: an account the pin excludes was
      // never a candidate for this target, and recording one row per sibling
      // would bury the reasons that describe the pinned account itself.
      if (target.credentialId !== undefined && credential.id !== target.credentialId) continue;
      pinSeen = target.credentialId !== undefined;

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

      // A snapshot is a reading from a moment in time. Once the provider's own
      // reset time has passed, an exhausted window says nothing about now, and
      // holding the credential out until the next poll would strand it for as
      // long as the poll interval.
      const spent = (snapshot.quota.get(credential.id) ?? []).find(
        (w) => w.limit !== null && w.used >= w.limit && (w.resetsAt === null || w.resetsAt > now),
      );
      if (spent !== undefined) {
        drop(`quota:${spent.windowType}`);
        continue;
      }

      pairs.push({ credential, target });
    }

    // A pin at an account that was deleted, or that belongs to another
    // provider, drops every credential silently and would otherwise fail the
    // request with nothing in `excluded` to explain it.
    if (target.credentialId !== undefined && !pinSeen) {
      excluded.push({
        credentialId: target.credentialId,
        model: target.model,
        reason: "pin:missing",
      });
    }
  }

  return { pairs, excluded };
}
