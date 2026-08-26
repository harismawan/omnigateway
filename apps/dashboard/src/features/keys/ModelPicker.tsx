import styled from "styled-components";
import { Legend } from "../../ui/primitives.ts";

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

/** Matches `Field`'s own hint, for a control that draws its own label. */
const Hint = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

export type ModelPickerProps = {
  /** Every model the installation currently serves, from `GET /api/models`. */
  configured: string[];
  /** The allowlist as it stands, which may name models that no longer are. */
  checked: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean | undefined;
};

/**
 * The checkbox list of models a key may call, shared by minting and editing.
 *
 * A stored allowlist can outlive the models it names — a virtual model is
 * removed while keys still point at it — so the list rendered is the union of
 * what is configured and what is checked. Dropping a stale entry silently would
 * change the key without anyone deciding to; it stays visible here, still
 * removable deliberately, and goes back whole on save either way.
 */
export function ModelPicker({ configured, checked, onChange, disabled }: ModelPickerProps) {
  const named = [...new Set([...configured, ...checked])].sort();

  const toggle = (id: string, on: boolean) => {
    onChange(on ? [...checked, id] : checked.filter((entry) => entry !== id));
  };

  const stale = checked.filter((id) => !configured.includes(id));

  return (
    <div>
      <Choices>
        {named.map((id) => (
          <Choice key={id}>
            <input
              type="checkbox"
              disabled={disabled}
              aria-label={id}
              checked={checked.includes(id)}
              onChange={(event) => toggle(id, event.target.checked)}
            />
            {id}
          </Choice>
        ))}
      </Choices>
      {stale.length > 0 ? (
        <Hint>Some listed models are no longer configured. They stay until you clear them.</Hint>
      ) : null}
      {checked.length === 0 ? (
        <Legend>With nothing selected this key is allowed no model.</Legend>
      ) : null}
    </div>
  );
}
