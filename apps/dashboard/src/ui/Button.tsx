import styled, { css } from "styled-components";

export type ButtonVariant = "primary" | "default" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const variants = {
  primary: css`
    background: ${({ theme }) => theme.color.accent};
    color: ${({ theme }) => theme.color.accentInk};
    border-color: ${({ theme }) => theme.color.accent};

    &:hover:not(:disabled) {
      filter: brightness(1.08);
    }
  `,
  default: css`
    background: ${({ theme }) => theme.color.panelRaised};
    color: ${({ theme }) => theme.color.ink};
    border-color: ${({ theme }) => theme.color.ruleStrong};

    &:hover:not(:disabled) {
      border-color: ${({ theme }) => theme.color.accent};
      color: ${({ theme }) => theme.color.accent};
    }
  `,
  ghost: css`
    background: transparent;
    color: ${({ theme }) => theme.color.inkDim};
    border-color: transparent;

    &:hover:not(:disabled) {
      background: ${({ theme }) => theme.color.panelRaised};
      color: ${({ theme }) => theme.color.ink};
    }
  `,
  danger: css`
    background: transparent;
    color: ${({ theme }) => theme.color.down};
    border-color: ${({ theme }) => theme.color.down};

    &:hover:not(:disabled) {
      background: ${({ theme }) => theme.color.downWash};
    }
  `,
} as const;

const sizes = {
  sm: css`
    height: 24px;
    padding: 0 ${({ theme }) => theme.space(2)};
    font-size: 11px;
  `,
  md: css`
    height: 30px;
    padding: 0 ${({ theme }) => theme.space(3)};
    font-size: 13px;
  `,
} as const;

/**
 * A panel control. Labels say what happens when it is used — "Save changes",
 * "Revoke key" — and keep the same wording through the flow they start.
 */
export const Button = styled.button<{ $variant?: ButtonVariant; $size?: ButtonSize }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.space(1.5)};
  border: 1px solid transparent;
  border-radius: ${({ theme }) => theme.radius.control};
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease,
    border-color 120ms ease;

  ${({ $size }) => sizes[$size ?? "md"]}
  ${({ $variant }) => variants[$variant ?? "default"]}

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  svg {
    width: 14px;
    height: 14px;
  }
`;

/** A square button holding a single icon; needs an accessible label. */
export const IconButton = styled(Button)`
  padding: 0;
  width: ${({ $size }) => ($size === "sm" ? "24px" : "30px")};
`;
