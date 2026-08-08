import styled from "styled-components";

/**
 * A dense reading table. Rows are scanned in columns, so numeric cells are
 * monospaced and right-aligned, and the header is a row of legends rather than
 * sentence-case titles.
 */
export const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
`;

export const Th = styled.th<{ $align?: "left" | "right" | "center"; $width?: string }>`
  position: sticky;
  top: 0;
  z-index: 1;
  padding: ${({ theme }) => `${theme.space(1.5)} ${theme.space(2)}`};
  text-align: ${({ $align }) => $align ?? "left"};
  ${({ $width }) => ($width === undefined ? "" : `width: ${$width};`)}
  background: ${({ theme }) => theme.color.panelSunk};
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  font-size: 10px;
  font-weight: 600;
  font-stretch: 74%;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: ${({ theme }) => theme.color.inkFaint};
  white-space: nowrap;
`;

export const Td = styled.td<{ $align?: "left" | "right" | "center"; $mono?: boolean }>`
  padding: ${({ theme }) => `${theme.space(1.5)} ${theme.space(2)}`};
  text-align: ${({ $align }) => $align ?? "left"};
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  vertical-align: middle;
  ${({ theme, $mono }) =>
    $mono === true
      ? `font-family: ${theme.font.mono}; font-variant-numeric: tabular-nums; font-size: 12px;`
      : ""}
`;

export const Tr = styled.tr<{ $selectable?: boolean; $selected?: boolean }>`
  background: ${({ theme, $selected }) => ($selected === true ? theme.color.accentWash : "transparent")};
  ${({ $selectable }) => ($selectable === true ? "cursor: pointer;" : "")}

  &:hover {
    background: ${({ theme, $selected }) =>
      $selected === true ? theme.color.accentWash : theme.color.panelSunk};
  }

  &:last-child td {
    border-bottom: 0;
  }
`;
