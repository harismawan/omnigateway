import { estimateInputTokens } from "@omni/ir";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  queryKeys,
  useActivatePromptVersion,
  useCreatePrompt,
  useDuplicatePrompt,
  useRemovePrompt,
  useSavePromptVersion,
  useUpdatePrompt,
} from "../../api/queries.ts";
import type { PromptView } from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { Button } from "../../ui/Button.tsx";
import { Field, Input, Textarea } from "../../ui/Field.tsx";
import { Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";
import { PromptVersionDiff } from "./PromptVersionDiff.tsx";

type Props = {
  detail?: PromptView;
  version?: string;
  disabled: boolean;
  /** Resolves only after the selected ID/version has committed. */
  onSaved: (id: string, version?: string) => Promise<void>;
  onRemoved: () => void;
};

/** Rebase clean fields only; keep conflicting local edits until explicitly replaced. */
function useSyncedField(remote: string) {
  const [field, setField] = useState({ value: remote, baseline: remote, conflict: false });
  if (remote !== field.baseline) {
    const dirty = field.value !== field.baseline;
    setField({
      value: dirty ? field.value : remote,
      baseline: remote,
      conflict: dirty && field.value !== remote,
    });
  }
  return [
    field.value,
    (value: string) => setField((previous) => ({ ...previous, value })),
    field.conflict && field.value !== remote,
  ] as const;
}

export function PromptEditor({ detail, version, disabled, onSaved, onRemoved }: Props) {
  const selected =
    version === undefined
      ? (detail?.versions.find((v) => v.version === detail.activeVersion) ?? detail?.versions[0])
      : detail?.versions.find((v) => String(v.version) === version);
  const [id, setId] = useState(detail?.id ?? "");
  const [persistedId, setPersistedId] = useState(detail?.id);
  const [name, setName, nameConflict] = useSyncedField(detail?.name ?? "");
  const [description, setDescription, descriptionConflict] = useSyncedField(
    detail?.description ?? "",
  );
  const [text, setText, textConflict] = useSyncedField(selected?.text ?? "");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copyId, setCopyId] = useState("");
  const [copyName, setCopyName] = useState("");
  const create = useCreatePrompt();
  const update = useUpdatePrompt();
  const saveVersion = useSavePromptVersion();
  const activate = useActivatePromptVersion();
  const duplicate = useDuplicatePrompt();
  const remove = useRemovePrompt();
  const client = useQueryClient();
  const readonly = disabled || busy || detail?.builtin === true;
  const conflicts = [
    nameConflict ? "Name" : null,
    descriptionConflict ? "Description" : null,
    textConflict ? "Prompt text" : null,
  ].filter((field) => field !== null);
  const unavailable = version !== undefined && selected === undefined;
  const run = async (action: () => Promise<void>) => {
    if (disabled || busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await action();
      setSaved(true);
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  const save = (activate: boolean) =>
    void run(async () => {
      if (detail?.builtin) return;
      const input = { text, note: note || null, activate };
      if (persistedId === undefined) {
        const result = await create.mutateAsync({
          id,
          name,
          description: description || null,
          ...input,
        });
        // Record success before any selection/refetch: retries must never recreate this slug.
        setPersistedId(result.id);
        await client.fetchQuery({
          queryKey: queryKeys.prompt(result.id),
          queryFn: async () => result,
          gcTime: 300_000,
        });
        await onSaved(result.id, String(result.versions[0]?.version ?? "1"));
      } else {
        const result = await saveVersion.mutateAsync({ id: persistedId, ...input });
        client.setQueryData<PromptView>(queryKeys.prompt(persistedId), (previous) =>
          previous
            ? {
                ...previous,
                activeVersion: input.activate ? result.version : previous.activeVersion,
                versions: [
                  result,
                  ...previous.versions.filter((v) => v.version !== result.version),
                ],
              }
            : previous,
        );
        await onSaved(persistedId, String(result.version));
      }
    });
  const chars = text.trimEnd().length;
  const tokens =
    selected?.text === text &&
    (selected.version === detail?.activeVersion ||
      (detail?.activeVersion === null && selected === detail.versions[0]))
      ? detail.estimatedTokens
      : estimateInputTokens({
          model: "",
          stream: false,
          messages: [],
          system: [{ type: "text", text }],
        });
  const assigned =
    detail !== undefined && (detail.assignments.global || detail.assignments.keyIds.length > 0);
  const reason =
    detail === undefined
      ? ""
      : `Cannot delete: assigned ${detail.assignments.global ? "globally" : ""}${detail.assignments.global && detail.assignments.keyIds.length ? " and " : ""}${detail.assignments.keyIds.length ? `to ${detail.assignments.keyIds.length} key${detail.assignments.keyIds.length === 1 ? "" : "s"}` : ""}. Inactive drafts also count.`;
  // Do not render today's history/diff text beside a missing historical selection.
  if (unavailable) return <p role="status">Version unavailable</p>;
  return (
    <Stack $gap={3}>
      {conflicts.length ? (
        <p role="alert">
          Changed remotely: {conflicts.join(", ")}. Your unsaved changes are preserved; review
          before saving.
        </p>
      ) : null}
      {unavailable ? (
        <p role="status">Version unavailable</p>
      ) : (
        <>
          {!detail ? (
            <Field label="ID">
              {(props) => (
                <Input
                  {...props}
                  value={id}
                  disabled={disabled || persistedId !== undefined}
                  readOnly={busy}
                  maxLength={40}
                  onChange={(e) => setId(e.target.value)}
                />
              )}
            </Field>
          ) : null}
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                value={name}
                readOnly={readonly}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Description">
            {(props) => (
              <Textarea
                {...props}
                value={description}
                readOnly={readonly}
                maxLength={500}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          {detail && !detail.builtin ? (
            <Button
              disabled={disabled || busy}
              onClick={() =>
                void run(async () => {
                  await update.mutateAsync({
                    id: detail.id,
                    name,
                    description: description || null,
                  });
                })
              }
            >
              Save metadata
            </Button>
          ) : null}
          <Field label="Prompt text">
            {(props) => (
              <Textarea
                {...props}
                value={text}
                readOnly={readonly}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
          <p role="status">
            {chars} characters / 16,000 · {tokens} estimated tokens
          </p>
          {chars > 16000 ? <p role="alert">Prompt text exceeds 16,000 characters.</p> : null}
          {!detail?.builtin ? (
            <>
              <Field label="Change note">
                {(props) => (
                  <Input
                    {...props}
                    value={note}
                    readOnly={disabled || busy}
                    maxLength={200}
                    onChange={(e) => setNote(e.target.value)}
                  />
                )}
              </Field>
              <Row $gap={1} $wrap>
                <Button
                  disabled={
                    disabled || busy || chars > 16000 || !text.trim() || !name.trim() || !id
                  }
                  onClick={() => save(true)}
                >
                  Save and activate
                </Button>
                <Button
                  disabled={
                    disabled || busy || chars > 16000 || !text.trim() || !name.trim() || !id
                  }
                  onClick={() => save(false)}
                >
                  Save as draft
                </Button>
              </Row>
            </>
          ) : (
            <p>Built-in prompts are read-only.</p>
          )}
        </>
      )}
      {detail ? (
        <>
          <Row $gap={1}>
            <Button disabled={disabled || busy} onClick={() => setDuplicating(!duplicating)}>
              Duplicate
            </Button>
            {!detail.builtin ? (
              <Button
                disabled={disabled || busy || assigned}
                title={assigned ? reason : undefined}
                onClick={() => setDeleting(true)}
              >
                Delete
              </Button>
            ) : null}
          </Row>
          {assigned && !detail.builtin ? <p>{reason}</p> : null}
          {duplicating ? (
            <Stack $gap={2}>
              <Field label="Copy ID">
                {(props) => (
                  <Input
                    {...props}
                    value={copyId}
                    readOnly={disabled || busy}
                    maxLength={40}
                    onChange={(e) => setCopyId(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Copy name">
                {(props) => (
                  <Input
                    {...props}
                    value={copyName}
                    readOnly={disabled || busy}
                    maxLength={80}
                    onChange={(e) => setCopyName(e.target.value)}
                  />
                )}
              </Field>
              <Button
                disabled={disabled || busy || !copyId || !copyName.trim()}
                onClick={() =>
                  void run(async () => {
                    const result = await duplicate.mutateAsync({
                      sourceId: detail.id,
                      id: copyId,
                      name: copyName,
                    });
                    await client.fetchQuery({
                      queryKey: queryKeys.prompt(result.id),
                      queryFn: async () => result,
                      gcTime: 300_000,
                    });
                    await onSaved(result.id);
                  })
                }
              >
                Create duplicate
              </Button>
            </Stack>
          ) : null}
          <h3>Version history</h3>
          {detail.versions.map((v) => (
            <Stack $gap={1} key={v.version}>
              <Row $gap={1} $wrap>
                <Button disabled={busy} onClick={() => onSaved(detail.id, String(v.version))}>
                  Version {v.version}
                </Button>
                <span>
                  {v.version === detail.activeVersion ? "Active" : "Draft"}
                  {v.note ? ` · ${v.note}` : ""}
                </span>
                {!detail.builtin && typeof v.version === "number" ? (
                  <Button
                    aria-label={`Activate version ${v.version}`}
                    disabled={disabled || busy || v.version === detail.activeVersion}
                    onClick={() =>
                      void run(async () => {
                        await activate.mutateAsync({ id: detail.id, version: Number(v.version) });
                        await onSaved(detail.id, String(v.version));
                      })
                    }
                  >
                    Activate
                  </Button>
                ) : null}
              </Row>
              <PromptVersionDiff version={v} versions={detail.versions} />
            </Stack>
          ))}
        </>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {saved && !problem ? <p role="status">Saved.</p> : null}
      {detail ? (
        <Confirm
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${detail.name}?`}
          body="This removes the prompt and all retained history. Historical links will become unavailable."
          confirmLabel="Delete prompt"
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              await remove.mutateAsync(detail.id);
              setDeleting(false);
              onRemoved();
            })
          }
        />
      ) : null}
    </Stack>
  );
}
