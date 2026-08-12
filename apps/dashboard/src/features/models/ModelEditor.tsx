import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import styled from "styled-components";
import { useCredentials, useDeleteModel, useSaveModel } from "../../api/queries.ts";
import type { Strategy, VirtualModel } from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { Button } from "../../ui/Button.tsx";
import { Field, Input, Select } from "../../ui/Field.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, Spacer, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import {
  blankModel,
  blankTarget,
  type ModelDraft,
  parseDraft,
  STRATEGIES,
  toDraft,
} from "./draft.ts";
import { TargetEditor } from "./TargetEditor.tsx";

const Blurb = styled.p`
  font-size: 11.5px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Saved = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.ok};
`;

const AliasRow = styled(Row)`
  gap: 8px;
`;

export type ModelEditorProps = {
  /** The model being edited, or null to compose a new one. */
  model: VirtualModel | null;
  onSaved: (id: string) => void;
  onDeleted: () => void;
};

/**
 * Creating and editing are one screen because the control API has one verb for
 * both: `PUT /api/models/:id` replaces whatever was there. The only difference
 * is that an existing model's name is fixed — renaming would leave the old row
 * behind under its old id.
 */
export function ModelEditor({ model, onSaved, onDeleted }: ModelEditorProps) {
  const [draft, setDraft] = useState<ModelDraft>(() =>
    model === null ? blankModel() : toDraft(model),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [doomed, setDoomed] = useState(false);

  const save = useSaveModel();
  const remove = useDeleteModel();
  const credentials = useCredentials();
  const endpoints = (credentials.data ?? [])
    .filter((credential) => credential.provider === "custom")
    .map((credential) => ({
      id: String(credential.providerData.endpointId ?? ""),
      label: String(
        credential.providerData.endpointLabel ?? credential.providerData.endpointId ?? "",
      ),
    }))
    .filter(
      (endpoint, index, all) =>
        endpoint.id.length > 0 &&
        all.findIndex((candidate) => candidate.id === endpoint.id) === index,
    );

  // Keyed on the id, not the object: the models query refetches in the
  // background, and a new object for the same model must not discard an edit
  // the operator is in the middle of.
  const editing = model?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id by design.
  useEffect(() => {
    setDraft(model === null ? blankModel() : toDraft(model));
    setProblem(null);
    setSaved(false);
  }, [editing]);

  const strategy = STRATEGIES.find((entry) => entry.id === draft.strategy);

  const submit = () => {
    setSaved(false);
    const parsed = parseDraft(draft);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    save.mutate(parsed.model, {
      onSuccess: () => {
        setSaved(true);
        onSaved(parsed.model.id);
      },
      onError: (error) => setProblem(describeError(error)),
    });
  };

  return (
    <>
      <Module
        legend={model === null ? "New model" : "Edit model"}
        meta={model === null ? undefined : model.id}
        actions={
          <>
            {model === null ? null : (
              <Button type="button" $variant="danger" $size="sm" onClick={() => setDoomed(true)}>
                Delete
              </Button>
            )}
            <Button
              type="button"
              $variant="primary"
              $size="sm"
              disabled={save.isPending}
              onClick={submit}
            >
              {save.isPending ? "Saving…" : model === null ? "Create model" : "Save changes"}
            </Button>
          </>
        }
      >
        <Stack $gap={3}>
          <Field
            label="Model name"
            hint={
              model === null
                ? "What clients send as the model. Anything not listed here is rejected."
                : "Fixed once created. To rename, create a model under the new name and delete this one."
            }
          >
            {(props) => (
              <Input
                {...props}
                value={draft.id}
                disabled={model !== null}
                placeholder="fast"
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
              />
            )}
          </Field>

          <Field label="Routing strategy">
            {(props) => (
              <Select
                {...props}
                value={draft.strategy}
                onChange={(event) =>
                  setDraft({ ...draft, strategy: event.target.value as Strategy })
                }
              >
                {STRATEGIES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {strategy === undefined ? null : <Blurb>{strategy.blurb}</Blurb>}

          <AliasRow>
            <Toggle
              checked={draft.isAlias}
              label="This model is an alias for a provider model name"
              onCheckedChange={(isAlias) => setDraft({ ...draft, isAlias })}
            />
            <Stack $gap={0}>
              <Legend as="span">Alias</Legend>
              <Blurb>Mark this when the name mirrors a provider's own model name.</Blurb>
            </Stack>
          </AliasRow>

          <Stack $gap={2}>
            <Row>
              <Legend>Targets</Legend>
              <Spacer />
              <Button
                type="button"
                $size="sm"
                onClick={() =>
                  setDraft({
                    ...draft,
                    targets: [
                      ...draft.targets,
                      blankTarget(draft.targets.at(-1)?.provider ?? "anthropic"),
                    ],
                  })
                }
              >
                <Plus />
                Add target
              </Button>
            </Row>

            {draft.targets.map((target, index) => (
              <TargetEditor
                key={target.key}
                target={target}
                index={index}
                removable={draft.targets.length > 1}
                endpoints={endpoints}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    targets: draft.targets.map((entry) =>
                      entry.key === target.key ? next : entry,
                    ),
                  })
                }
                onRemove={() =>
                  setDraft({
                    ...draft,
                    targets: draft.targets.filter((entry) => entry.key !== target.key),
                  })
                }
              />
            ))}
          </Stack>

          {problem === null ? null : <Problem role="alert">{problem}</Problem>}
          {saved && problem === null ? <Saved role="status">Saved.</Saved> : null}
        </Stack>
      </Module>

      <Confirm
        open={doomed}
        onOpenChange={setDoomed}
        title="Delete model"
        body={
          model === null
            ? ""
            : `Deleting "${model.id}" makes it unroutable. Clients asking for it will get a model-unavailable error, and any key allowlisting it keeps a name that no longer resolves.`
        }
        confirmLabel="Delete model"
        busy={remove.isPending}
        onConfirm={() => {
          if (model === null) return;
          remove.mutate(model.id, {
            onSuccess: () => {
              setDoomed(false);
              onDeleted();
            },
            onError: (error) => {
              setDoomed(false);
              setProblem(describeError(error));
            },
          });
        }}
      />
    </>
  );
}
