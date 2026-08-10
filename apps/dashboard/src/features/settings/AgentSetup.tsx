import { useState } from "react";
import styled from "styled-components";
import { useAgentSetup, useModels } from "../../api/queries.ts";
import type { AgentModelMapping, SetupClient } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Field, Select } from "../../ui/Field.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Mono, Row, Stack } from "../../ui/primitives.ts";
import { describeError, Failure, SkeletonRows } from "../../ui/States.tsx";

/**
 * The configuration an agent needs to talk to this gateway.
 *
 * Claude Code needs explicit model-class mappings, while opencode takes model
 * limits from its own config instead of `GET /v1/models`. Files are generated
 * server-side so dashboard and CLI cannot drift.
 */

const CLIENTS: ReadonlyArray<{ id: SetupClient; label: string; where: string }> = [
  { id: "claude", label: "Claude Code", where: "settings.json under ~/.claude" },
  { id: "opencode", label: "opencode", where: "opencode.json in your project" },
];

const Sheet = styled(Mono)`
  display: block;
  white-space: pre;
  overflow-x: auto;
  padding: 0.75rem;
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.rule};
  border-radius: 4px;
  font-size: 0.8125rem;
  line-height: 1.5;
`;

const Path = styled.div`
  color: ${({ theme }) => theme.color.inkDim};
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
`;

const Note = styled.p`
  color: ${({ theme }) => theme.color.inkDim};
  font-size: 0.8125rem;
  margin: 0;
`;

const MappingGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: ${({ theme }) => theme.space(2)};
`;

const MAPPING_FIELDS: ReadonlyArray<{
  key: keyof AgentModelMapping;
  label: string;
  required: boolean;
}> = [
  { key: "defaultModel", label: "Default model", required: true },
  { key: "fableModel", label: "Fable model", required: false },
  { key: "opusModel", label: "Opus model", required: false },
  { key: "sonnetModel", label: "Sonnet model", required: false },
  { key: "haikuModel", label: "Haiku model", required: false },
];

export function AgentSetup() {
  const [client, setClient] = useState<SetupClient>("claude");
  const [mappings, setMappings] = useState<Record<SetupClient, Partial<AgentModelMapping>>>(() => ({
    claude: {},
    opencode: {},
  }));
  const models = useModels();
  const mapping = mappings[client];
  const completeMapping =
    typeof mapping.defaultModel === "string" && mapping.defaultModel !== ""
      ? (mapping as AgentModelMapping)
      : undefined;
  const files = useAgentSetup(client, completeMapping);
  const chosen = CLIENTS.find((entry) => entry.id === client);

  return (
    <Module legend="Agent setup">
      <Stack>
        <Row>
          {CLIENTS.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              $variant={entry.id === client ? "primary" : "ghost"}
              onClick={() => setClient(entry.id)}
            >
              {entry.label}
            </Button>
          ))}
        </Row>

        <Note>
          {chosen?.where}. The key is a placeholder — paste your own over it. Or run{" "}
          <Mono>omni setup {client}</Mono> to write these files directly.
        </Note>

        {(models.data?.length ?? 0) > 0 ? (
          <MappingGrid>
            {MAPPING_FIELDS.map((field) => (
              <Field key={field.key} label={field.label}>
                {(props) => (
                  <Select
                    {...props}
                    value={mapping[field.key] ?? ""}
                    onChange={(event) =>
                      setMappings((current) => ({
                        ...current,
                        [client]: {
                          ...current[client],
                          [field.key]: event.target.value || undefined,
                        },
                      }))
                    }
                  >
                    <option value="">{field.required ? "Choose a pool" : "Not mapped"}</option>
                    {models.data?.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ))}
          </MappingGrid>
        ) : null}

        {models.isLoading ? (
          <SkeletonRows rows={2} />
        ) : files.isError ? (
          <Failure error={files.error} onRetry={() => void files.refetch()} />
        ) : files.isLoading ? (
          <SkeletonRows rows={4} />
        ) : (models.data?.length ?? 0) === 0 ? (
          <Note>No virtual models configured yet, so there is nothing to point a client at.</Note>
        ) : completeMapping === undefined ? (
          <Note>Choose a default model to generate {chosen?.label} settings.</Note>
        ) : files.data === undefined || files.data.length === 0 ? (
          <Note>No virtual models configured yet, so there is nothing to point a client at.</Note>
        ) : (
          files.data.map((file) => (
            <div key={file.path}>
              <Path>{file.path}</Path>
              <Sheet as="pre">{file.contents.trimEnd()}</Sheet>
            </div>
          ))
        )}

        {files.isError ? <Note>{describeError(files.error)}</Note> : null}
      </Stack>
    </Module>
  );
}
