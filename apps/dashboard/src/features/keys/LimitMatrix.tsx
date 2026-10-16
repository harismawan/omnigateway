import { Fragment } from "react";
import styled from "styled-components";
import type { LimitReading } from "../../api/types.ts";
import { Meter } from "../../ui/Meter.tsx";
import { Legend, Mono, Stack } from "../../ui/primitives.ts";
import { describeSlot, formatLimitValue, fractionOf, groupReadings } from "./limits.ts";

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

/** A scope's heading: the model an override applies to, or every model. */
const Heading = styled.h4`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.color.ink};
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
 *
 * A key with per-model overrides draws each scope under its own heading, the
 * key-wide limits first as "Every model": an override's ceiling read beside the
 * key's without one would read as a second key-wide window.
 */
export function LimitMatrix({ label, readings }: LimitMatrixProps) {
  const groups = groupReadings(readings);
  const grouped = groups.some((group) => group.model !== null);
  return (
    <Stack $gap={3}>
      {groups.map((group) => {
        const scope = group.model ?? "Every model";
        const grid = (
          <ScopeGrid key={scope} label={label} model={group.model} readings={group.readings} />
        );
        return grouped ? (
          <Stack key={scope} $gap={2} role="group" aria-label={scope}>
            <Heading>{scope}</Heading>
            {grid}
          </Stack>
        ) : (
          grid
        );
      })}
      <Note>
        Usage counts completed requests still inside each window. Requests in flight are added by
        the gateway itself and are not shown here. A model's override stacks with the key-wide
        limits: a request for it must pass both.
      </Note>
    </Stack>
  );
}

function ScopeGrid({
  label,
  model,
  readings,
}: {
  label: string;
  model: string | null;
  readings: readonly LimitReading[];
}) {
  // The meter is read aloud without the heading above it, so it names the model.
  const owner = model === null ? label : `${label}, ${model}`;
  return (
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
                // A bar is a bar: it saturates where the ceiling was passed,
                // while the figure beside it stays honest about by how much.
                fraction={Math.min(1, fraction)}
                label={`${owner}, ${name}, ${Math.round(fraction * 100)}% used`}
              />
            )}
            <Mono>{fraction === null ? "—" : `${Math.round(fraction * 100)}%`}</Mono>
          </Fragment>
        );
      })}
    </Grid>
  );
}
