import { useState } from "react";
import styled from "styled-components";
import { useCreateKey, useModels } from "../../api/queries.ts";
import type { MintedKey } from "../../api/types.ts";
import { CopyValue } from "../../components/CopyValue.tsx";
import { Button } from "../../ui/Button.tsx";
import { Field, Input } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Legend, Mono, Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";
import { Toggle } from "../../ui/Toggle.tsx";

const Choices = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 190px;
  overflow-y: auto;
  padding: ${({ theme }) => theme.space(1)};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: ${({ theme }) => theme.radius.control};
  background: ${({ theme }) => theme.color.panelSunk};
`;

const Choice = styled.label`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: 4px 6px;
  border-radius: 2px;
  cursor: pointer;
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;

  &:hover {
    background: ${({ theme }) => theme.color.panelRaised};
  }
`;

const Warning = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Once = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
`;

/** Matches `Field`'s own hint, for a control that draws its own label. */
const Hint = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

export type MintKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Issues a key and shows it exactly once.
 *
 * The gateway stores only a hash, so this dialog holds the only plaintext copy
 * that will ever exist. It stays open on the reveal step until the operator
 * dismisses it deliberately.
 */
export function MintKeyDialog({ open, onOpenChange }: MintKeyDialogProps) {
  const models = useModels();
  const create = useCreateKey();

  const [label, setLabel] = useState("");
  const [unrestricted, setUnrestricted] = useState(true);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [rateLimit, setRateLimit] = useState("");
  const [optOut, setOptOut] = useState(false);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const reset = () => {
    setLabel("");
    setUnrestricted(true);
    setAllowed([]);
    setRateLimit("");
    setOptOut(false);
    setMinted(null);
    setProblem(null);
    create.reset();
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = () => {
    const trimmed = rateLimit.trim();
    const limit = trimmed.length === 0 ? null : Number(trimmed);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
      setProblem(
        "The rate limit must be a whole number of requests per minute, or blank for none.",
      );
      return;
    }
    setProblem(null);
    create.mutate(
      {
        label: label.trim().length === 0 ? "api key" : label.trim(),
        modelAllowlist: unrestricted ? null : allowed,
        rateLimitPerMin: limit,
        bodyLoggingOptOut: optOut,
      },
      {
        onSuccess: (key) => setMinted(key),
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title={minted === null ? "Create an API key" : "Key created"}
      description={
        minted === null
          ? "Clients send this key as a bearer token or as x-api-key on every /v1 request."
          : undefined
      }
      footer={
        minted === null ? (
          <>
            <Button type="button" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="button" $variant="primary" disabled={create.isPending} onClick={submit}>
              {create.isPending ? "Creating…" : "Create key"}
            </Button>
          </>
        ) : (
          <Button type="button" $variant="primary" onClick={() => close(false)}>
            I have copied the key
          </Button>
        )
      }
    >
      {minted === null ? (
        <Stack $gap={3}>
          <Field label="Label" hint="Names the client this key belongs to, e.g. laptop or CI.">
            {(props) => (
              <Input
                {...props}
                value={label}
                placeholder="api key"
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </Field>

          <Stack $gap={2}>
            <Row $gap={2}>
              <Toggle
                checked={unrestricted}
                label="Allow every model"
                onCheckedChange={setUnrestricted}
              />
              <Legend as="span">Allow every model</Legend>
            </Row>

            {unrestricted ? null : (
              <>
                <Choices>
                  {(models.data ?? []).map((model) => (
                    <Choice key={model.id}>
                      <input
                        type="checkbox"
                        checked={allowed.includes(model.id)}
                        onChange={(event) =>
                          setAllowed((current) =>
                            event.target.checked
                              ? [...current, model.id]
                              : current.filter((id) => id !== model.id),
                          )
                        }
                      />
                      {model.id}
                    </Choice>
                  ))}
                </Choices>
                {allowed.length === 0 ? (
                  <Warning>
                    With no model selected this key is allowed nothing and every request it makes
                    will be refused.
                  </Warning>
                ) : null}
              </>
            )}
          </Stack>

          <Field
            label="Rate limit"
            hint="Requests per minute for this key. Leave blank for no limit. Counted per process, and reset when the gateway restarts."
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                step={1}
                value={rateLimit}
                placeholder="no limit"
                onChange={(event) => setRateLimit(event.target.value)}
              />
            )}
          </Field>

          {/* Settable only here. A client handed a key on the promise that its
              payloads are never retained must not have that reversed later by
              an edit it cannot see, so there is no route that clears this. */}
          <Stack $gap={2}>
            <Row $gap={2}>
              <Toggle
                checked={optOut}
                label="Never record this key's bodies"
                onCheckedChange={setOptOut}
              />
              <Legend as="span">Never record this key's bodies</Legend>
            </Row>
            <Hint>
              Suppresses body capture for this key whatever the gateway setting says. Choose it for
              a client whose payloads must not be retained. It cannot be changed after the key is
              created — issue a new key instead.
            </Hint>
          </Stack>

          {problem === null ? null : <Problem role="alert">{problem}</Problem>}
        </Stack>
      ) : (
        <Stack $gap={3}>
          <Once>
            This is the only time the key is shown. The gateway keeps a hash, so a lost key has to
            be replaced rather than recovered.
          </Once>
          <CopyValue value={minted.key} label="Copy API key" />
          <Row $gap={2}>
            <Legend>Label</Legend>
            <Mono>{minted.label}</Mono>
            <Legend>Prefix</Legend>
            <Mono>{minted.prefix}</Mono>
          </Row>
        </Stack>
      )}
    </Modal>
  );
}
