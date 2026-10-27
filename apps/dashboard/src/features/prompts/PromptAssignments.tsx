import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useKeys, useSaveGlobalPrompts, useSettings } from "../../api/queries.ts";
import type { PromptAssignment, PromptLibraryEntry, Settings } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { Stack } from "../../ui/primitives.ts";
import { Select } from "../../ui/Select.tsx";
import { describeError } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { PromptSelector } from "./PromptSelector.tsx";

/** Preview metadata only: active text remains on the exact-version detail endpoint. */
export function effectivePromptEntries(
  global: string[],
  assignment: PromptAssignment,
  library: PromptLibraryEntry[],
): PromptLibraryEntry[] {
  const keyBuiltin = assignment.ids.find((id) => library.some((p) => p.id === id && p.builtin));
  const ids = [...(assignment.inheritGlobal ? global : []), ...assignment.ids];
  return [...new Set(ids)].flatMap((id) => {
    const entry = library.find((p) => p.id === id);
    return entry &&
      entry.activeVersion !== null &&
      (!entry.builtin || !keyBuiltin || entry.id === keyBuiltin)
      ? [entry]
      : [];
  });
}

function GlobalPrompts({
  settings,
  library,
  disabled,
}: {
  settings: Settings;
  library: PromptLibraryEntry[];
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const save = useSaveGlobalPrompts();
  const value = draft ?? settings.prompts;
  const total = value.reduce((sum, id) => {
    const entry = library.find((p) => p.id === id);
    return sum + (entry?.activeVersion === null ? 0 : (entry?.estimatedTokens ?? 0));
  }, 0);
  return (
    <Stack $gap={2}>
      <h3>Global prompts</h3>
      <Field label="Lazy senior dev mode">
        {(props) => (
          <Select
            {...props}
            aria-label="Lazy senior dev mode"
            value={settings.ponytailMode}
            disabled={disabled || save.isPending || draft !== null}
            onValueChange={(value) => {
              const mode = value as Settings["ponytailMode"];
              save.mutate({ ponytailMode: mode });
            }}
            options={[
              { value: "off", label: "Off" },
              { value: "lite", label: "Lite" },
              { value: "full", label: "Full" },
              { value: "ultra", label: "Ultra" },
            ]}
          />
        )}
      </Field>
      {draft !== null ? (
        <small>Save or discard list changes before changing the alias.</small>
      ) : null}
      <PromptSelector
        library={library}
        value={value}
        onChange={setDraft}
        disabled={disabled || save.isPending}
      />
      <p>{total} estimated tokens per request (active prompts)</p>
      <Button
        disabled={disabled || save.isPending}
        onClick={() => save.mutate({ prompts: value }, { onSuccess: () => setDraft(null) })}
      >
        Save global prompts
      </Button>
      {draft !== null ? (
        <Button disabled={save.isPending} onClick={() => setDraft(null)}>
          Discard list changes
        </Button>
      ) : null}
      {save.isError ? <p role="alert">{describeError(save.error)}</p> : null}
    </Stack>
  );
}

export function PromptAssignments({
  library,
  disabled,
}: {
  library: PromptLibraryEntry[];
  disabled: boolean;
}) {
  const settings = useSettings();
  const keys = useKeys();
  return (
    <Stack $gap={3}>
      {settings.data ? (
        <GlobalPrompts settings={settings.data} library={library} disabled={disabled} />
      ) : (
        <p>{settings.isError ? describeError(settings.error) : "Loading global assignments…"}</p>
      )}
      <h3>Per key</h3>
      <p>
        Explicit assignments include expired and revoked keys. Effective previews skip inactive or
        unavailable prompts.
      </p>
      {keys.isError ? (
        <p role="alert">{describeError(keys.error)}</p>
      ) : (
        <Table aria-label="Per-key prompt assignments">
          <thead>
            <tr>
              <Th>Key</Th>
              <Th>Global inheritance</Th>
              <Th>Explicit prompts</Th>
              <Th>Effective prompts</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {(keys.data ?? [])
              .filter((key) => key.prompts.ids.length > 0 || !key.prompts.inheritGlobal)
              .map((key) => (
                <Tr key={key.id}>
                  <Td>
                    {key.label}
                    {key.revokedAt !== null ? " (revoked)" : ""}
                  </Td>
                  <Td>
                    {key.prompts.inheritGlobal
                      ? "Also apply global prompts"
                      : "Global prompts disabled"}
                  </Td>
                  <Td>
                    {key.prompts.ids
                      .map((id) => library.find((p) => p.id === id)?.name ?? `${id} (unavailable)`)
                      .join(", ") || "None"}
                  </Td>
                  <Td>
                    {settings.data
                      ? effectivePromptEntries(settings.data.prompts, key.prompts, library)
                          .map((p) => `${p.name} @${p.activeVersion}`)
                          .join(", ") || "None"
                      : "Unavailable"}
                  </Td>
                  <Td>
                    <Link to="/keys" search={{ editPrompts: key.id }}>
                      Edit prompts for {key.label}
                    </Link>
                  </Td>
                </Tr>
              ))}
          </tbody>
        </Table>
      )}
    </Stack>
  );
}
