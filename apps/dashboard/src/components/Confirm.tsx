import styled from "styled-components";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";

const Body = styled.p`
  font-size: 13px;
  color: ${({ theme }) => theme.color.inkDim};
`;

export type ConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen, stated plainly. No apology, no hedging. */
  body: string;
  /** Repeats the verb from the button that opened this dialog. */
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
};

/** The one gate in front of an action that cannot be undone. */
export function Confirm({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
}: ConfirmProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      width="420px"
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" $variant="danger" disabled={busy === true} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Body>{body}</Body>
    </Modal>
  );
}
