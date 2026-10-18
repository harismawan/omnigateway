import { GUARDRAIL_POLICY_MAX_CHARS } from "@omni/store/types";
import { useState } from "react";
import styled from "styled-components";
import { useSetKeyGuardrail, useSettings } from "../../api/queries.ts";
import type { ApiKeySummary } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Field, Textarea } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Row, Spacer, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Unset = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

const Note = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const Count = styled.span<{ $over: boolean }>`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ $over, theme }) => ($over ? theme.color.down : theme.color.inkDim)};
`;

export type EditGuardrailDialogProps = {
  /** The key being edited, or null when the dialog is closed. */
  apiKey: ApiKeySummary | null;
  onOpenChange: (open: boolean) => void;
};

/**
 * Sets or clears what a key may be used for.
 *
 * The fourth field editable after minting. The text is sent whole and trimmed
 * by the gateway; clearing is its own button rather than an empty save, because
 * the route refuses an empty policy — "no guardrail" is spelled `null`, and a
 * field emptied by accident must not silently lift a restriction.
 *
 * Warns when no classifier model is set: a key carrying a policy is refused on
 * every request until one is, which is the fail-closed rule doing its job and
 * the last thing an operator expects from saving a sentence.
 *
 * Mounted with a `key` of the row's id by the board, so opening a second key
 * starts from that key's policy.
 */
export function EditGuardrailDialog({ apiKey, onOpenChange }: EditGuardrailDialogProps) {
  const save = useSetKeyGuardrail();
  const settings = useSettings();
  const [value, setValue] = useState(() => apiKey?.guardrailPolicy ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const length = value.trim().length;
  const over = length > GUARDRAIL_POLICY_MAX_CHARS;

  const send = (policy: string | null) => {
    if (apiKey === null) return;
    setProblem(null);
    save.mutate(
      { id: apiKey.id, policy },
      {
        onSuccess: () => onOpenChange(false),
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  const submit = () => {
    if (length === 0) {
      setProblem("Write a policy, or use Remove policy to stop judging this key.");
      return;
    }
    if (over) {
      setProblem(`A policy is at most ${GUARDRAIL_POLICY_MAX_CHARS} characters.`);
      return;
    }
    send(value);
  };

  const unconfigured = settings.data !== undefined && settings.data.guardrailModel === null;

  return (
    <Modal
      open={apiKey !== null}
      onOpenChange={onOpenChange}
      title="Edit usage policy"
      description={
        apiKey === null
          ? undefined
          : `What "${apiKey.label}" may be used for. Each request is judged against it by the classifier model before it is routed.`
      }
      width="560px"
      footer={
        <>
          {apiKey?.guardrailPolicy === null || apiKey === null ? null : (
            <Button
              type="button"
              $variant="danger"
              disabled={save.isPending}
              onClick={() => send(null)}
            >
              Remove policy
            </Button>
          )}
          <Spacer />
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" $variant="primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? "Saving…" : "Save policy"}
          </Button>
        </>
      }
    >
      <Stack $gap={3}>
        {unconfigured ? (
          <Unset role="status">
            No classifier model is set in Settings, so every request from a key with a policy is
            refused until one is.
          </Unset>
        ) : null}

        <Field
          label="Policy"
          hint="Plain language, e.g. Only software engineering and office documents. Refuse roleplay and personal content."
        >
          {(props) => (
            <Textarea
              {...props}
              value={value}
              rows={6}
              disabled={save.isPending}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
        <Row>
          <Note>
            A guardrail against ordinary misuse, not a security boundary: a determined client can
            talk a classifier round.
          </Note>
          <Spacer />
          <Count $over={over}>
            {length} / {GUARDRAIL_POLICY_MAX_CHARS}
          </Count>
        </Row>

        {problem === null ? null : <Problem role="alert">{problem}</Problem>}
      </Stack>
    </Modal>
  );
}
