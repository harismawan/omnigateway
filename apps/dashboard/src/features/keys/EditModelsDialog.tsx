import { useState } from "react";
import styled from "styled-components";
import { useModels, useSetKeyModels } from "../../api/queries.ts";
import type { ApiKeySummary } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Legend, Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

export type EditModelsDialogProps = {
  /** The key being edited, or null when the dialog is closed. */
  apiKey: ApiKeySummary | null;
  onOpenChange: (open: boolean) => void;
};

/**
 * Changes an existing key's allowed models.
 *
 * Editable after creation for the same reason the limit matrix is: an allowlist
 * that cannot be adjusted without minting a new key and redeploying every
 * client is one that gets set to unrestricted instead. The list is sent whole —
 * `null` (every model) and `[]` (none) are opposite facts, so the toggle and
 * the empty picker carry one spelling each and neither collapses into the other.
 *
 * Mounted with a `key` of the row's id by the board, so opening a second key
 * starts from that key's allowlist rather than whatever was checked last.
 */
export function EditModelsDialog({ apiKey, onOpenChange }: EditModelsDialogProps) {
  const save = useSetKeyModels();
  const models = useModels();

  const [unrestricted, setUnrestricted] = useState(apiKey?.modelAllowlist === null);
  const [allowed, setAllowed] = useState<string[]>(() =>
    apiKey?.modelAllowlist === null ? [] : (apiKey?.modelAllowlist ?? []),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const configured = (models.data ?? []).map((entry) => entry.id);

  const submit = () => {
    if (apiKey === null) return;
    setProblem(null);
    save.mutate(
      { id: apiKey.id, modelAllowlist: unrestricted ? null : allowed },
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
      title="Edit models"
      description={
        apiKey === null
          ? undefined
          : `Which models "${apiKey.label}" may ask the gateway for. Sent whole on save.`
      }
      width="640px"
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" $variant="primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? "Saving…" : "Save models"}
          </Button>
        </>
      }
    >
      <Stack $gap={3}>
        <Stack $gap={2}>
          <Row $gap={2}>
            <Toggle
              checked={unrestricted}
              label="Allow every model"
              onCheckedChange={(next) => {
                setUnrestricted(next);
                if (next) setAllowed([]);
              }}
            />
            <Legend as="span">Allow every model</Legend>
          </Row>

          {unrestricted ? null : (
            <ModelPicker
              configured={configured}
              checked={allowed}
              onChange={setAllowed}
              disabled={save.isPending}
            />
          )}
        </Stack>

        {problem === null ? null : <Problem role="alert">{problem}</Problem>}
      </Stack>
    </Modal>
  );
}
