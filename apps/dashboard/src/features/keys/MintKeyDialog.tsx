import { ChevronDown, ChevronRight } from "lucide-react";
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
import { LimitFields } from "./LimitFields.tsx";
import { draftFrom, draftToLimits, type LimitDraft } from "./limits.ts";
import { ModelPicker } from "./ModelPicker.tsx";

const Warning = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

/** Matches `Field`'s own hint, for a control that draws its own label. */
const Hint = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;
const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Once = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
`;

/** Opens the limit matrix, which is folded away until it is asked for. */
const Disclosure = styled(Button)`
  gap: 4px;
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
  const [limits, setLimits] = useState<LimitDraft>(() => draftFrom({}));
  const [showLimits, setShowLimits] = useState(false);
  const [optOut, setOptOut] = useState(false);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const reset = () => {
    setLabel("");
    setUnrestricted(true);
    setAllowed([]);
    setLimits(draftFrom({}));
    setShowLimits(false);
    setOptOut(false);
    setMinted(null);
    setProblem(null);
    create.reset();
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  /** Counted from the typed fields so a collapsed section still says what is in it. */
  const configured = Object.values(limits).filter((value) => value.trim().length > 0).length;

  const submit = () => {
    const matrix = draftToLimits(limits);
    if ("problem" in matrix) {
      // The section may be collapsed over the field that is wrong, so it opens
      // rather than leaving an alert pointing at something nobody can see.
      setShowLimits(true);
      setProblem(matrix.problem);
      return;
    }
    setProblem(null);
    create.mutate(
      {
        label: label.trim().length === 0 ? "api key" : label.trim(),
        modelAllowlist: unrestricted ? null : allowed,
        // `{}` is unlimited, and an omitted pair says the same thing as a null
        // one — so blank fields submit an empty matrix rather than nulls inside
        // dimension objects nobody asked for.
        limits: matrix.limits,
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
                <ModelPicker
                  configured={(models.data ?? []).map((entry) => entry.id)}
                  checked={allowed}
                  onChange={setAllowed}
                />
                {allowed.length === 0 ? (
                  <Warning>
                    With no model selected this key is allowed nothing and every request it makes
                    will be refused.
                  </Warning>
                ) : null}
              </>
            )}
          </Stack>

          {/* Collapsed by default, so minting a key with no limits stays a
              two-field operation. Nine ceilings unfolded over every operator
              who only ever wanted a label would be a worse default than the
              one field this replaces. */}
          <Stack $gap={2}>
            <Row $gap={2}>
              <Disclosure
                type="button"
                $size="sm"
                aria-expanded={showLimits}
                onClick={() => setShowLimits((open) => !open)}
              >
                {showLimits ? <ChevronDown /> : <ChevronRight />}
                Limits
              </Disclosure>
              <Legend as="span">
                {configured === 0
                  ? "no limits; this key is unbounded"
                  : `${configured} limit${configured === 1 ? "" : "s"} set`}
              </Legend>
            </Row>
            {showLimits ? <LimitFields draft={limits} onChange={setLimits} /> : null}
          </Stack>

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
