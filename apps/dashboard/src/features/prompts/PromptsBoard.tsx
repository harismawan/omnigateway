import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
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
  /** Routed callers must return navigation completion, not discard its promise. */
  onSelect?: (id?: string, version?: string) => Promise<void>;
}) {
  const [selection, setSelection] = useState<{ id?: string; version?: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState(0);
  const [navigating, setNavigating] = useState(false);
  const selectedId = selection === null ? id : selection.id;
  const selectedVersion = selection === null ? version : selection.version;
  // Every editor selection owns its completion callbacks. An old server write may
  // still succeed, but must not navigate over a newer local or routed draft.
  const identity = JSON.stringify([creating, newDraft, selectedId, selectedVersion, id, version]);
  const ownership = useRef({ identity, token: {} });
  if (ownership.current.identity !== identity) ownership.current = { identity, token: {} };
  const token = ownership.current.token;
  const route = useRef({ id, version, creating });
  route.current = { id, version, creating };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const library = usePrompts();
  const detail = usePrompt(creating ? "" : (selectedId ?? ""));
  const status = useStatus();
  const disabled = status.data?.principal?.kind !== "admin";
  // BAD_REQUEST is the validated detail endpoint's missing-prompt response.
  // A failed refetch retains data, but that cache must not outrank deletion.
  const missing =
    detail.isError &&
    detail.error instanceof ApiError &&
    (detail.error.status === 404 || detail.error.code === "BAD_REQUEST");
  const select = async (nextId?: string, nextVersion?: string) => {
    if (!mounted.current || ownership.current.token !== token) return;
    ownership.current = { identity, token: {} };
    if (onSelect) {
      setNavigating(true);
      try {
        await onSelect(nextId, nextVersion);
      } finally {
        if (mounted.current) setNavigating(false);
      }
      if (!mounted.current) return;
      if (
        ownership.current.token !== token &&
        !(
          route.current.id === nextId &&
          route.current.version === nextVersion &&
          route.current.creating === creating
        )
      )
        return;
      setCreating(false);
      setSelection(null);
    } else {
      setCreating(false);
      setSelection({
        ...(nextId ? { id: nextId } : {}),
        ...(nextVersion ? { version: nextVersion } : {}),
      });
    }
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
              disabled={disabled || navigating}
              onClick={() => {
                ownership.current = { identity: "new", token: {} };
                setNewDraft((draft) => draft + 1);
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
                  <Button disabled={navigating} onClick={() => select(entry.id)}>
                    {entry.name}
                  </Button>
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
              key={`new-${newDraft}`}
              disabled={disabled}
              onSaved={select}
              onRemoved={() => select()}
            />
          ) : selectedId ? (
            missing ? (
              <p role="status">Version unavailable</p>
            ) : detail.data ? (
              <>
                {detail.isError ? (
                  <p role="alert">
                    Refresh failed. Showing the last fetched version; editing is disabled until a
                    successful refresh.
                  </p>
                ) : null}
                <PromptEditor
                  key={selectedId}
                  detail={detail.data}
                  {...(selectedVersion === undefined ? {} : { version: selectedVersion })}
                  disabled={disabled || detail.isError}
                  onSaved={select}
                  onRemoved={() => select()}
                />
              </>
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
