import styled, { css, keyframes } from "styled-components";
import type { LampState } from "../lib/vitals.ts";
import { LAMP_GLYPH } from "../lib/vitals.ts";

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.28; }
`;

/** CSS animation avoids a React timer and stops under reduced motion. */
const live = css`
  color: ${({ theme }) => theme.color.ok};
  animation: ${pulse} 1.2s ease-in-out infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const tone = {
  ok: css`
    color: ${({ theme }) => theme.color.ok};
  `,
  warn: css`
    color: ${({ theme }) => theme.color.warn};
  `,
  down: css`
    color: ${({ theme }) => theme.color.down};
  `,
  idle: css`
    color: ${({ theme }) => theme.color.inkFaint};
  `,
  live,
} as const;

const Glyph = styled.span<{ $state: LampState }>`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  line-height: 1;
  flex: none;
  ${({ $state }) => tone[$state]}
`;

export type LampProps = {
  state: LampState;
  /** Read by assistive tech in place of the glyph, e.g. "breaker open". */
  label: string;
  className?: string;
};

/**
 * A panel indicator: filled when healthy, half when probing or throttled,
 * hollow when the breaker is open, a dot when the credential is idle, and a
 * pulsing filled mark while a request is in flight. The glyph carries the state
 * as well as the colour, so it survives a monochrome screen.
 */
export function Lamp({ state, label, className }: LampProps) {
  return (
    <Glyph $state={state} className={className} role="img" aria-label={label} title={label}>
      {LAMP_GLYPH[state]}
    </Glyph>
  );
}
