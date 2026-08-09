import { useState } from "react";
import styled from "styled-components";
import { CONSOLE_CADENCE_MS, useConsole } from "../../api/queries.ts";
import type { ConsoleLine, ConsoleResponse } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { formatCount } from "../../lib/format.ts";
import { useLive } from "../../session/live.tsx";
import { Select } from "../../ui/Field.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Muted, Row } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";

const LIMITS = [100, 200, 500] as const;
const LEVELS = [
  { value: "", label: "All levels" },
  { value: "debug", label: "Debug and above" },
  { value: "info", label: "Info and above" },
  { value: "warn", label: "Warnings and errors" },
  { value: "error", label: "Errors only" },
] as const;

const Controls = styled(Row)`
  gap: ${({ theme }) => theme.space(2)};
  flex-wrap: wrap;
`;

const Narrow = styled(Select)`
  width: auto;
`;

const Lines = styled.pre`
  margin: 0;
  padding: ${({ theme }) => theme.space(3)};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  line-height: 1.65;
  overflow-x: auto;
  white-space: pre;
`;

/**
 * One rendered line.
 *
 * Colour carries state and nothing else: a warning and an error are the two
 * things worth finding by eye. Debug is dimmed as the opposite case, and info —
 * along with any line the gateway did not write — takes the default.
 */
const Line = styled.div<{ $level: ConsoleLine["level"] }>`
  color: ${({ theme, $level }) =>
    $level === "error"
      ? theme.color.down
      : $level === "warn"
        ? theme.color.warn
        : $level === "debug"
          ? theme.color.inkFaint
          : theme.color.ink};
`;

const Hint = styled.p`
  margin: 0;
  padding: ${({ theme }) => `${theme.space(2)} ${theme.space(3)}`};
  border-top: 1px solid ${({ theme }) => theme.color.rule};
  color: ${({ theme }) => theme.color.inkDim};
  font-size: 12px;
`;

const Path = styled.code`
  font-family: ${({ theme }) => theme.font.mono};
  word-break: break-all;
`;

/**
 * Where these lines came from, and how to change it.
 *
 * Shown whatever the source, not only when there is nothing: an operator
 * reading a file who expected the journal needs to know as much as one reading
 * nothing at all.
 */
function SourceHint({ read }: { read: ConsoleResponse }) {
  if (read.source === "file") {
    return (
      <Hint>
        Reading <Path>{read.path}</Path>, set by <Path>OMNI_LOG_FILE</Path>.
      </Hint>
    );
  }
  if (read.source === "journal") {
    return (
      <Hint>
        Reading the systemd journal for <Path>omnigateway.service</Path>. To read a file instead,
        set <Path>OMNI_LOG_FILE=/path/to/gateway.log</Path> and restart the gateway.
      </Hint>
    );
  }
  return null;
}

/** The gateway's own output: what the process is doing, not what clients asked for. */
export function ConsoleBoard() {
  const { cadence } = useLive();
  const [lines, setLines] = useState<number>(200);
  const [level, setLevel] = useState<string>("");

  const consoleLog = useConsole(lines, level, cadence(CONSOLE_CADENCE_MS));
  const read = consoleLog.data;
  const rows = read?.lines ?? [];

  return (
    <>
      <PageHead
        legend="Console"
        title="Gateway output"
        summary={
          consoleLog.isLoading
            ? "Reading the gateway's own output…"
            : `${formatCount(rows.length)} lines of what this process is doing. Requests are in Logs; prompt bodies, tokens and keys are never written here.`
        }
        actions={
          <Controls>
            <Narrow
              value={level}
              aria-label="Which levels to show"
              onChange={(event) => setLevel(event.target.value)}
            >
              {LEVELS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Narrow>
            <Narrow
              value={lines}
              aria-label="How many lines to fetch"
              onChange={(event) => setLines(Number(event.target.value))}
            >
              {LIMITS.map((value) => (
                <option key={value} value={value}>
                  last {value}
                </option>
              ))}
            </Narrow>
          </Controls>
        }
      />

      <Module
        legend="Process output"
        meta={read === undefined ? undefined : <Muted>{sourceLabel(read)}</Muted>}
        flush
      >
        {consoleLog.isError ? (
          <Failure error={consoleLog.error} onRetry={() => void consoleLog.refetch()} />
        ) : consoleLog.isLoading ? (
          <div style={{ padding: 12 }}>
            <SkeletonRows rows={10} />
          </div>
        ) : read !== undefined && read.source === "none" ? (
          <Empty
            legend="Nothing is capturing this gateway"
            message="Its output is going to a terminal, so there is nothing to read back. To capture it, run the gateway under systemd with `omni service install`, or set OMNI_LOG_FILE=/path/to/gateway.log and restart it."
          />
        ) : rows.length === 0 ? (
          <Empty
            legend="Nothing to show"
            message={
              level === ""
                ? "This log is empty. The gateway writes here when it boots, refreshes a token, or polls a quota."
                : "No line in this window is at that level. Widen the filter to see everything."
            }
          />
        ) : (
          <>
            <Lines>
              {rows.map((line, index) => (
                // Nothing in a line is unique — the same message can repeat at
                // the same millisecond — so position is the only honest key.
                // biome-ignore lint/suspicious/noArrayIndexKey: no stable id exists
                <Line key={`${line.at ?? 0}-${index}`} $level={line.level}>
                  {line.raw}
                </Line>
              ))}
            </Lines>
            {read === undefined ? null : <SourceHint read={read} />}
          </>
        )}
      </Module>
    </>
  );
}

function sourceLabel(read: ConsoleResponse): string {
  if (read.source === "file") return "log file";
  if (read.source === "journal") return "systemd journal";
  return "not captured";
}
