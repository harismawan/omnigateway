import styled, { css, keyframes } from "styled-components";
import type { LampState } from "../lib/vitals.ts";
import { LAMP_GLYPH } from "../lib/vitals.ts";

/**
 * Four quadrants, stepped rather than eased, so the glyph reads as a rotating
 * mark instead of a cross-fade. `steps(1)` per stop holds each frame for its
 * whole quarter; a smooth timing function would interpolate nothing, since
 * `content` cannot be tweened.
 */
const spin = keyframes`
  0%   { content: "◜"; }
  25%  { content: "◝"; }
  50%  { content: "◞"; }
  75%  { content: "◟"; }
  100% { content: "◜"; }
`;

/**
 * Animating `content` on a pseudo-element rather than swapping a React state:
 * the log table re-renders on every poll, and a frame counter in JS would make
 * every row re-render between them as well.
 */
const live = css`
  color: ${({ theme }) => theme.color.inkFaint};

  /* The frames are drawn here, so the element's own text stays empty and the
     accessible name comes from aria-label alone. */
  &::before {
    content: "◜";
    animation: ${spin} 0.8s steps(1, end) infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    &::before {
      content: "${LAMP_GLYPH.live}";
      animation: none;
    }
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
 * turning mark while a request is in flight. The glyph carries the state as
 * well as the colour, so it survives a monochrome screen.
 */
export function Lamp({ state, label, className }: LampProps) {
  return (
    <Glyph $state={state} className={className} role="img" aria-label={label} title={label}>
      {/* `live` draws its frames from CSS, so the element carries no text and
          assistive tech reads the label rather than a glyph mid-rotation. */}
      {state === "live" ? "" : LAMP_GLYPH[state]}
    </Glyph>
  );
}
