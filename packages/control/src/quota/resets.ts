import { GatewayError } from "@omni/ir";
import type { CredentialView } from "@omni/store";
import type { OAuthProvider, ResetCredits, ResetRedeemed } from "../oauth/types.ts";
import {
  type PollerDeps,
  PROBE_LOCK_PREFIX,
  PROBE_LOCK_TTL_MS,
  PROBE_LOCK_WAIT_MS,
  probe,
  usageSecretsFor,
} from "./poll.ts";

/**
 * Banked quota resets: list them, and spend one.
 *
 * A provider that grants resets (Codex, today) declares `resetCredits` and
 * `redeemReset` on its OAuth flow. Every other account answers `BAD_REQUEST`
 * rather than an empty list, because "this provider has no such thing" and
 * "this account has none left" are different facts.
 */
export type RedeemResetRequest = { credentialId: string; creditId?: string | undefined };

export type RedeemResetResult = {
  credentialId: string;
  creditId: string;
  windowsReset: number | null;
  /** Whether the follow-up quota read landed; false leaves the old meter until the next poll. */
  quotaRefreshed: boolean;
};

type Resettable = {
  credential: CredentialView;
  list: NonNullable<OAuthProvider["resetCredits"]>;
  redeem: NonNullable<OAuthProvider["redeemReset"]>;
};

async function resettable(deps: PollerDeps, credentialId: string): Promise<Resettable> {
  const credential = await deps.store.credentials.get(credentialId.trim());
  if (credential === null) throw new GatewayError("BAD_REQUEST", "no such credential");
  const provider = deps.providers[credential.provider];
  const list = provider?.resetCredits;
  const redeem = provider?.redeemReset;
  if (credential.authType !== "oauth" || list === undefined || redeem === undefined) {
    throw new GatewayError("BAD_REQUEST", "this account's provider has no quota resets");
  }
  return { credential, list, redeem };
}

async function listFor(deps: PollerDeps, r: Resettable): Promise<ResetCredits> {
  const secrets = await usageSecretsFor(deps, r.credential);
  const read = await r.list(secrets, { http: deps.http, now: deps.now }, r.credential.providerData);
  if (read === null) {
    throw new GatewayError("UPSTREAM", "provider answered the reset list with nothing usable", {
      gatewayAuthored: true,
    });
  }
  return read;
}

export async function listResetCredits(
  deps: PollerDeps,
  credentialId: string,
): Promise<ResetCredits & { credentialId: string }> {
  const r = await resettable(deps, credentialId);
  return { credentialId: r.credential.id, ...(await listFor(deps, r)) };
}

/**
 * Spends one reset, then re-reads quota so the router stops excluding the
 * account now rather than at the next poll.
 *
 * Without a `creditId`, the available credit that expires first is spent —
 * the one that would otherwise be lost soonest. A caller that must not spend
 * twice on a repeat (the console) names the credit it showed; a repeat then
 * finds it spent and answers `CONFLICT`.
 *
 * The whole list → redeem → re-read runs under the account's probe lock, the
 * one every quota poll takes: two redeems cannot pick from the same list, and
 * no poll can write a pre-reset reading over the post-reset one. A lock that
 * cannot be taken refuses the redeem rather than spending unguarded.
 */
export async function redeemResetCredit(
  deps: PollerDeps,
  request: RedeemResetRequest,
): Promise<RedeemResetResult> {
  const r = await resettable(deps, request.credentialId);
  // ponytail: the probe lock's 60s TTL bounds list + redeem + re-read; each
  // step is clamped (15s usage, 30s token), so a stalled refresh could outlive it.
  return deps.coord.mutex.withLock(
    PROBE_LOCK_PREFIX + r.credential.id,
    PROBE_LOCK_TTL_MS,
    PROBE_LOCK_WAIT_MS,
    () => redeemLocked(deps, r, request),
  );
}

async function redeemLocked(
  deps: PollerDeps,
  r: Resettable,
  request: RedeemResetRequest,
): Promise<RedeemResetResult> {
  const available = (await listFor(deps, r)).credits
    .filter((c) => c.status === "available")
    .sort(
      (a, b) =>
        (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY),
    );
  const credit =
    request.creditId === undefined
      ? available[0]
      : available.find((c) => c.id === request.creditId);
  if (credit === undefined) {
    throw new GatewayError(
      "CONFLICT",
      request.creditId === undefined
        ? "no reset credit is available for this account"
        : "that reset credit is not available",
    );
  }

  const secrets = await usageSecretsFor(deps, r.credential);
  const { windowsReset }: ResetRedeemed = await r.redeem(
    secrets,
    { http: deps.http, now: deps.now },
    r.credential.providerData,
    credit.id,
    crypto.randomUUID(),
  );

  let quotaRefreshed = false;
  try {
    quotaRefreshed = (await probe(deps, r.credential)) !== null;
  } catch {
    // The reset happened; a failed re-read only leaves the meter stale until
    // the next poll, and must not report the redeem as failed.
  }
  return { credentialId: r.credential.id, creditId: credit.id, windowsReset, quotaRefreshed };
}
