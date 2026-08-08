import { PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import styled from "styled-components";
import { pollConnect, useConnectFinish, useConnectStart } from "../../api/queries.ts";
import type { ConnectStart, ProviderId } from "../../api/types.ts";
import { CopyValue } from "../../components/CopyValue.tsx";
import { Button } from "../../ui/Button.tsx";
import { Field, Input, Select } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Legend, Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";

const PROVIDER_IDS = Object.keys(PROVIDER_MODEL_CATALOG) as ProviderId[];

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kimi: "Kimi",
};

/** What the operator has to do next, in their words, per flow shape. */
const PASTE_HINT: Record<ProviderId, string> = {
  anthropic: "Authorize in the browser, then paste the code Anthropic shows you.",
  openai: "Authorize in the browser. When it redirects to localhost, paste the whole URL.",
  kimi: "Enter the code on Kimi's device page. This dialog finishes on its own.",
};

const Step = styled.ol`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space(3)};
`;

const Code = styled.div`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 26px;
  letter-spacing: 0.22em;
  text-align: center;
  padding: ${({ theme }) => theme.space(3)};
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: ${({ theme }) => theme.radius.control};
`;

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Waiting = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
`;

export type ConnectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
};

/**
 * Runs one authorization from start to credential.
 *
 * PKCE providers hand back a code the operator pastes; Kimi's device flow polls
 * until the operator finishes on their phone. Both end the same way — a stored
 * credential — so the dialog keeps one shape and swaps only the middle step.
 */
export function ConnectDialog({ open, onOpenChange, onConnected }: ConnectDialogProps) {
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [label, setLabel] = useState("");
  const [flow, setFlow] = useState<ConnectStart | null>(null);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const start = useConnectStart();
  const finish = useConnectFinish();

  const reset = useCallback(() => {
    setFlow(null);
    setCode("");
    setProblem(null);
    setLabel("");
    start.reset();
    finish.reset();
  }, [start, finish]);

  const close = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  // Device flows complete out of band, so the dialog polls until the gateway
  // says the credential exists. An unmount or a close stops the loop.
  useEffect(() => {
    if (flow === null || flow.kind !== "device") return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const result = await pollConnect(flow.flowId);
        if (cancelled) return;
        if (result.status === "complete") {
          reset();
          onOpenChange(false);
          onConnected();
          return;
        }
      } catch (error) {
        if (cancelled) return;
        setProblem(describeError(error));
        setFlow(null);
        return;
      }
      if (!cancelled) timer = setTimeout(() => void tick(), flow.pollIntervalMs);
    };

    let timer = setTimeout(() => void tick(), flow.pollIntervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, onConnected, onOpenChange, reset]);

  const begin = () => {
    setProblem(null);
    start.mutate(
      { provider, label: label.trim().length === 0 ? PROVIDER_LABEL[provider] : label.trim() },
      {
        onSuccess: (result) => setFlow(result),
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  const complete = () => {
    if (flow === null) return;
    setProblem(null);
    finish.mutate(
      { flowId: flow.flowId, code: code.trim() },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
          onConnected();
        },
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Connect an account"
      description="The gateway stores the resulting token encrypted. It is never shown again after this dialog."
      footer={
        flow === null ? (
          <>
            <Button type="button" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="button" $variant="primary" disabled={start.isPending} onClick={begin}>
              {start.isPending ? "Starting…" : "Start authorization"}
            </Button>
          </>
        ) : flow.kind === "device" ? (
          <Button type="button" onClick={() => close(false)}>
            Cancel
          </Button>
        ) : (
          <>
            <Button type="button" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              $variant="primary"
              disabled={finish.isPending || code.trim().length === 0}
              onClick={complete}
            >
              {finish.isPending ? "Finishing…" : "Finish connecting"}
            </Button>
          </>
        )
      }
    >
      <Step>
        {flow === null ? (
          <Stack $gap={3}>
            <Field label="Provider">
              {(props) => (
                <Select
                  {...props}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as ProviderId)}
                >
                  {PROVIDER_IDS.map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_LABEL[id]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Label"
              hint="How this account is named in the rack. Defaults to the provider."
            >
              {(props) => (
                <Input
                  {...props}
                  value={label}
                  placeholder={PROVIDER_LABEL[provider]}
                  onChange={(event) => setLabel(event.target.value)}
                />
              )}
            </Field>
          </Stack>
        ) : (
          <Stack $gap={3}>
            <Stack $gap={1}>
              <Legend>Step 1 — authorize</Legend>
              <Row $gap={2}>
                <Button
                  as="a"
                  href={flow.authorizeUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  $variant="primary"
                  $size="sm"
                >
                  <ExternalLink />
                  Open {PROVIDER_LABEL[provider]}
                </Button>
              </Row>
              <CopyValue value={flow.authorizeUrl} label="Copy authorization link" />
            </Stack>

            {flow.userCode === null ? null : (
              <Stack $gap={1}>
                <Legend>Step 2 — enter this code</Legend>
                <Code>{flow.userCode}</Code>
              </Stack>
            )}

            {flow.kind === "device" ? (
              <Waiting>{PASTE_HINT[provider]} Waiting for authorization…</Waiting>
            ) : (
              <Field
                label="Authorization code"
                hint={PASTE_HINT[provider]}
                {...(problem === null ? {} : { problem })}
              >
                {(props) => (
                  <Input
                    {...props}
                    value={code}
                    autoFocus
                    placeholder={
                      provider === "openai"
                        ? "http://localhost:1455/auth/callback?code=…"
                        : "code#state"
                    }
                    onChange={(event) => setCode(event.target.value)}
                  />
                )}
              </Field>
            )}
          </Stack>
        )}

        {problem === null || flow?.kind === "pkce" ? null : <Problem>{problem}</Problem>}
      </Step>
    </Modal>
  );
}
