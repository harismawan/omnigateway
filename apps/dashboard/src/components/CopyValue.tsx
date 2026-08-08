import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { type CopyOutcome, copyText } from "../lib/clipboard.ts";
import { IconButton } from "../ui/Button.tsx";
import { Stack } from "../ui/primitives.ts";

const Frame = styled.div`
  display: flex;
  align-items: stretch;
  gap: 0;
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: ${({ theme }) => theme.radius.control};
  background: ${({ theme }) => theme.color.panelSunk};
  overflow: hidden;
`;

const Value = styled.code`
  flex: 1;
  min-width: 0;
  padding: 7px 8px;
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  word-break: break-all;
  user-select: all;
`;

const Action = styled(IconButton)`
  border: 0;
  border-left: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: 0;
  height: auto;
  width: 32px;
  flex: none;
`;

const Hint = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.warn};
`;

/** Said once, in the operator's terms: what happened and what to do about it. */
const HINT: Partial<Record<CopyOutcome, string>> = {
  selected: "Your browser would not copy it. The value is selected — copy it with your keyboard.",
  failed: "Your browser would not copy it. Select the value and copy it by hand.",
};

export type CopyValueProps = {
  value: string;
  /** Names the thing being copied, e.g. "Copy API key". */
  label: string;
};

/**
 * Shows a value and copies it on demand.
 *
 * Used for the one response that ever contains a raw gateway key: it exists in
 * plaintext nowhere else, so a copy that quietly did nothing is worse than an
 * obvious failure. Every attempt reports its real outcome.
 */
export function CopyValue({ value, label }: CopyValueProps) {
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);
  const valueRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Only the success badge reverts; a failure notice stays until the operator
    // tries again, since it is the thing they still have to act on.
    if (outcome !== "copied") return;
    const timer = setTimeout(() => setOutcome(null), 1600);
    return () => clearTimeout(timer);
  }, [outcome]);

  const copy = useCallback(() => {
    void copyText(value, valueRef.current).then(setOutcome);
  }, [value]);

  const copied = outcome === "copied";
  const hint = outcome === null ? undefined : HINT[outcome];

  return (
    <Stack $gap={1}>
      <Frame>
        <Value ref={valueRef}>{value}</Value>
        <Action
          type="button"
          $variant="ghost"
          onClick={copy}
          aria-label={copied ? "Copied" : label}
          title={copied ? "Copied" : label}
        >
          {copied ? <Check /> : <Copy />}
        </Action>
      </Frame>
      {hint === undefined ? null : <Hint role="status">{hint}</Hint>}
    </Stack>
  );
}
