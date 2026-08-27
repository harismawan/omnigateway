import { type CatalogAuth, PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import styled from "styled-components";
import {
  pollConnect,
  useConnectFinish,
  useConnectStart,
  useCreateApiKeyCredential,
} from "../../api/queries.ts";
import type { ConnectStart, Credential, ProviderId } from "../../api/types.ts";
import { CopyValue } from "../../components/CopyValue.tsx";
import { PROVIDER_LABEL } from "../../theme/tokens.ts";
import { Button } from "../../ui/Button.tsx";
import { Field, Input, Select } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Legend, Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";

const PROVIDER_IDS = Object.keys(PROVIDER_MODEL_CATALOG) as ProviderId[];

/**
 * How a provider can be connected, read from the catalog instead of decided
 * here.
 *
 * This used to be `provider === "custom"`, which stood in for "the one that
 * takes a key" and quietly meant "no other provider may". Every adapter
 * authenticates with a raw key, so that stranded four providers whose operators
 * hold a console key and no subscription.
 */
function waysIn(provider: ProviderId): readonly CatalogAuth[] {
  return PROVIDER_MODEL_CATALOG[provider].authTypes;
}

/** Authorizing is the better path where a provider offers it, so it leads. */
function defaultWayIn(provider: ProviderId): CatalogAuth {
  return waysIn(provider).includes("oauth") ? "oauth" : "apiKey";
}

const AUTH_LABEL: Record<CatalogAuth, string> = {
  oauth: "Authorize in the browser",
  apiKey: "Paste an API key",
};

/**
 * What the operator has to do next, in their words, per flow shape.
 *
 * Read off the provider rather than restated here: the sentence describes that
 * provider's flow, so it belongs with the flow. Empty for a provider that
 * states none, which renders the hint away rather than inventing one.
 */
function pasteHint(provider: ProviderId): string {
  return PROVIDER_DESCRIPTORS[provider].presentation.pasteHint ?? "";
}

/**
 * The shape of what gets pasted back, per flow.
 *
 * A loopback redirect fails to connect — nothing is listening on that port —
 * so what the operator has is the address bar, not a page. Derived from the
 * provider's own redirect URI, so the two can no longer disagree about the
 * port or the path; providers that declare no callback have no redirect to
 * show and get the bare-code placeholder instead.
 */
const CODE_PLACEHOLDER: Partial<Record<ProviderId, string>> = Object.fromEntries(
  Object.values(PROVIDER_DESCRIPTORS).flatMap((descriptor) =>
    // `flatMap` rather than `filter` + `map`: a filter does not narrow the
    // optional away, and the fallback that would silence the compiler is what
    // renders the literal string "undefined" into the field.
    descriptor.callback === undefined
      ? []
      : [[descriptor.id, `${descriptor.callback.uri}?code=…`] as const],
  ),
);

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
  credentials?: Credential[];
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
export function ConnectDialog({
  open,
  credentials,
  onOpenChange,
  onConnected,
}: ConnectDialogProps) {
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [authType, setAuthType] = useState<CatalogAuth>(defaultWayIn("anthropic"));
  const [label, setLabel] = useState("");
  const [flow, setFlow] = useState<ConnectStart | null>(null);
  const [code, setCode] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const customEndpoints = (credentials ?? []).filter(
    (credential, index, all) =>
      credential.provider === "custom" &&
      all.findIndex(
        (candidate) =>
          candidate.provider === "custom" &&
          candidate.providerData.endpointId === credential.providerData.endpointId,
      ) === index,
  );
  const [endpointLabel, setEndpointLabel] = useState("");
  const [origin, setOrigin] = useState("");
  const [protocol, setProtocol] = useState<"chat_completions" | "responses">("chat_completions");
  const [apiKey, setApiKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const start = useConnectStart();
  const finish = useConnectFinish();
  const createKey = useCreateApiKeyCredential();

  const reset = useCallback(() => {
    setFlow(null);
    setCode("");
    setEndpointId("");
    setEndpointLabel("");
    setOrigin("");
    setProtocol("chat_completions");
    setApiKey("");
    setProblem(null);
    setLabel("");
    start.reset();
    finish.reset();
    createKey.reset();
  }, [start, finish, createKey]);

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
    if (authType === "apiKey") {
      createKey.mutate(
        {
          provider,
          apiKey,
          label: label.trim() || undefined,
          // Endpoint metadata is custom's alone: it addresses a server the
          // operator runs. Every other provider's endpoint is the adapter's.
          ...(provider === "custom" ? { endpointId, endpointLabel, origin, protocol } : {}),
        },
        {
          onSuccess: () => {
            reset();
            onOpenChange(false);
            onConnected();
          },
          onError: (error) => setProblem(describeError(error)),
        },
      );
      return;
    }
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
            <Button
              type="button"
              $variant="primary"
              disabled={start.isPending || createKey.isPending}
              onClick={begin}
            >
              {authType === "apiKey"
                ? createKey.isPending
                  ? "Adding…"
                  : "Add API key"
                : start.isPending
                  ? "Starting…"
                  : "Start authorization"}
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
                  onChange={(event) => {
                    const next = event.target.value as ProviderId;
                    setProvider(next);
                    // The way in belongs to the provider. Carrying the old one
                    // across would offer to store a key under a provider that
                    // has no key path, or authorize one that has no flow.
                    setAuthType(defaultWayIn(next));
                  }}
                >
                  {PROVIDER_IDS.map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_LABEL[id]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {waysIn(provider).length > 1 ? (
              <Field label="How to connect">
                {(props) => (
                  <Select
                    {...props}
                    value={authType}
                    onChange={(event) => setAuthType(event.target.value as CatalogAuth)}
                  >
                    {waysIn(provider).map((way) => (
                      <option key={way} value={way}>
                        {AUTH_LABEL[way]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            {provider === "custom" ? (
              <>
                {customEndpoints.length === 0 ? null : (
                  <Field label="Existing endpoint">
                    {(props) => (
                      <Select
                        {...props}
                        value={endpointId}
                        onChange={(event) => {
                          const selected = customEndpoints.find(
                            (credential) =>
                              credential.providerData.endpointId === event.target.value,
                          );
                          if (selected === undefined) {
                            setEndpointId("");
                            setEndpointLabel("");
                            setOrigin("");
                            setProtocol("chat_completions");
                            return;
                          }
                          setEndpointId(String(selected.providerData.endpointId));
                          setEndpointLabel(String(selected.providerData.endpointLabel));
                          // Base path rejoins the origin so the field round-trips
                          // exactly what the operator entered.
                          setOrigin(
                            String(selected.providerData.origin) +
                              String(selected.providerData.basePath ?? ""),
                          );
                          setProtocol(
                            selected.providerData.protocol === "responses"
                              ? "responses"
                              : "chat_completions",
                          );
                        }}
                      >
                        <option value="">Create new endpoint</option>
                        {customEndpoints.map((credential) => (
                          <option
                            key={String(credential.providerData.endpointId)}
                            value={String(credential.providerData.endpointId)}
                          >
                            {String(credential.providerData.endpointLabel)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                <Field label="Endpoint ID">
                  {(props) => (
                    <Input
                      {...props}
                      value={endpointId}
                      onChange={(event) => setEndpointId(event.target.value)}
                    />
                  )}
                </Field>
                <Field label="Endpoint label">
                  {(props) => (
                    <Input
                      {...props}
                      value={endpointLabel}
                      onChange={(event) => setEndpointLabel(event.target.value)}
                    />
                  )}
                </Field>
                <Field label="Server URL">
                  {(props) => (
                    <Input
                      {...props}
                      value={origin}
                      placeholder="https://server.example/api"
                      onChange={(event) => setOrigin(event.target.value)}
                    />
                  )}
                </Field>
                {origin.trim().toLowerCase().startsWith("http://") ? (
                  <Problem>Plaintext transport sends prompts and API keys without TLS.</Problem>
                ) : null}
                <Field label="Protocol">
                  {(props) => (
                    <Select
                      {...props}
                      value={protocol}
                      onChange={(event) =>
                        setProtocol(event.target.value as "chat_completions" | "responses")
                      }
                    >
                      <option value="chat_completions">
                        Chat Completions (/v1/chat/completions)
                      </option>
                      <option value="responses">Responses (/v1/responses)</option>
                    </Select>
                  )}
                </Field>
              </>
            ) : null}
            {authType === "apiKey" ? (
              <Field label="API key">
                {(props) => (
                  <Input
                    {...props}
                    type="password"
                    value={apiKey}
                    autoComplete="off"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                )}
              </Field>
            ) : null}
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
              <Waiting>{pasteHint(provider)} Waiting for authorization…</Waiting>
            ) : (
              <Field
                label="Authorization code"
                hint={pasteHint(provider)}
                {...(problem === null ? {} : { problem })}
              >
                {(props) => (
                  <Input
                    {...props}
                    value={code}
                    autoFocus
                    placeholder={CODE_PLACEHOLDER[provider] ?? "code#state"}
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
