import styled, { css, keyframes } from "styled-components";

/**
 * The silkscreened label on a piece of equipment: condensed, tracked out, and
 * always an annotation of a panel rather than content inside it.
 */
export const Legend = styled.span`
  font-size: 10px;
  font-weight: 600;
  font-stretch: 74%;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: ${({ theme }) => theme.color.inkFaint};
  white-space: nowrap;
`;

/** Every number on the console is monospaced and tabular so columns hold still. */
export const Mono = styled.span<{ $dim?: boolean; $size?: string }>`
  font-family: ${({ theme }) => theme.font.mono};
  font-variant-numeric: tabular-nums;
  font-size: ${({ $size }) => $size ?? "12px"};
  color: ${({ theme, $dim }) => ($dim === true ? theme.color.inkDim : "inherit")};
`;

export const Muted = styled.span`
  color: ${({ theme }) => theme.color.inkDim};
`;

export const Row = styled.div<{
  $gap?: number;
  $wrap?: boolean;
  $align?: string;
  $justify?: string;
}>`
  display: flex;
  align-items: ${({ $align }) => $align ?? "center"};
  justify-content: ${({ $justify }) => $justify ?? "flex-start"};
  gap: ${({ theme, $gap }) => theme.space($gap ?? 2)};
  ${({ $wrap }) => ($wrap === true ? "flex-wrap: wrap;" : "")}
  min-width: 0;
`;

export const Stack = styled.div<{ $gap?: number }>`
  display: flex;
  flex-direction: column;
  gap: ${({ theme, $gap }) => theme.space($gap ?? 2)};
  min-width: 0;
`;

export const Grid = styled.div<{ $min?: string; $gap?: number }>`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(${({ $min }) => $min ?? "220px"}, 1fr));
  gap: ${({ theme, $gap }) => theme.space($gap ?? 3)};
  /* Panels size to their content; a short one does not stretch to match a tall one. */
  align-items: start;
`;

export const Divider = styled.hr`
  height: 1px;
  border: 0;
  margin: 0;
  background: ${({ theme }) => theme.color.rule};
`;

export const Spacer = styled.div`
  flex: 1 1 auto;
  min-width: 0;
`;

/** Wide tables scroll inside their module; the page itself never does. */
export const ScrollX = styled.div`
  overflow-x: auto;
  overscroll-behavior-x: contain;
`;

/** One-line text that gives up width before it pushes a layout around. */
export const Truncate = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
`;

export const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`;

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

export const pulsing = css`
  animation: ${pulse} 2.4s ease-in-out infinite;
`;

/** The faint horizontal scoring that reads as a brushed panel face. */
export const scored = css`
  background-image: repeating-linear-gradient(
    to bottom,
    var(--grid-line) 0 1px,
    transparent 1px 4px
  );
`;
