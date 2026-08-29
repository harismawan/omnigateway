import styled from "styled-components";
import { Button } from "./Button.tsx";
import { Row } from "./primitives.ts";

/** A pressed-state control. Buttons rather than a select: the state is visible. */
export const Segment = styled(Button)<{ $on: boolean }>`
  border-color: ${({ theme, $on }) => ($on ? theme.color.accent : theme.color.ruleStrong)};
  color: ${({ theme, $on }) => ($on ? theme.color.accent : theme.color.inkDim)};
  background: ${({ theme, $on }) => ($on ? theme.color.accentWash : theme.color.panelRaised)};
`;

/**
 * The row a set of segments sits in.
 *
 * Here rather than beside the usage deck because the client surface picks a
 * window the same way the console does, and a second copy of the pressed-state
 * styling is one that gets tuned without this one.
 */
export const Controls = styled(Row)`
  gap: ${({ theme }) => theme.space(1)};
  flex-wrap: wrap;
`;
