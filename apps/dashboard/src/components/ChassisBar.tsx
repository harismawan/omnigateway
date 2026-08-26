import { useNavigate } from "@tanstack/react-router";
import { LogOut, MonitorCog, Moon, Sun } from "lucide-react";
import { useMemo } from "react";
import styled from "styled-components";
import { useLogout, useLogs } from "../api/queries.ts";
import { formatMs, formatPercent, formatUsd } from "../lib/format.ts";
import { bucketLogs, summarize } from "../lib/vitals.ts";
import { useLive } from "../session/live.tsx";
import { type ThemeMode, useTheme } from "../theme/ThemeProvider.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Lamp } from "../ui/Lamp.tsx";
import { Legend, Mono, Row, Spacer, scored } from "../ui/primitives.ts";
import { Sparkline } from "../ui/Sparkline.tsx";

const Bar = styled.header`
  grid-area: chassis;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(3)};
  height: 48px;
  padding: 0 ${({ theme }) => theme.space(3)};
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panel};
  ${scored}
  position: sticky;
  top: 0;
  z-index: ${({ theme }) => theme.z.chassis};
`;

const Mark = styled.div`
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-stretch: 74%;
  font-weight: 700;
  letter-spacing: 0.2em;
  font-size: 12px;
  text-transform: uppercase;
  flex: none;
`;

const Ticker = styled(Row)`
  gap: ${({ theme }) => theme.space(3)};
  overflow: hidden;

  @media (max-width: 860px) {
    display: none;
  }
`;

const Cell = styled.div`
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding-left: ${({ theme }) => theme.space(3)};
  border-left: 1px solid ${({ theme }) => theme.color.rule};
  white-space: nowrap;
`;

const TraceCell = styled(Cell)`
  width: 96px;
  align-items: center;
`;

const TraceBox = styled.div`
  flex: 1;
  min-width: 0;
`;

const LiveButton = styled(Button)`
  gap: 6px;
  font-family: ${({ theme }) => theme.font.mono};
  letter-spacing: 0.08em;
`;

/** Decoration between the two halves of the live label, and nothing more. */
const Separator = styled.span`
  color: ${({ theme }) => theme.color.inkFaint};
`;

/**
 * The four things the refresh switch can be, and what each is called.
 *
 * ## Why an explicit `aria-label` when there was none before
 *
 * The accessible name used to be the button's own text, which was fine while
 * that text was one word. Four labels containing a middle dot would freeze
 * `LIVE·PUSH` — punctuation and all — into every assertion that names this
 * button, so the visual label could not be reworded without editing tests that
 * are not about wording. The name is stated separately, the separator is hidden
 * from assistive tech, and the two are free to move independently.
 *
 * `aria-pressed` stays bound to the LIVE switch alone. It answers "am I
 * refreshing", which is the only thing pressing this button changes; whether
 * the refresh arrives on a socket or on an interval is not something the
 * operator toggled and must not be reported as though it were.
 *
 * `offline` is about this transport, not about the gateway. The mark lamp at
 * the far left already says "gateway unreachable" and it is reading a different
 * signal — one of them being wrong is useful information, and two indicators
 * that always agree hide that.
 */
const LIVE_STATES = {
  push: {
    name: "live, pushing",
    lamp: "live",
    head: "LIVE",
    tail: "PUSH",
    title: "Refreshing on gateway push — pause refreshing",
  },
  poll: {
    name: "live, polling",
    lamp: "ok",
    head: "LIVE",
    tail: "POLL",
    title: "Refreshing on a timer — pause refreshing",
  },
  paused: {
    name: "paused",
    lamp: "idle",
    head: "PAUSED",
    tail: null,
    title: "Resume refreshing",
  },
  offline: {
    name: "offline",
    lamp: "down",
    head: "OFFLINE",
    tail: null,
    title: "Not refreshing — the admin session ended, sign in again",
  },
} as const;

const MODE_ORDER: ThemeMode[] = ["system", "light", "dark"];
const MODE_LABEL: Record<ThemeMode, string> = {
  system: "Match system theme",
  light: "Light theme",
  dark: "Dark theme",
};

