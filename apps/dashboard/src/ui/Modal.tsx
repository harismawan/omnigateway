import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import styled from "styled-components";
import { IconButton } from "./Button.tsx";
import { Legend, Spacer } from "./primitives.ts";

const Overlay = styled(Dialog.Overlay)`
  position: fixed;
  inset: 0;
  z-index: ${({ theme }) => theme.z.overlay};
  background: oklch(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
`;

const Content = styled(Dialog.Content)<{ $width: string }>`
  position: fixed;
  z-index: ${({ theme }) => theme.z.dialog};
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(${({ $width }) => $width}, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: ${({ theme }) => theme.color.panel};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: ${({ theme }) => theme.radius.panel};
  box-shadow: 0 12px 40px oklch(0 0 0 / 0.35);
`;

const Head = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => `${theme.space(2)} ${theme.space(2)} ${theme.space(2)} ${theme.space(3)}`};
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panelSunk};
`;

const Scroll = styled.div`
  padding: ${({ theme }) => theme.space(3)};
  overflow-y: auto;
`;

const Foot = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => `${theme.space(2)} ${theme.space(3)}`};
  border-top: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panelSunk};
`;

const Description = styled(Dialog.Description)`
  margin: 0 0 ${({ theme }) => theme.space(3)};
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
`;

export type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  footer?: ReactNode;
  width?: string;
  children: ReactNode;
};

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  footer,
  width = "560px",
  children,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content $width={width}>
          <Head>
            <Dialog.Title asChild>
              <Legend as="h2">{title}</Legend>
            </Dialog.Title>
            <Spacer />
            <Dialog.Close asChild>
              <IconButton type="button" $variant="ghost" $size="sm" aria-label="Close">
                <X />
              </IconButton>
            </Dialog.Close>
          </Head>
          <Scroll>
            {description === undefined ? null : <Description>{description}</Description>}
            {children}
          </Scroll>
          {footer === undefined ? null : <Foot>{footer}</Foot>}
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
