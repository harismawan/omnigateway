import styled from "styled-components";
import { Field, NumberInput } from "../../ui/Field.tsx";
import { Stack } from "../../ui/primitives.ts";
import { describeSlot, LIMIT_SLOTS, type LimitDraft, slotKey } from "./limits.ts";

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: ${({ theme }) => theme.space(2)};
`;

const Note = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

export type LimitFieldsProps = {
  draft: LimitDraft;
  onChange: (draft: LimitDraft) => void;
  disabled?: boolean;
};

/**
 * The whole `(dimension, window)` matrix as nine fields.
 *
 * Every cell is blank by default and blank means unlimited, so an operator who
 * wants one ceiling types one number. The same component serves minting and
 * editing: a limit is the operator's own ceiling on their own installation, and
 * the two screens must not be able to disagree about what can be set.
 */
export function LimitFields({ draft, onChange, disabled = false }: LimitFieldsProps) {
  return (
    <Stack $gap={2}>
      <Grid>
        {LIMIT_SLOTS.map((slot) => {
          const key = slotKey(slot);
          return (
            <Field key={key} label={describeSlot(slot)}>
              {(props) => (
                <NumberInput
                  {...props}
                  min={slot.dimension === "spend" ? undefined : 1}
                  step={slot.dimension === "spend" ? "any" : 1}
                  disabled={disabled}
                  value={draft[key] ?? ""}
                  placeholder="none"
                  onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
                />
              )}
            </Field>
          );
        })}
      </Grid>
      <Note>
        Blank means no limit. Token and spend ceilings are debited after a response completes, so a
        key at its ceiling is refused on its next request rather than its current one. Concurrency
        counts requests in flight right now and resets when the gateway restarts.
      </Note>
    </Stack>
  );
}
