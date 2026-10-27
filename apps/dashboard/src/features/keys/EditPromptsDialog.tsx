import { useState } from "react";
import { usePrompts, useSetKeyPrompts, useSettings, useStatus } from "../../api/queries.ts";
import type { ApiKeySummary, PromptAssignment } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { effectivePromptEntries } from "../prompts/PromptAssignments.tsx";
import { PromptSelector } from "../prompts/PromptSelector.tsx";

export function EditPromptsDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKeySummary;
  onOpenChange: (open: boolean) => void;
}) {
  const library = usePrompts();
  const settings = useSettings();
  const status = useStatus();
  const save = useSetKeyPrompts();
  const [value, setValue] = useState<PromptAssignment>(apiKey.prompts);
  const disabled =
    status.data?.principal?.kind !== "admin" || apiKey.revokedAt !== null || save.isPending;
  const unavailable = !library.data || !settings.data || library.isError || settings.isError;
  const preview = effectivePromptEntries(settings.data?.prompts ?? [], value, library.data ?? []);
  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={`Edit prompts for ${apiKey.label}`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            $variant="primary"
            disabled={disabled || unavailable}
            onClick={() =>
              save.mutate({ id: apiKey.id, ...value }, { onSuccess: () => onOpenChange(false) })
            }
          >
            Save prompts
          </Button>
        </>
      }
    >
      <Stack $gap={2}>
        <Row>
          <Toggle
            label="Also apply global prompts"
            checked={value.inheritGlobal}
            disabled={disabled}
            onCheckedChange={(inheritGlobal) => setValue({ ...value, inheritGlobal })}
          />
          Also apply global prompts
        </Row>
        <PromptSelector
          library={library.data ?? []}
          value={value.ids}
          disabled={disabled || unavailable}
          onChange={(ids) => setValue({ ...value, ids })}
        />
        <h3>Effective prompts</h3>
        <p>Preview only; the gateway resolves active prompts when each request arrives.</p>
        {unavailable ? (
          <p>Effective preview unavailable until settings and library load successfully.</p>
        ) : null}
        <ol aria-label="Effective prompts">
          {preview.map((p) => (
            <li key={p.id}>
              {p.name} @{p.activeVersion}
            </li>
          ))}
        </ol>
        {!unavailable && preview.length === 0 ? <p>No effective prompts.</p> : null}
        <a href="/prompts">Manage prompt texts in Prompt Management</a>
        {library.isError ? <p role="alert">{describeError(library.error)}</p> : null}
        {settings.isError ? <p role="alert">{describeError(settings.error)}</p> : null}
        {save.isError ? <p role="alert">{describeError(save.error)}</p> : null}
      </Stack>
    </Modal>
  );
}
