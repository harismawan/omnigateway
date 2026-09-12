import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import styled from "styled-components";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Input } from "../../ui/Field.tsx";
import { Legend, Row } from "../../ui/primitives.ts";
import {
  dayKey,
  dayOf,
  formatRange,
  instantOf,
  monthDays,
  presetRange,
  rangeFor,
  timeOf,
  withinRange,
} from "./dateRange.ts";

const Trigger = styled(Popover.Trigger)`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  height: 30px;
  min-width: 230px;
  padding: 0 8px;
  border-radius: ${({ theme }) => theme.radius.control};
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  color: ${({ theme }) => theme.color.ink};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  cursor: pointer;
  transition: border-color 120ms ease;

  &:hover,
  &[data-state="open"] {
    border-color: ${({ theme }) => theme.color.accent};
  }

  svg {
    width: 13px;
    height: 13px;
    flex: none;
    color: ${({ theme }) => theme.color.inkFaint};
  }
`;

const Sheet = styled(Popover.Content)`
  z-index: ${({ theme }) => theme.z.dialog};
  width: 252px;
  padding: ${({ theme }) => theme.space(2)};
  background: ${({ theme }) => theme.color.panel};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: ${({ theme }) => theme.radius.panel};
  box-shadow: 0 12px 40px oklch(0 0 0 / 0.35);
`;

const Head = styled(Row)`
  justify-content: space-between;
  margin-bottom: ${({ theme }) => theme.space(2)};
`;

const Weeks = styled.div`
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
`;

const Weekday = styled.span`
  height: 20px;
  display: grid;
  place-items: center;
  font-size: 10px;
  color: ${({ theme }) => theme.color.inkFaint};
  font-family: ${({ theme }) => theme.font.sans};
`;

/**
 * `$edge` outranks `$in` deliberately: a one-day range is both, and the endpoint
 * is the fact worth seeing.
 */
const Day = styled.button<{ $in?: boolean; $edge?: boolean; $start?: number }>`
  height: 26px;
  ${({ $start }) => ($start === undefined ? "" : `grid-column-start: ${$start};`)}
  border: 0;
  border-radius: ${({ theme }) => theme.radius.chip};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11px;
  cursor: pointer;
  background: ${({ theme, $in, $edge }) =>
    $edge ? theme.color.accent : $in ? theme.color.accentWash : "transparent"};
  color: ${({ theme, $edge }) => ($edge ? theme.color.accentInk : theme.color.ink)};

  &:hover {
    background: ${({ theme, $edge }) => ($edge ? theme.color.accent : theme.color.panelRaised)};
  }
`;

const Times = styled(Row)`
  gap: ${({ theme }) => theme.space(1)};
  margin-top: ${({ theme }) => theme.space(2)};
  padding-top: ${({ theme }) => theme.space(2)};
  border-top: 1px solid ${({ theme }) => theme.color.rule};
`;

const Clock = styled(Input).attrs({ type: "time" })`
  width: auto;
  flex: 1;
`;

const Presets = styled(Row)`
  gap: ${({ theme }) => theme.space(1)};
  margin-top: ${({ theme }) => theme.space(2)};
`;

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const PRESETS = [
  { label: "Today", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
] as const;

export type DateRangeFieldProps = {
  since: number | undefined;
  until: number | undefined;
  onChange: (next: { since: number | undefined; until: number | undefined }) => void;
};

/**
 * One control for both time bounds, opening a range calendar.
 *
 * It replaced two `datetime-local` inputs, which asked the operator to type two
 * absolute instants to express one span. The bounds are still two independent
 * wire parameters and one of them may be set alone — filters arrive from places
 * other than this control — so the closed label reads a half-range honestly
 * rather than pretending the other end exists.
 *
 * The times stay separate inputs rather than moving into the grid: a calendar
 * cell is a day, and an operator narrowing to one hour of one day is doing two
 * different things that happen to share a popover.
 */
export function DateRangeField({ since, until, onChange }: DateRangeFieldProps) {
  const [open, setOpen] = useState(false);
  // Which month the grid shows. Seeded from the chosen range each time the
  // popover opens, so reopening never strands the operator on the month they
  // happened to browse to last time.
  const [month, setMonth] = useState(() => new Date(since ?? Date.now()));
  // Set by the first click of a pair. A range is committed on *every* click, so
  // this only decides whether the next one starts over or extends — there is no
  // half-applied state for the board to render.
  const [anchor, setAnchor] = useState<string | null>(null);

  const fromDay = since === undefined ? undefined : dayOf(since);
  const toDay = until === undefined ? undefined : dayOf(until);
  const fromTime = since === undefined ? "00:00" : timeOf(since);
  const toTime = until === undefined ? "23:59" : timeOf(until);

  const commit = (from: string, to: string): void =>
    onChange({
      since: instantOf(from, fromTime, "start"),
      until: instantOf(to, toTime, "end"),
    });

  const clickDay = (day: string): void => {
    if (anchor === null) {
      setAnchor(day);
      // One click is a one-day range, which is both a useful answer on its own
      // and the reason no click leaves the filters incoherent.
      commit(day, day);
      return;
    }
    const { from, to } = rangeFor(anchor, day);
    setAnchor(null);
    commit(from, to);
  };

  const shift = (by: number): void =>
    setMonth((at) => new Date(at.getFullYear(), at.getMonth() + by, 1));

  const year = month.getFullYear();
  const index = month.getMonth();
  const { lead, days } = monthDays(year, index);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setMonth(new Date(since ?? Date.now()));
          setAnchor(null);
        }
      }}
    >
      <Trigger aria-label="Time range">
        <CalendarDays />
        {formatRange(since, until)}
      </Trigger>
      <Popover.Portal>
        <Sheet align="start" sideOffset={4}>
          <Head>
            <IconButton
              type="button"
              $variant="ghost"
              $size="sm"
              aria-label="Previous month"
              onClick={() => shift(-1)}
            >
              <ChevronLeft />
            </IconButton>
            <Legend>{`${MONTH_NAMES[index] ?? ""} ${year}`}</Legend>
            <IconButton
              type="button"
              $variant="ghost"
              $size="sm"
              aria-label="Next month"
              onClick={() => shift(1)}
            >
              <ChevronRight />
            </IconButton>
          </Head>

          <Weeks>
            {WEEKDAYS.map((name) => (
              <Weekday key={name}>{name}</Weekday>
            ))}
            {days.map((date, at) => {
              const day = dayKey(year, index, date);
              return (
                <Day
                  key={day}
                  type="button"
                  // Only the first day is placed; the rest flow after it.
                  {...(at === 0 ? { $start: lead + 1 } : {})}
                  $in={withinRange(day, fromDay, toDay)}
                  $edge={day === fromDay || day === toDay}
                  onClick={() => clickDay(day)}
                >
                  {date}
                </Day>
              );
            })}
          </Weeks>

          <Times>
            <Clock
              aria-label="From time"
              value={fromTime}
              onChange={(event) =>
                onChange({
                  since: instantOf(fromDay ?? dayOf(Date.now()), event.target.value, "start"),
                  until,
                })
              }
            />
            <Clock
              aria-label="To time"
              value={toTime}
              onChange={(event) =>
                onChange({
                  since,
                  until: instantOf(toDay ?? dayOf(Date.now()), event.target.value, "end"),
                })
              }
            />
          </Times>

          <Presets>
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                $size="sm"
                onClick={() => {
                  setAnchor(null);
                  onChange(presetRange(preset.days, Date.now()));
                  setOpen(false);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </Presets>
        </Sheet>
      </Popover.Portal>
    </Popover.Root>
  );
}
