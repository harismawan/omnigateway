import { useState } from "react";
import { usePrompt, usePrompts, useStatus } from "../../api/queries.ts";
import { PageHead } from "../../components/Rack.tsx";
import { Button } from "../../ui/Button.tsx";
import { Chip } from "../../ui/Chip.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";
import { PromptAssignments } from "./PromptAssignments.tsx";
import { PromptEditor } from "./PromptEditor.tsx";

export function PromptsBoard({
  id,
  version,
  onSelect,
}: {
  id?: string;
  version?: string;
  onSelect?: (id?: string, version?: string) => void;
}) {
  const [selection, setSelection] = useState<{ id?: string; version?: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const selectedId = selection === null ? id : selection.id;
  const selectedVersion = selection === null ? version : selection.version;
  const library = usePrompts();
  const detail = usePrompt(creating ? "" : (selectedId ?? ""));
  const status = useStatus();
  const disabled = status.data?.principal?.kind !== "admin";
  const select = (nextId?: string, nextVersion?: string) => {
    setCreating(false);
    if (onSelect) {
      onSelect(nextId, nextVersion);
      setSelection(null);
    } else
      setSelection({
        ...(nextId ? { id: nextId } : {}),
        ...(nextVersion ? { version: nextVersion } : {}),
      });
  };
  return (
    <>
      <PageHead
        legend="Prompts"
        title="Prompt Management"
        summary="System-prompt additions, versions, and where they apply"
      />
      <section aria-label="Library">
        <Module legend="Library">
          <Stack $gap={2}>
            <Button
              disabled={disabled}
              onClick={() => {
                setCreating(true);
              }}
            >
              New prompt
            </Button>
            {library.isError ? <p role="alert">{describeError(library.error)}</p> : null}
            {[...(library.data ?? [])]
              .sort((a, b) => Number(b.builtin) - Number(a.builtin))
              .map((entry) => (
                <Row $gap={2} $wrap key={entry.id}>
                  <Button onClick={() => select(entry.id)}>{entry.name}</Button>
                  {entry.builtin ? <Chip>built-in</Chip> : null}
                  <span>
                    {entry.activeVersion === null
                      ? "Inactive draft"
                      : `Active @${entry.activeVersion}`}{" "}
                    · {entry.estimatedTokens} tokens · Used by:{" "}
                    {entry.assignments.global ? "global, " : ""}
                    {entry.assignments.keyIds.length} keys
                  </span>
                </Row>
              ))}
          </Stack>
        </Module>
      </section>
      <section aria-label="Editor">
        <Module legend="Editor / history">
          {creating ? (
            <PromptEditor
              key="new"
              disabled={disabled}
              onSaved={select}
              onRemoved={() => select()}
            />
          ) : selectedId ? (
            detail.data ? (
              <PromptEditor
                key={`${selectedId}@${selectedVersion ?? "current"}`}
                detail={detail.data}
                {...(selectedVersion === undefined ? {} : { version: selectedVersion })}
                disabled={disabled}
                onSaved={select}
                onRemoved={() => select()}
              />
            ) : detail.isError ? (
              <p role="status">
                {selectedVersion === undefined
                  ? `Prompt unavailable: ${describeError(detail.error)}`
                  : "Version unavailable"}
              </p>
            ) : (
              <p>Loading prompt…</p>
            )
          ) : (
            <p>Select a prompt or create a new one.</p>
          )}
        </Module>
      </section>
      <section aria-label="Assignments">
        <Module legend="Assignments">
          <PromptAssignments library={library.data ?? []} disabled={disabled} />
        </Module>
      </section>
    </>
  );
}
