import { useState } from "react";
import styled from "styled-components";
import { useModels, useSetKeyLimits } from "../../api/queries.ts";
import type { ApiKeySummary, LimitConfig } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Legend, Row, Stack } from "../../ui/primitives.ts";
import { Autocomplete } from "../../ui/Select.tsx";
import { describeError } from "../../ui/States.tsx";
import { LimitFields } from "./LimitFields.tsx";
import {
  draftFrom,
  draftToLimits,
  type OverrideDraft,
  overridesFrom,
  overridesToModels,
} from "./limits.ts";

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Broken = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

const SectionTitle = styled.h3`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.color.ink};
`;

/** One override's block, ruled off from the next so its fields read as one. */
const Override = styled(Stack)`
  padding-top: ${({ theme }) => theme.space(2)};
  border-top: 1px solid ${({ theme }) => theme.color.rule};
`;

const Hint = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
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
  const models = useModels();
  const [draft, setDraft] = useState(() => draftFrom(apiKey?.limits ?? {}));
  // Kept beside the key-wide draft rather than inside it, and always sent back:
  // an edit to the key-wide fields that dropped the overrides would remove
  // every per-model ceiling without the operator touching one.
  const [overrides, setOverrides] = useState(() => overridesFrom(apiKey?.limits ?? {}));
  const [added, setAdded] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const suggestions = (models.data ?? []).map((entry) => ({ value: entry.id, label: entry.id }));

  const update = (id: string, patch: Partial<OverrideDraft>) => {
    setOverrides((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const submit = () => {
    if (apiKey === null) return;
    const result = draftToLimits(draft);
    if ("problem" in result) {
      setProblem(result.problem);
      return;
    }
    const perModel = overridesToModels(overrides);
    if ("problem" in perModel) {
      setProblem(perModel.problem);
      return;
    }
    // `models` only when there is one: no overrides has one spelling, absent.
    const limits: LimitConfig =
      Object.keys(perModel.models).length === 0
        ? result.limits
        : { ...result.limits, models: perModel.models };
    setProblem(null);
    save.mutate(
      { id: apiKey.id, limits },
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

        <Stack $gap={2}>
          <SectionTitle>Per-model overrides</SectionTitle>
          <Legend>
            A stricter ceiling for one model, matched exactly against the model a request names. It
            stacks with the limits above: a request for that model must pass both.
          </Legend>
          {overrides.map((row) => {
            const model = row.model;
            const name = model.trim().length === 0 ? "a new model" : model;
            // A hint, not an error: an override the key cannot reach is
            // harmless, and refusing it would make unrelated edits unsavable
            // the day a model is renamed.
            const unreachable =
              model.trim().length > 0 &&
              apiKey?.modelAllowlist !== null &&
              apiKey?.modelAllowlist !== undefined &&
              !apiKey.modelAllowlist.includes(model);
            return (
              <Override key={row.id} $gap={2} role="group" aria-label={`Override for ${name}`}>
                <Row $gap={2} $align="flex-end">
                  <Field label="Model">
                    {(props) => (
                      // Free text, with what the installation serves offered as
                      // you type: an override may name a model before it is
                      // configured.
                      <Autocomplete
                        {...props}
                        disabled={save.isPending}
                        value={row.model}
                        placeholder="model name"
                        suggestions={suggestions}
                        onValueChange={(model) => update(row.id, { model })}
                      />
                    )}
                  </Field>
                  <Button
                    type="button"
                    $variant="ghost"
                    disabled={save.isPending}
                    aria-label={`Remove override for ${name}`}
                    onClick={() => setOverrides((rows) => rows.filter((r) => r.id !== row.id))}
                  >
                    Remove
                  </Button>
                </Row>
                {unreachable ? (
                  <Hint>
                    {model} is not in this key's allowed models, so this override applies to no
                    request until it is.
                  </Hint>
                ) : null}
                <LimitFields
                  draft={row.slots}
                  onChange={(slots) => update(row.id, { slots })}
                  disabled={save.isPending}
                />
              </Override>
            );
          })}
          <div>
            <Button
              type="button"
              disabled={save.isPending}
              onClick={() => {
                setOverrides((rows) => [
                  ...rows,
                  { id: `added-${added}`, model: "", stored: null, slots: draftFrom({}) },
                ]);
                setAdded((count) => count + 1);
              }}
            >
              Add model override
            </Button>
          </div>
        </Stack>

        {problem === null ? null : <Problem role="alert">{problem}</Problem>}
      </Stack>
    </Modal>
  );
}
