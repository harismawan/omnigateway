import styled from "styled-components";
import type { ProviderId } from "../api/types.ts";
import { providerColor } from "../theme/tokens.ts";

export type ChipTone = "neutral" | "ok" | "warn" | "down" | "accent";

const tones: Record<ChipTone, { fg: string; bg: string }> = {
  neutral: { fg: "var(--ink-dim)", bg: "transparent" },
  ok: { fg: "var(--ok)", bg: "var(--ok-wash)" },
  warn: { fg: "var(--warn)", bg: "var(--warn-wash)" },
  down: { fg: "var(--down)", bg: "var(--down-wash)" },
  accent: { fg: "var(--accent)", bg: "var(--accent-wash)" },
};

/** A short status word. Never a sentence, never the only carrier of meaning. */
export const Chip = styled.span<{ $tone?: ChipTone }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  border-radius: ${({ theme }) => theme.radius.chip};
  border: 1px solid currentColor;
  background: ${({ $tone }) => tones[$tone ?? "neutral"].bg};
  color: ${({ $tone }) => tones[$tone ?? "neutral"].fg};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 10.5px;
  letter-spacing: 0.02em;
  white-space: nowrap;
`;

const Tag = styled.span<{ $provider: ProviderId }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11.5px;
  color: ${({ $provider }) => providerColor($provider)};
  white-space: nowrap;

  &::before {
    content: "";
    width: 3px;
    height: 11px;
    border-radius: 1px;
    background: currentColor;
    flex: none;
  }
`;

/**
 * A provider's identity. The colour bar is the only place a hue is allowed to
 * stand for a name rather than a state, and it is always paired with the text.
 */
export function ProviderTag({ provider, className }: { provider: ProviderId; className?: string }) {
  return (
    <Tag $provider={provider} className={className}>
      {provider}
    </Tag>
  );
}
