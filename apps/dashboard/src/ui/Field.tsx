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
