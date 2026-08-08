import styled from "styled-components";

const Track = styled.div<{ $height: number }>`
  position: relative;
  width: 100%;
  height: ${({ $height }) => $height}px;
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.rule};
  border-radius: 2px;
  overflow: hidden;
`;

const Fill = styled.div<{ $fraction: number; $tone: string }>`
  height: 100%;
  width: ${({ $fraction }) => `${Math.max(0, Math.min(1, $fraction)) * 100}%`};
  background: ${({ $tone }) => $tone};
  transition: width 240ms ease;
`;

export type MeterProps = {
  fraction: number;
  /** Read aloud in place of the bar, e.g. "5h quota, 62% used". */
  label: string;
  height?: number;
  /** Colour by hand, e.g. by provider. Omit to colour by how full it is. */
  tone?: string;
  className?: string;
};

function toneFor(fraction: number): string {
  if (fraction >= 0.9) return "var(--down)";
  if (fraction >= 0.7) return "var(--warn)";
  return "var(--ok)";
}

/**
 * A quota or share bar. Colour is a threshold reading, not decoration: green
 * until the window is 70% spent, amber to 90%, red past it.
 */
export function Meter({ fraction, label, height = 6, tone, className }: MeterProps) {
  return (
    <Track
      className={className}
      $height={height}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.max(0, Math.min(1, fraction)) * 100)}
      aria-label={label}
      title={label}
    >
      <Fill $fraction={fraction} $tone={tone ?? toneFor(fraction)} />
    </Track>
  );
}
