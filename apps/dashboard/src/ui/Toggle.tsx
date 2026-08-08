import { Switch } from "radix-ui";
import styled from "styled-components";

const Root = styled(Switch.Root)`
  all: unset;
  width: 30px;
  height: 16px;
  padding: 2px;
  border-radius: 9px;
  background: ${({ theme }) => theme.color.ruleStrong};
  border: 1px solid ${({ theme }) => theme.color.rule};
  cursor: pointer;
  transition: background 140ms ease;
  flex: none;

  &[data-state="checked"] {
    background: ${({ theme }) => theme.color.ok};
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.color.accent};
    outline-offset: 2px;
  }
`;

const Thumb = styled(Switch.Thumb)`
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: ${({ theme }) => theme.color.panel};
  transition: transform 140ms ease;
  transform: translateX(0);
  will-change: transform;

  &[data-state="checked"] {
    transform: translateX(14px);
  }
`;

export type ToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Required: the switch shows no text of its own. */
  label: string;
  disabled?: boolean;
  id?: string;
};

export function Toggle({ checked, onCheckedChange, label, disabled, id }: ToggleProps) {
  return (
    <Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      {...(disabled === undefined ? {} : { disabled })}
      {...(id === undefined ? {} : { id })}
    >
      <Thumb />
    </Root>
  );
}
