import type { ReactNode } from "react";
import styled from "styled-components";
import { Legend, Row, ScrollX, Spacer } from "./primitives.ts";

/**
 * A module in the rack. Every screen is built from these: a face with a
 * silkscreened legend along the top edge, controls on the right of that legend,
 * and content below.
 */
export const Panel = styled.section<{ $flush?: boolean }>`
  background: ${({ theme }) => theme.color.panel};
  border: 1px solid ${({ theme }) => theme.color.rule};
  border-radius: ${({ theme }) => theme.radius.panel};
  box-shadow: ${({ theme }) => theme.color.shadow};
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* A panel is a flex item of the rack's scrolling column, and overflow: hidden
     drops its automatic minimum height to zero: left shrinkable it squeezes to the
     viewport and clips its own rows instead of letting the column scroll. Boards
     that want a panel to fill and scroll inside itself say so with flex: 1. */
  flex-shrink: 0;
`;

/**
 * A module that fills the rest of the rack's column and scrolls inside itself,
 * so a long table keeps the page head and the sticky column headings in view.
 * `flex: 1` overrides the panel's `flex-shrink: 0`; the body is made a flex
 * column so `FillScroller` can take the remaining height.
 */
export const FillModule = styled(Module)`
  flex: 1;
  min-height: 0;

  > div {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
`;

export const FillScroller = styled(ScrollX)`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
`;

const Head = styled.header`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => `${theme.space(2)} ${theme.space(3)}`};
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panelSunk};
  min-height: 34px;
`;

const Body = styled.div<{ $flush?: boolean }>`
  padding: ${({ theme, $flush }) => ($flush === true ? "0" : theme.space(3))};
  min-width: 0;
`;

const Foot = styled.footer`
  padding: ${({ theme }) => `${theme.space(2)} ${theme.space(3)}`};
  border-top: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panelSunk};
`;

export type PanelModuleProps = {
  legend: string;
  /** Small right-aligned text in the legend bar, e.g. a count or a timestamp. */
  meta?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Drop body padding when the content is a table that draws its own edges. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
};

export function Module({
  legend,
  meta,
  actions,
  footer,
  flush,
  className,
  children,
}: PanelModuleProps) {
  return (
    <Panel className={className}>
      <Head>
        <Legend>{legend}</Legend>
        {meta === undefined ? null : <Legend as="span">{meta}</Legend>}
        <Spacer />
        {actions === undefined ? null : <Row $gap={1}>{actions}</Row>}
      </Head>
      <Body {...(flush === true ? { $flush: true } : {})}>{children}</Body>
      {footer === undefined ? null : <Foot>{footer}</Foot>}
    </Panel>
  );
}
