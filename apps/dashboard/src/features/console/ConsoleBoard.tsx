import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { CONSOLE_CADENCE_MS, useConsole, useNodes } from "../../api/queries.ts";
import type { ConsoleLine, ConsoleResponse } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { formatCount } from "../../lib/format.ts";
import { CONSOLE_TOPIC, invalidateTopic } from "../../session/invalidation.ts";
import { useLive } from "../../session/live.tsx";
import { type TopicMessage, useHeldStreamTopic, useStreamTopic } from "../../session/stream.tsx";
import { Select } from "../../ui/Field.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Muted, Row } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { keepLevel, readConsoleFrame } from "./pushedLines.ts";

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

const Board = styled.div`
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: ${({ theme }) => theme.space(4)};
  min-height: 0;
  flex: 1;
`;

const ConsoleModule = styled(Module)`
  min-height: 0;

  > div {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
`;

const Terminal = styled.div`
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: auto;
`;

const Lines = styled.pre`
  margin: 0;
  padding: ${({ theme }) => theme.space(3)};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  line-height: 1.65;
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
        Reading <Path>{read.path}</Path>, named by <Path>OMNI_LOG_FILE</Path>. That variable says
        where the gateway's output is being captured; it does not redirect it.
      </Hint>
    );
  }
  if (read.source === "journal") {
    return (
      <Hint>
        Reading the systemd journal for <Path>omnigateway.service</Path>. To read a file instead,
        redirect the gateway's output to one and point <Path>OMNI_LOG_FILE</Path> at the same path.
      </Hint>
    );
  }
  return null;
}

/**
 * Deltas received over `stream:console`, tagged with the REST read they sit on
 * top of. Tagged rather than bare, because the tag is what makes "this read has
 * been replaced" a comparison during render instead of a clearing effect.
 */
type Pushed = { read: ConsoleResponse | undefined; lines: ConsoleLine[] };

/** Stable identities, so a render with nothing appended is not a new array. */
const NO_LINES: ConsoleLine[] = [];
const NOTHING_PUSHED: Pushed = { read: undefined, lines: NO_LINES };

/**
 * The gateway's own output: what the process is doing, not what clients asked
 * for.
 *
 * ## What is on screen is a REST window plus the deltas pushed since
 *
 * `useConsole` is the whole truth up to the instant it was served, and the only
 * truth when the socket is degraded, refused, or absent. `stream:console`
 * frames are appended to it, never rendered instead of it — a panel fed by
 * frames alone is blank on every installation whose log capture is `none`, and
 * blank on the third drop of any other.
 *
 * The accumulated deltas therefore belong to the read they were appended to,
 * and are held beside it rather than beside nothing: that read is a window
 * ending at its own moment, so anything pushed before it is already inside it
 * and keeping both would print those lines twice. Comparing during render
 * rather than clearing in an effect means the superseded deltas are never
 * rendered even once — React's own "adjusting state when a prop changes", which
 * is exactly this shape. react-query's structural sharing means an identical
 * answer keeps its identity and supersedes nothing, so a poll that found no new
 * output is not a flicker.
 *
 * ## Push and poll must not be able to disagree
 *
 * The gateway publishes deltas through the same `parseConsoleLines` the REST
 * read uses, which settles parsing and selection. What it cannot settle is the
 * *level filter*, because a frame is written once for every subscriber and this
 * panel's filter is local state — so the gateway sends everything and the
 * filtering happens here, against the ordering imported from `@omni/ir`. See
 * `pushedLines.ts` for why that one comparison is restated rather than
 * imported from `@omni/control`, which this app may not reach.
 */
export function ConsoleBoard() {
  const { cadence } = useLive();
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<number>(200);
  const [level, setLevel] = useState<string>("");
  // Which process. `""` is the one that answered, which is what a single
  // process has always been shown and needs no selector; a fleet defaults to
  // every process merged, and the selector appears.
  const [chosen, setChosen] = useState<string>("");
  const nodes = useNodes().data?.nodes ?? [];
  const fleet = nodes.length > 1;
  const node = chosen === "" && fleet ? "all" : chosen;
  // A chosen process holds its own topic; the answering one and the merged
  // view both read the shared topic, which every process publishes on.
  const heldTopic = node === "" || node === "all" ? null : `${CONSOLE_TOPIC}:${node}`;
  const topic = heldTopic ?? CONSOLE_TOPIC;

  const consoleLog = useConsole(lines, level, cadence(CONSOLE_CADENCE_MS, topic), node);
  const read = consoleLog.data;
  const [pushed, setPushed] = useState<Pushed>(NOTHING_PUSHED);
  const appended = pushed.read === read ? pushed.lines : NO_LINES;
  // Capped at the page size the operator chose, from the end — the number this
  // panel already promises to show. The REST read arrives capped by the
  // gateway; the appended half is what would otherwise grow without bound in a
  // tab left open on a busy log overnight, so it is capped twice: once as it
  // accumulates, and again here against the read it sits on top of.
  const rows = useMemo(
    () => [...(read?.lines ?? []), ...appended].slice(-lines),
    [read, appended, lines],
  );
  const terminalRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);

  const onMessage = (message: TopicMessage): void => {
    // `open` and `refused` are transport status, delivered by topic to every
    // reader — they exist for plugin channels, which can be refused, and this
    // board is not one. Ignored explicitly rather than by falling through: the
    // arm below treats anything that is not a readable frame as a hole and
    // drops the accumulated tail, so an unhandled status arm would clear the
    // terminal on every reconnect and on every ack. `closed` is how a held
    // topic reports a gap, so it is read as one.
    if (message.kind !== "frame" && message.kind !== "gap" && message.kind !== "closed") return;
    const incoming = message.kind === "frame" ? readConsoleFrame(message.payload) : null;
    if (incoming === null) {
      // A `gap`, or a frame that could not be read whole. Both mean the same
      // thing — there is no honest way to append past this — and both are
      // answered the same way: drop what was accumulated and let a full REST
      // read supply the window. The socket already invalidated on a `gap`; a
      // malformed frame is this end's own discovery, so it asks here.
      setPushed({ read, lines: NO_LINES });
      if (message.kind === "frame") invalidateTopic(queryClient, CONSOLE_TOPIC);
      return;
    }
    const kept = incoming.filter((line) => keepLevel(line, level));
    if (kept.length === 0) return;
    // Through the updater rather than off `appended`, because two frames can
    // land in one batch: the second would otherwise read a value from before
    // the first and silently drop it.
    setPushed((current) => ({
      read,
      lines: [...(current.read === read ? current.lines : []), ...kept].slice(-lines),
    }));
  };
  useStreamTopic(CONSOLE_TOPIC, (message) => {
    if (heldTopic === null) onMessage(message);
  });
  useHeldStreamTopic(heldTopic, onMessage);

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (terminal !== null && followLatest.current && rows.length > 0) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }, [rows]);

  return (
    <Board>
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
            {fleet ? (
              <Narrow
                value={node}
                aria-label="Which process to show"
                onChange={(event) => setChosen(event.target.value)}
              >
                <option value="all">every process</option>
                {nodes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.self ? `${entry.id.slice(0, 8)} (this one)` : entry.id.slice(0, 8)}
                  </option>
                ))}
              </Narrow>
            ) : null}
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

      <ConsoleModule
        legend="Process output"
        meta={read === undefined ? undefined : <Muted>{sourceLabel(read)}</Muted>}
        flush
      >
        {read === undefined ? null : <SourceHint read={read} />}
        <Terminal
          ref={terminalRef}
          data-testid="console-terminal"
          onScroll={(event) => {
            const terminal = event.currentTarget;
            followLatest.current =
              terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <= 8;
          }}
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
              message="Its output is going to a terminal, so there is nothing to read back. To capture it, run the gateway under systemd with `omni service install`, or start it with `omni start`, which redirects output to a file and points OMNI_LOG_FILE at it."
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
            <Lines>
              {rows.map((line, index) => (
                // Nothing in a line is unique — the same message can repeat at
                // the same millisecond — so position is the only honest key.
                // biome-ignore lint/suspicious/noArrayIndexKey: no stable id exists
                <Line key={`${line.at ?? 0}-${index}`} $level={line.level}>
                  {line.nodeId === undefined
                    ? line.raw
                    : `[${line.nodeId.slice(0, 8)}] ${line.raw}`}
                </Line>
              ))}
            </Lines>
          )}
        </Terminal>
      </ConsoleModule>
    </Board>
  );
}

function sourceLabel(read: ConsoleResponse): string {
  if (read.source === "file") return "log file";
  if (read.source === "journal") return "systemd journal";
  if (read.source === "fleet") return "every process, merged";
  return "not captured";
}
