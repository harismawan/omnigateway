import { useState } from "react";
import styled from "styled-components";
import { useAgentSetup } from "../../api/queries.ts";
import type { SetupClient } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Mono, Row, Stack } from "../../ui/primitives.ts";
import { describeError, Failure, SkeletonRows } from "../../ui/States.tsx";

/**
 * The configuration an agent needs to talk to this gateway.
 *
 * This exists because none of these agents reads its context window from
 * `GET /v1/models` — Claude Code ignores the field, opencode takes the number
 * from its own config — so an operator who does nothing here gets a session
 * sized by the client's default rather than by the pool. The files are
 * generated server-side, from the same resolution the listing uses, so what is
 * shown cannot drift from what the gateway would say.
 */

const CLIENTS: ReadonlyArray<{ id: SetupClient; label: string; where: string }> = [
  { id: "claude", label: "Claude Code", where: "one profile per model, under ~/.claude/profiles" },
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

export function AgentSetup() {
  const [client, setClient] = useState<SetupClient>("claude");
  const files = useAgentSetup(client);
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

        {files.isError ? (
          <Failure error={files.error} onRetry={() => void files.refetch()} />
        ) : files.isLoading ? (
          <SkeletonRows rows={4} />
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
