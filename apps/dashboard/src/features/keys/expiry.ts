import type { ApiKeySummary } from "../../api/types.ts";

/**
 * The three states a key can be in, which is one more than the board used to
 * draw.
 *
 * An expired key is refused at `/v1` while looking untouched everywhere else,
 * so it needs a state of its own: a key that stopped working while the console
 * calls it active is the failure this whole feature would otherwise ship.
 */
export type KeyState = "active" | "expired" | "revoked";

/**
 * Mirrors `keyUsable` in `@omni/store/types`, which the gateway answers with.
 *
 * Restated rather than imported only because it returns three answers where the
 * store's returns two — this is a *label*, not a second copy of the rule, and
 * the boundary is the same exclusive one: `expiresAt` is when the key stops
 * being accepted, so the instant it names is already outside.
 */
export function keyState(key: ApiKeySummary, now: number): KeyState {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && key.expiresAt <= now) return "expired";
  return "active";
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
  return new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
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
