import { PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { RotateCcw, Trash2 } from "lucide-react";
import { useId } from "react";
import styled from "styled-components";
import type { ProviderId } from "../../api/types.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Input, NumberInput, Select } from "../../ui/Field.tsx";
import { Legend, Row, Spacer, Stack } from "../../ui/primitives.ts";
import { Toggle } from "../../ui/Toggle.tsx";
import { catalogPrices, type TargetDraft } from "./draft.ts";

const PROVIDER_IDS = Object.keys(PROVIDER_MODEL_CATALOG) as ProviderId[];

const Frame = styled.fieldset<{ $provider: ProviderId }>`
  border: 1px solid ${({ theme }) => theme.color.rule};
  border-left: 3px solid ${({ theme, $provider }) => theme.provider[$provider]};
  border-radius: ${({ theme }) => theme.radius.control};
  padding: ${({ theme }) => theme.space(3)};
  margin: 0;
  background: ${({ theme }) => theme.color.panelSunk};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space(3)};
  min-width: 0;
`;

const Cells = styled.div`
  display: grid;
  grid-template-columns: minmax(140px, 1.4fr) minmax(160px, 2fr) 72px 72px;
  gap: ${({ theme }) => theme.space(2)};
  align-items: end;

  @media (max-width: 720px) {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
`;

const Prices = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: ${({ theme }) => theme.space(2)};
  align-items: end;
`;

const Cell = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
`;

const Caps = styled(Row)`
  gap: ${({ theme }) => theme.space(3)};
  flex-wrap: wrap;
`;

const Cap = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
`;

export type TargetEditorProps = {
  target: TargetDraft;
  index: number;
  onChange: (next: TargetDraft) => void;
  onRemove: () => void;
  removable: boolean;
};

/**
 * One upstream a virtual model can dispatch to. Capabilities are hard filters
 * in the router — a target that cannot do tools is dropped from a tool request
 * rather than downgraded — so they are stated as switches, not as a note.
 */
export function TargetEditor({ target, index, onChange, onRemove, removable }: TargetEditorProps) {
  const listId = useId();
  const catalog = PROVIDER_MODEL_CATALOG[target.provider];

  const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) => {
    onChange({ ...target, [key]: value });
  };

  const listed = catalogPrices(target.provider, target.model);

  /**
   * Point the target at a different model, carrying that model's list price
   * across with it.
   *
   * Prices follow the model rather than persisting through a change, because a
   * price left over from the previous model is wrong in a way nothing surfaces.
   * A model the catalog does not list keeps whatever is in the fields — there
   * is nothing better to put there.
   */
  const retarget = (next: Pick<TargetDraft, "provider" | "model">) => {
    onChange({ ...target, ...next, ...(catalogPrices(next.provider, next.model) ?? {}) });
  };

  return (
    <Frame $provider={target.provider}>
      <Row $gap={2}>
        <Legend as="legend">Target {index + 1}</Legend>
        <Spacer />
        <IconButton
          type="button"
          $variant="ghost"
          $size="sm"
          disabled={!removable}
          aria-label={`Remove target ${index + 1}`}
          title={removable ? `Remove target ${index + 1}` : "A model needs at least one target"}
          onClick={onRemove}
        >
          <Trash2 />
        </IconButton>
      </Row>

      <Cells>
        <Cell>
          <Legend as="label" htmlFor={`${listId}-provider`}>
            Provider
          </Legend>
          <Select
            id={`${listId}-provider`}
            value={target.provider}
            onChange={(event) => {
              const provider = event.target.value as ProviderId;
              // Swapping provider carries the model name over only if it is
              // still meaningful; otherwise fall back to that provider's default.
              const known = PROVIDER_MODEL_CATALOG[provider].models.some(
                (m) => m.id === target.model,
              );
              retarget({
                provider,
                model: known ? target.model : PROVIDER_MODEL_CATALOG[provider].defaultModel,
              });
            }}
          >
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </Cell>

        <Cell>
          <Legend as="label" htmlFor={`${listId}-model`}>
            Provider model
          </Legend>
          <Input
            id={`${listId}-model`}
            list={`${listId}-catalog`}
            value={target.model}
            placeholder={catalog.defaultModel}
            onChange={(event) => retarget({ provider: target.provider, model: event.target.value })}
          />
          <datalist id={`${listId}-catalog`}>
            {catalog.models.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </datalist>
        </Cell>

        <Cell>
          <Legend as="label" htmlFor={`${listId}-tier`}>
            Tier
          </Legend>
          <NumberInput
            id={`${listId}-tier`}
            min={1}
            step={1}
            value={target.tier}
            onChange={(event) => set("tier", event.target.value)}
          />
        </Cell>

        <Cell>
          <Legend as="label" htmlFor={`${listId}-weight`}>
            Weight
          </Legend>
          <NumberInput
            id={`${listId}-weight`}
            min={0}
            step={0.1}
            value={target.weight}
            onChange={(event) => set("weight", event.target.value)}
          />
        </Cell>
      </Cells>

      <Stack $gap={1}>
        <Row $gap={2}>
          <Legend>Price per million tokens</Legend>
          <Spacer />
          {listed === null ? (
            <Legend as="span">not in the catalog — price it yourself</Legend>
          ) : (
            <Button
              type="button"
              $size="sm"
              $variant="ghost"
              disabled={
                target.costInput === listed.costInput &&
                target.costOutput === listed.costOutput &&
                target.costCacheRead === listed.costCacheRead &&
                target.costCacheWrite5m === listed.costCacheWrite5m &&
                target.costCacheWrite1h === listed.costCacheWrite1h
              }
              onClick={() => onChange({ ...target, ...listed })}
            >
              <RotateCcw />
              Use list price
            </Button>
          )}
        </Row>
        <Prices>
          <Cell>
            <Legend as="label" htmlFor={`${listId}-in`}>
              Input
            </Legend>
            <NumberInput
              id={`${listId}-in`}
              min={0}
              step={0.01}
              value={target.costInput}
              onChange={(event) => set("costInput", event.target.value)}
            />
          </Cell>
          <Cell>
            <Legend as="label" htmlFor={`${listId}-out`}>
              Output
            </Legend>
            <NumberInput
              id={`${listId}-out`}
              min={0}
              step={0.01}
              value={target.costOutput}
              onChange={(event) => set("costOutput", event.target.value)}
            />
          </Cell>
          <Cell>
            <Legend as="label" htmlFor={`${listId}-cache`}>
              Cache read
            </Legend>
            <NumberInput
              id={`${listId}-cache`}
              min={0}
              step={0.01}
              placeholder="same as input"
              value={target.costCacheRead}
              onChange={(event) => set("costCacheRead", event.target.value)}
            />
          </Cell>
          <Cell>
            <Legend as="label" htmlFor={`${listId}-write5m`}>
              Cache write 5m
            </Legend>
            <NumberInput
              id={`${listId}-write5m`}
              min={0}
              step={0.01}
              placeholder="1.25x input"
              value={target.costCacheWrite5m}
              onChange={(event) => set("costCacheWrite5m", event.target.value)}
            />
          </Cell>
          <Cell>
            <Legend as="label" htmlFor={`${listId}-write1h`}>
              Cache write 1h
            </Legend>
            <NumberInput
              id={`${listId}-write1h`}
              min={0}
              step={0.01}
              placeholder="2x input"
              value={target.costCacheWrite1h}
              onChange={(event) => set("costCacheWrite1h", event.target.value)}
            />
          </Cell>
        </Prices>
      </Stack>

      <Stack $gap={1}>
        <Legend>Capabilities</Legend>
        <Caps>
          <Cap>
            <Toggle
              checked={target.tools}
              label={`Target ${index + 1} supports tools`}
              onCheckedChange={(value) => set("tools", value)}
            />
            Tools
          </Cap>
          <Cap>
            <Toggle
              checked={target.images}
              label={`Target ${index + 1} supports images`}
              onCheckedChange={(value) => set("images", value)}
            />
            Images
          </Cap>
          <Cap>
            <Toggle
              checked={target.reasoning}
              label={`Target ${index + 1} supports reasoning`}
              onCheckedChange={(value) => set("reasoning", value)}
            />
            Reasoning
          </Cap>
        </Caps>
      </Stack>
    </Frame>
  );
}