/** Ten minutes of traffic, which is what the log tail reliably covers. */
const WINDOW_MS = 600_000;

/**
 * The rack's top strip: it never changes between screens, so the operator can
 * read the gateway's pulse without deciding to go look at it.
 */
export function ChassisBar() {
  const navigate = useNavigate();
  const { live, toggle, cadence, connection } = useLive();
  const { mode, setMode } = useTheme();
  const logout = useLogout();
  const logs = useLogs(200, cadence(10_000, "res:logs"));

  const now = Date.now();
  const rows = useMemo(
    () => (logs.data ?? []).filter((log) => now - log.at <= WINDOW_MS),
    [logs.data, now],
  );
  const vitals = summarize(rows, WINDOW_MS);
  const buckets = bucketLogs(rows, { now, spanMs: WINDOW_MS, count: 24 });

  const nextMode = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length] ?? "system";
  const ThemeIcon = mode === "light" ? Sun : mode === "dark" ? Moon : MonitorCog;

  // Paused outranks the transport, exactly as `cadence` does: an operator who
  // switched refreshing off is not interested in how it would have arrived.
  const refresh = !live
    ? "paused"
    : connection.status === "offline"
      ? "offline"
      : connection.status === "push"
        ? "push"
        : "poll";
  const chip = LIVE_STATES[refresh];

  const health =
    logs.isError || vitals.errorRate >= 0.25
      ? "down"
      : vitals.errorRate >= 0.05
        ? "warn"
        : rows.length === 0
          ? "idle"
          : "ok";

  return (
    <Bar>
      <Mark>
        <Lamp
          state={health}
          label={
            logs.isError ? "gateway unreachable" : `error rate ${formatPercent(vitals.errorRate)}`
          }
        />
        Omnigateway
      </Mark>

      <Ticker>
        <TraceCell>
          <Legend>req</Legend>
          <TraceBox>
            <Sparkline
              values={buckets.map((b) => b.total)}
              overlay={buckets.map((b) => b.errors)}
              height={22}
              label={`${vitals.requests} requests in the last 10 minutes`}
            />
          </TraceBox>
        </TraceCell>
        <Cell>
          <Legend>rate</Legend>
          <Mono>{vitals.ratePerMin.toFixed(1)}</Mono>
          <Legend>/min</Legend>
        </Cell>
        <Cell>
          <Legend>err</Legend>
          <Mono style={{ color: vitals.errorRate >= 0.05 ? "var(--down)" : undefined }}>
            {formatPercent(vitals.errorRate)}
          </Mono>
        </Cell>
        <Cell>
          <Legend>ttft p50</Legend>
          <Mono>{formatMs(vitals.ttftP50)}</Mono>
        </Cell>
        <Cell>
          <Legend>spend</Legend>
          <Mono>{formatUsd(vitals.costUsd)}</Mono>
        </Cell>
      </Ticker>

      <Spacer />

      <LiveButton
        type="button"
        $size="sm"
        onClick={toggle}
        aria-pressed={live}
        aria-label={chip.name}
        title={chip.title}
      >
        <Lamp state={chip.lamp} label={chip.name} />
        {chip.head}
        {chip.tail === null ? null : (
          <>
            <Separator aria-hidden="true">·</Separator>
            {chip.tail}
          </>
        )}
      </LiveButton>

      <IconButton
        type="button"
        $variant="ghost"
        $size="sm"
        onClick={() => setMode(nextMode)}
        aria-label={MODE_LABEL[mode]}
        title={`${MODE_LABEL[mode]} — switch to ${MODE_LABEL[nextMode].toLowerCase()}`}
      >
        <ThemeIcon />
      </IconButton>

      <IconButton
        type="button"
        $variant="ghost"
        $size="sm"
        aria-label="Sign out"
        title="Sign out"
        disabled={logout.isPending}
        onClick={() => {
          logout.mutate(undefined, { onSuccess: () => void navigate({ to: "/login" }) });
        }}
      >
        <LogOut />
      </IconButton>
    </Bar>
  );
}
