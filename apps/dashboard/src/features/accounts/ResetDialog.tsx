import { useResetCredits } from "../../api/queries.ts";
import type { Credential } from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { formatRelative } from "../../lib/format.ts";

/**
 * Confirms spending one banked quota reset on an account.
 *
 * The list is read when the dialog opens, never before: reading reaches the
 * provider. The confirm button stays disabled until a fresh list says a credit
 * is available, and the credit named is the one shown: a repeat then finds it
 * spent instead of spending the next one.
 */
export function ResetDialog({
  credential,
  busy,
  onOpenChange,
  onConfirm,
}: {
  credential: Credential | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (credential: Credential, creditId: string) => void;
}) {
  const credits = useResetCredits(credential?.id ?? null);
  const now = Date.now();
  const soonest = (credits.data?.credits ?? [])
    .filter((c) => c.status === "available")
    .sort(
      (a, b) =>
        (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY),
    )[0];
  // Counted from the rows the credit is picked from, never a cached or failed read.
  const available = credits.isError || credits.isFetching ? 0 : (credits.data?.available ?? 0);

  const body =
    credential === null
      ? ""
      : credits.isFetching
        ? "Reading the reset credits this account holds…"
        : credits.isError
          ? `Could not read reset credits for "${credential.label}".`
          : available === 0
            ? `"${credential.label}" has no reset credits available.`
            : `Spend one of ${available} reset ${available === 1 ? "credit" : "credits"} on "${credential.label}"? ` +
              "Its usage windows go back to zero at the provider, and the credit cannot be returned." +
              (soonest?.expiresAt == null
                ? ""
                : ` The credit spent is the one expiring soonest (${formatRelative(soonest.expiresAt, now)}).`);

  return (
    <Confirm
      open={credential !== null}
      onOpenChange={onOpenChange}
      title="Reset quota"
      body={body}
      confirmLabel="Spend reset"
      busy={busy || soonest === undefined || available === 0}
      onConfirm={() => {
        if (credential !== null && soonest !== undefined && available > 0) {
          onConfirm(credential, soonest.id);
        }
      }}
    />
  );
}
