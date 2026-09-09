import { useState } from "react";
import styled from "styled-components";
import { useSetKeyExpiry } from "../../api/queries.ts";
import type { ApiKeySummary } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Field, Input } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";
import { fromLocalInput, keyState, toLocalInput } from "./expiry.ts";

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Lapsed = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

export type EditExpiryDialogProps = {
  /** The key being edited, or null when the dialog is closed. */
  apiKey: ApiKeySummary | null;
  onOpenChange: (open: boolean) => void;
};

/**
 * Changes an existing key's expiry, or takes it away.
 *
 * The third field editable after minting, and the only edit that can be undone:
 * an instant already in the past means "expire this key now", and clearing the
 * field brings the key back — which revoking deliberately cannot. So a past
 * date is submitted rather than refused, and there is no `min` on the input.
 *
 * A native `datetime-local`, not a picker library: the platform's own control
 * gives keyboard entry, locale formatting and the operator's own timezone for
 * free, and a date field is not worth a dependency.
 *
 * Mounted with a `key` of the row's id by the board, so opening a second key
 * starts from that key's expiry rather than whatever was typed into the last.
 */
export function EditExpiryDialog({ apiKey, onOpenChange }: EditExpiryDialogProps) {
  const save = useSetKeyExpiry();
  const [value, setValue] = useState(() => toLocalInput(apiKey?.expiresAt ?? null));
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    if (apiKey === null) return;
    const parsed = fromLocalInput(value);
    if ("problem" in parsed) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    save.mutate(
      // Sent whether it is an instant or `null`, never omitted: an absent field
      // is a `BAD_REQUEST`, because saying nothing and saying "never" are
      // different instructions.
      { id: apiKey.id, expiresAt: parsed.at },
      {
        onSuccess: () => onOpenChange(false),
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  const lapsed = apiKey !== null && keyState(apiKey, Date.now()) === "expired";

  return (
    <Modal
      open={apiKey !== null}
      onOpenChange={onOpenChange}
      title="Edit expiry"
      description={
        apiKey === null
          ? undefined
          : `When "${apiKey.label}" stops being accepted. Leave it blank for never.`
      }
      width="480px"
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" $variant="primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? "Saving…" : "Save expiry"}
          </Button>
        </>
      }
    >
      <Stack $gap={3}>
        {/* Reachable on an already-expired key on purpose: this is the only way
            back, and the dialog says so rather than leaving the operator to
            infer it from an empty field. */}
        {lapsed ? (
          <Lapsed role="status">
            This key has expired and the gateway is refusing it. Moving the date forward, or
            clearing it, brings it back.
          </Lapsed>
        ) : null}

        <Field
          label="Expires"
          hint="Your local time. Blank means the key never expires; a date already past expires it now."
        >
          {(props) => (
            <Input
              {...props}
              type="datetime-local"
              value={value}
              disabled={save.isPending}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>

        {problem === null ? null : <Problem role="alert">{problem}</Problem>}
      </Stack>
    </Modal>
  );
}
