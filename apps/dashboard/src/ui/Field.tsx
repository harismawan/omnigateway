import { type ReactNode, useId } from "react";
import styled from "styled-components";
import { Legend } from "./primitives.ts";

const control = `
  width: 100%;
  border-radius: 3px;
  transition: border-color 120ms ease;
`;

export const Input = styled.input`
  ${control}
  height: 30px;
  padding: 0 8px;
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  color: ${({ theme }) => theme.color.ink};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;

  &::placeholder {
    color: ${({ theme }) => theme.color.inkFaint};
    font-family: ${({ theme }) => theme.font.sans};
  }

  &:hover:not(:disabled) {
    border-color: ${({ theme }) => theme.color.accent};
  }

  &:disabled {
    opacity: 0.5;
  }
`;

/**
 * A multi-line text field, for prose rather than identifiers: the sans face and
 * a resize handle, otherwise dressed like `Input`.
 */
export const Textarea = styled.textarea`
  ${control}
  min-height: 120px;
  padding: 6px 8px;
  resize: vertical;
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  color: ${({ theme }) => theme.color.ink};
  font-family: ${({ theme }) => theme.font.sans};
  font-size: 12px;
  line-height: 1.5;

  &:hover:not(:disabled) {
    border-color: ${({ theme }) => theme.color.accent};
  }

  &:disabled {
    opacity: 0.5;
  }
`;

/**
 * A native select. Radix's is prettier, but this is a dense operator console:
 * native gives keyboard type-ahead and the platform's own scrolling for free,
 * and it stays usable when a model has thirty targets. The platform arrow sits
 * flush against the border wherever the browser puts it, so it is replaced by
 * a drawn chevron inset to match the text padding.
 */
export const Select = styled.select`
  ${control}
  appearance: none;
  height: 30px;
  padding: 0 26px 0 8px;
  background-color: ${({ theme }) => theme.color.panelSunk};
  background-image:
    linear-gradient(45deg, transparent 50%, ${({ theme }) => theme.color.inkDim} 50%),
    linear-gradient(135deg, ${({ theme }) => theme.color.inkDim} 50%, transparent 50%);
  background-position:
    calc(100% - 15px) 50%,
    calc(100% - 10px) 50%;
  background-size: 5px 5px;
  background-repeat: no-repeat;
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  color: ${({ theme }) => theme.color.ink};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: ${({ theme }) => theme.color.accent};
  }
`;

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
`;

const Hint = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const Problem = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.down};
`;

export type FieldProps = {
  label: string;
  hint?: string;
  /** What went wrong and what to do about it, in the interface's own voice. */
  problem?: string;
  children: (props: { id: string; "aria-describedby": string | undefined }) => ReactNode;
};

export function Field({ label, hint, problem, children }: FieldProps) {
  const id = useId();
  const describedBy =
    problem !== undefined ? `${id}-problem` : hint !== undefined ? `${id}-hint` : undefined;

  return (
    <Wrap>
      <Legend as="label" htmlFor={id}>
        {label}
      </Legend>
      {children({ id, "aria-describedby": describedBy })}
      {problem !== undefined ? (
        <Problem id={`${id}-problem`}>{problem}</Problem>
      ) : hint !== undefined ? (
        <Hint id={`${id}-hint`}>{hint}</Hint>
      ) : null}
    </Wrap>
  );
}

/** A compact numeric cell used inside dense editors, e.g. a target's tier. */
export const NumberInput = styled(Input).attrs({ type: "number", inputMode: "decimal" })`
  text-align: right;
  padding-right: 6px;
`;
