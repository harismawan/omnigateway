import { useState } from "react";
import styled from "styled-components";
import { useSetKeyLimits } from "../../api/queries.ts";
import type { ApiKeySummary } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";
import { LimitFields } from "./LimitFields.tsx";
import { draftFrom, draftToLimits } from "./limits.ts";

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Broken = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

export type EditLimitsDialogProps = {
  /** The key being edited, or null when the dialog is closed. */
  apiKey: ApiKeySummary | null;
  onOpenChange: (open: boolean) => void;
};

/**
 * Changes an existing key's limits.
 *
 * Editable after creation, unlike `bodyLoggingOptOut`, and the distinction is
 * deliberate: an opt-out is a promise to whoever holds the key, while a limit is
 * the operator's own ceiling on their own installation. A weekly spend cap that
 * cannot be adjusted without minting a new key and redeploying every client is a
 * cap that gets set to unlimited instead.
 *
 * Mounted with a `key` of the row's id, so opening a second key starts from that
 * key's matrix rather than from whatever was typed into the last one.
 */
export function EditLimitsDialog({ apiKey, onOpenChange }: EditLimitsDialogProps) {
  const save = useSetKeyLimits();
  const [draft, setDraft] = useState(() => draftFrom(apiKey?.limits ?? {}));
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    if (apiKey === null) return;
    const result = draftToLimits(draft);
    if ("problem" in result) {
      setProblem(result.problem);
      return;
    }
    setProblem(null);
    save.mutate(
      { id: apiKey.id, limits: result.limits },
      {
        onSuccess: () => onOpenChange(false),
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  return (
    <Modal
      open={apiKey !== null}
      onOpenChange={onOpenChange}
      title="Edit limits"
      description={
        apiKey === null
          ? undefined
          : `What "${apiKey.label}" may do per minute, per five hours, and per week. Every field is a ceiling; blank is no limit.`
      }
      width="640px"
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" $variant="primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? "Saving…" : "Save limits"}
          </Button>
        </>
      }
    >
      <Stack $gap={3}>
        {/* An unreadable column is why this dialog is reachable on a broken row
            at all: the gateway refuses the key until it is replaced, and saving
            from here is the repair. Starting from blank fields is honest — the
            stored value cannot be shown because it cannot be read. */}
        {apiKey?.limits === null ? (
          <Broken role="status">
            The stored limits for this key cannot be read, so the gateway refuses it. Saving here
            replaces them.
          </Broken>
        ) : null}

        <LimitFields draft={draft} onChange={setDraft} disabled={save.isPending} />

        {problem === null ? null : <Problem role="alert">{problem}</Problem>}
      </Stack>
    </Modal>
  );
}
