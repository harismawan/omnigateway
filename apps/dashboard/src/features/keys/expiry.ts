// The gateway's own answer to "may this key be used now", imported for the same
// reason `draft.ts` imports `servesTarget`: a second copy of the boundary is
// free to drift from the one `/v1` enforces, and a key refused at `/v1` while
// the console calls it active is the failure this whole feature would otherwise
// ship.
import { keyUsable } from "@omni/store/types";
import type { ApiKeySummary } from "../../api/types.ts";

/**
 * The three states a key can be in, which is one more than the board used to
 * draw.
 *
 * An expired key is refused at `/v1` while looking untouched everywhere else,
 * so it needs a state of its own.
 */
export type KeyState = "active" | "expired" | "revoked";

/**
 * The label, derived from `keyUsable` rather than beside it.
 *
 * Three answers out of a function that returns two, with no second comparison:
 * the third comes from `revokedAt`, which is read here anyway to tell the two
 * ways of being unusable apart. Once that arm is taken, "not usable" can only
 * mean expired, so the boundary — exclusive, `expiresAt === now` is already
 * outside — is asked once, in the store.
 */
export function keyState(key: ApiKeySummary, now: number): KeyState {
  if (key.revokedAt !== null) return "revoked";
  return keyUsable(key, now) ? "active" : "expired";
}

/**
 * An epoch-ms instant as the `YYYY-MM-DDTHH:mm` a `datetime-local` input reads.
 *
 * Local wall time, because that is the only thing that control speaks — the
 * offset is subtracted before formatting, so an operator sees the instant on
 * their own clock rather than in UTC. Empty for `null`, which is how the field
 * spells "never".
 */
export function toLocalInput(at: number | null): string {
  if (at === null) return "";
  const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  // Outside `Date`'s ±8.64e15 range, which `keyExpirySchema` refuses but a
  // restored or hand-edited row can still carry. Blank, because a
  // `datetime-local` has no spelling for an instant it cannot hold; the
  // alternative is `toISOString` throwing a `RangeError` out of a `useState`
  // initialiser and taking the dialog down with it.
  if (Number.isNaN(local.getTime())) return "";
  return local.toISOString().slice(0, 16);
}

/**
 * The input's local wall time back as an epoch-ms instant, or a problem.
 *
 * Empty is `null` — "never" — which is how the expiry is cleared. Anything the
 * platform hands back that is not a date at all is reported rather than sent:
 * `NaN` in the body is refused by the route, but with a message about a number
 * rather than about the field the operator was typing in.
 *
 * A past instant is deliberately accepted. It means "expire this key now", and
 * unlike revoking it can be undone by clearing the field.
 */
export function fromLocalInput(value: string): { at: number | null } | { problem: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { at: null };
  // Bare date-times with no offset are parsed as local time, which is the same
  // clock the input displays.
  const at = new Date(trimmed).getTime();
  if (!Number.isFinite(at)) return { problem: `"${value}" is not a date` };
  return { at };
}
