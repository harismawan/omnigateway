import type { ChatRequest, ContentBlock, ProviderCapabilities, ProviderId } from "@omni/ir";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { type CredentialView, servesTarget, type Target } from "@omni/store/types";
import { healthKey } from "./snapshot.ts";
import type { Excluded, RankInput } from "./types.ts";

export type Pair = { credential: CredentialView; target: Target };

/**
 * Every provider whose own dialect this request carries.
 *
 * A provider-defined tool or a provider-native block is owned end to end by the
 * adapter that produced it, so it routes only back to that adapter. An empty set
 * means the request is portable and every target is a candidate; a set of one is
 * the ordinary case and names the only provider that may serve it. **A set of
 * two or more means nothing can**, and that is the case the singular version of
 * this function could not express.
 *
 * History counts, not just the tool list. A client that ran a web search on one
 * turn replays the `server_tool_use` and its result on the next, often without
 * redeclaring the tool — routing that turn elsewhere would drop the blocks and
 * change the conversation the model sees. Asking here, before dispatch, is what
 * turns "no target can do this" into one clear routing failure rather than an
 * adapter discovering it mid-encode.
 */
export function requiredProviders(request: ChatRequest): ReadonlySet<ProviderId> {
  // **Every** owner, not the first. This returned the first provider-owned item
  // it found — `find` short-circuiting before the history scan, and the history
  // scan returning on its first hit — which turned a *requirement* into a
  // *pick*: a request naming two providers was admitted to targets of one, and
  // the other's blocks were then encoded by an adapter that does not own them.
  // The correct answer for such a request is that nothing can serve it, which is
  // what a set of size two produces at the call site below.
  //
  // Not reachable through today's ingress — `ingress/anthropicTools.ts` and
  // `ingress/anthropic.ts` both write `provider: "anthropic"` as a literal, and
  // a foreign block replayed by a client fails `ANTHROPIC_NATIVE_BLOCK_TYPES` —
  // so first-match and all-match coincide for every live request. They stop
  // coinciding the moment a plugin codec emits `providerNative` blocks, which is
  // the capability this branch exists to enable. Fixed now because the two wire
  // encoders that dropped their own self-checks name this function as the reason
  // they are safe, and a rule three call sites depend on should be the rule they
  // think it is.
  const owners = new Set<ProviderId>();
  for (const tool of request.tools ?? []) {
    if (tool.kind === "provider") owners.add(tool.provider);
  }
  // `system` as well as `messages`, and it was missed. `ChatRequest.system` is a
  // full `ContentBlock[]`, so it can hold a `providerNative` block exactly as a
  // message can — and a request whose system prompt carried one routed to any
  // provider at all, with an empty exclusion list. Same reachability class as
  // the two-owner case above: no ingress builds it today, and the reason to
  // close it is that this function's own first line claims to name *every*
  // provider the request carries.
  for (const block of request.system ?? []) {
    if (block.type === "providerNative") owners.add(block.provider);
  }
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "providerNative") owners.add(block.provider);
    }
  }
  return owners;
}

/**
 * What the request actually needs, so targets can be filtered on it.
 *
 * Reads **every** position a `ContentBlock` can occupy, which for images means
 * `system` as well as `messages`. It did not, and the miss is worth recording
 * because of where it sat: eleven lines below `requiredProviders`, in the same
 * file, edited in the same commit that taught *that* function to read `system`.
 * The fix reasoned carefully about completeness inside one function and never
 * looked at the one underneath it.
 *
 * The consequence was reachable with no plugin at all — `ingress/openai.ts`
 * routes a system message's parts through `contentBlocks()`, which emits an
 * `ImageBlock` — so an image in a system prompt routed to an `images:false`
 * target with an empty exclusion list, every encoder dropped it silently, and
 * the request logged as a clean success. The identical image one message later
 * was correctly refused with `capability:images`.
 *
 * `test/blockPositions.test.ts` is what keeps this true now: a matrix of
 * positions against predicates, so a predicate reading one and not the other
 * fails a cell rather than waiting for a review to look at the right pair.
 */
