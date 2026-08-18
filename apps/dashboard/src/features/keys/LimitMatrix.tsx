import { Fragment } from "react";
import styled from "styled-components";
import type { LimitReading } from "../../api/types.ts";
import { Meter } from "../../ui/Meter.tsx";
import { Legend, Mono, Stack } from "../../ui/primitives.ts";
import { describeSlot, formatLimitValue, fractionOf } from "./limits.ts";

const Grid = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 11rem) minmax(0, 12rem) minmax(0, 1fr) minmax(0, 3.5rem);
  align-items: center;
  gap: ${({ theme }) => theme.space(2)} ${({ theme }) => theme.space(4)};
`;

/** A figure nothing measures, said in words rather than left blank. */
const Absent = styled.span`
  font-size: 11.5px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const Note = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

export type LimitMatrixProps = {
  /** The key's label, so a meter read aloud says which key it belongs to. */
  label: string;
  readings: readonly LimitReading[];
};

/**
 * One key's full matrix, behind the row's disclosure.
 *
 * A table per row is not what an at-a-glance board is for — the same reason
 * quota history sits behind a disclosure rather than in a column — so the cell
 * carries the summary and this carries the detail.
 */
export function LimitMatrix({ label, readings }: LimitMatrixProps) {
  return (
    <Stack $gap={3}>
      <Grid>
        {readings.map((reading) => {
          const name = describeSlot({ dimension: reading.dimension, window: reading.window });
          const fraction = fractionOf(reading);
          const ceiling = formatLimitValue(reading.dimension, reading.limit);
          return (
            <Fragment key={name}>
              <Legend as="span">{name}</Legend>
              <Mono>
                {reading.used === null
                  ? ceiling
                  : `${formatLimitValue(reading.dimension, reading.used)} of ${ceiling}`}
              </Mono>
              {fraction === null ? (
                <Absent>in flight now, counted in the gateway process</Absent>
              ) : (
                <Meter
                  fraction={fraction}
                  label={`${label}, ${name}, ${Math.round(fraction * 100)}% used`}
                />
              )}
              <Mono>{fraction === null ? "—" : `${Math.round(fraction * 100)}%`}</Mono>
            </Fragment>
          );
        })}
      </Grid>
      <Note>
        Usage counts completed requests still inside each window. Requests in flight are added by
        the gateway itself and are not shown here.
      </Note>
    </Stack>
  );
}
