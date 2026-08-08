import type { ReactNode } from "react";
import styled from "styled-components";
import { Legend, Row, Spacer } from "./primitives.ts";

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