export function requiredCapabilities(request: ChatRequest): ProviderCapabilities {
  const hasImage = (blocks: readonly ContentBlock[]): boolean =>
    blocks.some((b) => b.type === "image");
  const images =
    hasImage(request.system ?? []) || request.messages.some((m) => hasImage(m.content));
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
  // The real registry unless a caller describes a different installation. See
  // `RankInput.providers` for why this is a parameter and not a module read.
  const providers = input.providers ?? PROVIDER_DESCRIPTORS;
  const { breakerThreshold, breakerCooldownMs } = snapshot.settings;
  const need = requiredCapabilities(request);
  const required = requiredProviders(request);

  const pairs: Pair[] = [];
  const excluded: Excluded[] = [];

  for (const target of model.targets) {
    // A target naming a provider this installation does not have. `Target` comes
    // back from `virtual_models.targets` as unvalidated JSON, so this is an
    // ordinary state now that a provider can arrive from `<root>/plugins/`: the
    // plugin was removed, the database was restored onto a different install, or
    // someone edited a row.
    //
    // Read at call time, never from a module-scope key list — `loadPlugins()`
    // runs long after import, so a snapshot taken there would call a working
    // provider missing. Emitted once per target, `kind: "target"` because it is
    // a fact about the target and names no account. First guard in the loop, so
    // a target that is also pinned reports the provider rather than reporting
    // `pin:missing` about an account that could not have served it either way.
    // `Object.hasOwn` because `providers` may be a caller's own object literal
    // now, not only the null-prototype registry. Against an ordinary literal a
    // plain index check is skipped outright for `constructor` and `toString`,
    // producing the empty exclusion list this guard exists to prevent — see the
    // note in `resolve.ts`.
    if (!Object.hasOwn(providers, target.provider)) {
      excluded.push({
        kind: "target",
        credentialId: "",
        model: target.model,
        reason: "provider:missing",
      });
      continue;
    }

    // A provider-native block or provider-defined tool routes only to the
    // provider that owns it. Read off the request's own data rather than from a
    // table of who accepts whose dialect: the block records its producer, so the
    // question is one comparison and needs no per-provider entry to stay correct.
    // `size === 1 && !has` rather than `!has`, so a request naming *two*
    // providers excludes every target rather than admitting the ones matching
    // whichever was seen first. A request no single provider owns is a request
    // nothing can serve, and the honest answer is an empty candidate list with a
    // reason on every target — not a candidate that will mis-encode.
    const missing =
      required.size > 1 || (required.size === 1 && !required.has(target.provider))
        ? "providerNative"
        : (["tools", "images", "reasoning"] as const).find(
            (cap) => need[cap] && !target.capabilities[cap],
          );

    // Only the provider mismatch is a fact about the provider rather than about
    // the account, so only it is redacted downstream. See `Excluded.kind`.
    const missingKind: Excluded["kind"] = missing === "providerNative" ? "target" : "account";

    // Whether the account a pinned target names was reachable at all. Set once
    // the pin matches a credential that already cleared the provider and
    // endpoint checks, so a pin at another provider's account counts as unseen
    // rather than as a way around those checks.
    let pinSeen = false;
    // Whether any account of this provider existed at all. Distinguishes "the
    // operator has not connected this provider" — silent by design, and visible
    // as an empty pool — from "accounts exist and the endpoint rule refused
    // every one", which is a target nothing can serve and which otherwise
    // produces no `excluded` row at all. See the note below `pinSeen`'s use.
    let providerSeen = false;

    // Whether any account got past `servesTarget` for this target. Distinct from
    // `providerSeen`: accounts dropped later — disabled, expired, breakered,
    // quota-spent — each leave their own row, so only a target nothing *serves*
    // is unexplained.
    let servedAny = false;

    for (const credential of snapshot.credentials) {
      if (credential.provider === target.provider) providerSeen = true;
      // Provider, custom endpoint and pin in one question, from the single copy
      // of that rule in `@omni/store/types`. Silent: an account this excludes
      // was never a candidate for the target, and one `excluded` row per
      // sibling would bury the reasons describing the pinned account itself.
      if (!servesTarget(target, credential)) continue;
      servedAny = true;
      pinSeen = target.credentialId !== undefined;

      const drop = (reason: string, kind: Excluded["kind"] = "account"): void => {
        excluded.push({ kind, credentialId: credential.id, model: target.model, reason });
      };

      if (missing !== undefined) {
        drop(`capability:${missing}`, missingKind);
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

    // The same argument as `pin:missing`, for the rule beside the pin. An
    // endpoint mismatch drops every credential silently, so a target naming an
    // endpoint no account is at — or carrying a corrupt one after an
    // unvalidated read — fails every request with nothing to explain it, and
    // `omni doctor` only inspects pinned targets. Emitted once per target, and
    // only when accounts of the provider existed: a provider with no accounts
    // at all is an empty pool, which is already legible.
    if (target.credentialId === undefined && providerSeen && !servedAny) {
      excluded.push({
        kind: "target",
        credentialId: "",
        model: target.model,
        reason: "endpoint:unmatched",
      });
    }

    // A pin at an account that was deleted, or that belongs to another
    // provider, drops every credential silently and would otherwise fail the
    // request with nothing in `excluded` to explain it.
    if (target.credentialId !== undefined && !pinSeen) {
      excluded.push({
        kind: "account",
        credentialId: target.credentialId,
        model: target.model,
        reason: "pin:missing",
      });
    }
  }

  return { pairs, excluded };
}
