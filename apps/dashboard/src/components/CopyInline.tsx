import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { type CopyOutcome, copyText } from "../lib/clipboard.ts";

const Wrap = styled.span`
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  max-width: 100%;
`;

const Text = styled.span`
  min-width: 0;
  word-break: break-all;
`;

const Action = styled.button`
  all: unset;
  cursor: pointer;
  flex: none;
  display: inline-flex;
  padding: 1px;
  color: ${({ theme }) => theme.color.inkDim};
  &:hover,
  &:focus-visible {
    color: ${({ theme }) => theme.color.accent};
  }
  svg {
    width: 12px;
    height: 12px;
  }
`;

export type CopyInlineProps = {
  value: string;
  /** Names the action, e.g. "Copy session". */
  label: string;
};

/**
 * A value with a small copy action beside it, for dense detail lists where
 * `CopyValue`'s framed field would be too heavy. Same clipboard path, so a
 * plain-HTTP gateway still falls back to selecting the value; the button's name
 * says what actually happened.
 */
export function CopyInline({ value, label }: CopyInlineProps) {
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (outcome === null) return;
    const timer = setTimeout(() => setOutcome(null), 1600);
    return () => clearTimeout(timer);
  }, [outcome]);

  const name =
    outcome === "copied"
      ? "Copied"
      : outcome === "selected"
        ? "Selected — copy it with your keyboard"
        : outcome === "failed"
          ? "Could not copy"
          : label;

  return (
    <Wrap>
      <Text ref={textRef}>{value}</Text>
      <Action
        type="button"
        aria-label={name}
        title={name}
        onClick={(event) => {
          event.stopPropagation();
          void copyText(value, textRef.current).then(setOutcome);
        }}
      >
        {outcome === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Action>
    </Wrap>
  );
}
