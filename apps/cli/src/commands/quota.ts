import {
  type BurnEstimate,
  burnEstimates,
  credentialStatus,
  getSettings,
  quotaHistory,
} from "@omni/control";
import type { QuotaWindow, Store, WindowType } from "@omni/store";
import { type Command, provider } from "../command.ts";
import { emit, formatSpan, paint, table } from "../output.ts";

/** Shortest window first, so a row reads soonest-to-latest. */
const WINDOW_ORDER: Record<WindowType, number> = {
  fiveHour: 0,
  daily: 1,
  weekly: 2,
};

export const WINDOW_LABEL: Record<WindowType, string> = {
  fiveHour: "5h",
  daily: "24h",
  weekly: "7d",
};

export function byWindowLength(a: QuotaWindow, b: QuotaWindow): number {
  return WINDOW_ORDER[a.windowType] - WINDOW_ORDER[b.windowType];
}

/** Every estimate, keyed the way a row looks its own up. */
export type BurnIndex = ReadonlyMap<string, BurnEstimate>;

const burnKey = (credentialId: string, windowType: WindowType): string =>
  `${credentialId}|${windowType}`;

export const burnOf = (index: BurnIndex, window: QuotaWindow): BurnEstimate | undefined =>
  index.get(burnKey(window.credentialId, window.windowType));

/**
 * The estimate for a set of snapshot windows.
 *
 * Derivation lives in `@omni/control` and is shared with the console, so the
 * CLI never carries a second copy of the arithmetic — only the phrasing.
 */
export async function burnIndex(
  store: Store,
  now: () => number,
  windows: readonly QuotaWindow[],
): Promise<BurnIndex> {
  const settings = await getSettings(store);
  const estimates = burnEstimates(windows, {
    now: now(),
    pollIntervalMs: settings.quotaPollIntervalMs,
  });
  return new Map(estimates.map((e) => [burnKey(e.credentialId, e.windowType), e]));
}

/**
 * What can honestly be said about one window, before it is phrased.
 *
 * Suppression is checked first and on the `stale` flag rather than on the
 * numbers: a suppressed estimate nulls every field it carries, and a reader
 * that inferred its verdict from `survives` would turn a reading nobody
 * believes into "this will last". The unavailable cases stay apart because
 * "too old to use", "never read at all", and "the provider never said" are
 * three different things to go and fix.
 */
export type Verdict =
  | { kind: "stale" }
  | { kind: "unknown" }
  | { kind: "ok" }
  | { kind: "empty"; inMs: number };

export function verdictOf(
  window: QuotaWindow,
  estimate: BurnEstimate | undefined,
  now: number,
): Verdict {
  if (estimate === undefined) return { kind: "unknown" };
  // A row written before snapshots existed carries no reading to age, so it is
  // unknown rather than stale even though it is suppressed the same way.
  if (window.observedAt > 0 && estimate.stale) return { kind: "stale" };
  // No inferred window start means no rate, and no ceiling means nothing to run
  // out of. Neither is "fine", so neither may borrow the `ok` phrasing.
  if (estimate.ratePerHour === null || window.limit === null) return { kind: "unknown" };
  if (estimate.survives === false && estimate.exhaustsAt !== null) {
    return { kind: "empty", inMs: estimate.exhaustsAt - now };
  }
  return estimate.survives === true ? { kind: "ok" } : { kind: "unknown" };
}

/** The estimate as `omni status` shows it: a suffix, or nothing at all. */
export function burnNote(verdict: Verdict): string {
  if (verdict.kind === "empty") return `~${formatSpan(verdict.inMs)}`;
  return verdict.kind === "ok" ? "ok" : "";
}

const dash = "—";

/**
 * Burn as a share of the window's own limit per hour.
 *
 * Providers do not agree on units — Anthropic and OpenAI are normalized to a
 * hundred, Kimi reports raw counters — so a percentage is the only figure that
 * means the same thing on two rows of one table. A window with no ceiling has
 * no share to take, and keeps the provider's own units.
 */
function rateCell(window: QuotaWindow, estimate: BurnEstimate | undefined): string {
  const rate = estimate?.ratePerHour ?? null;
  if (rate === null) return dash;
  return window.limit === null || window.limit <= 0
    ? `${rate.toFixed(1)}/h`
    : `${((rate / window.limit) * 100).toFixed(1)}%/h`;
}

export const quota: Command = {
  usage: "quota",
  summary: "Show provider quota use, burn rate, and when each window runs out",
  async run(_args, { ctx, writer }) {
    const store = await ctx.store();
    const now = ctx.now();
    const { credentials } = await credentialStatus(store, { now: ctx.now });
    const windows = credentials.flatMap((credential) => credential.quota);
    const burn = await burnIndex(store, ctx.now, windows);

    // Samples and the gateway rate are the scripting half of this command: the
    // samples run to a row per movement per window and the rate costs a
    // request-log aggregate each, and the table shows neither. Read only when
    // something is going to parse them.
    const history = ctx.json
      ? await quotaHistory({ store, now: ctx.now }, {})
      : { samples: [], gatewayRates: [] };

    const data = {
      credentials: credentials.map((credential) => ({
        id: credential.id,
        provider: credential.provider,
        label: credential.label,
        windows: credential.quota,
      })),
      burn: [...burn.values()],
      samples: history.samples,
      gatewayRates: history.gatewayRates,
    };

    emit(ctx, writer, data, () => {
      if (credentials.length === 0) return "no credentials; add one with: omni connect <provider>";

      const rows = credentials.flatMap((credential) => {
        const account = `${provider(ctx, credential.provider)}:${credential.label}`;
        const reported = [...credential.quota].sort(byWindowLength);

        // A provider with no usage surface — grok has none — reports nothing,
        // and nothing is not zero. An empty row here would read as an untouched
        // account with its whole quota ahead of it.
        if (reported.length === 0) {
          const unknown = paint(ctx, "dim", "unknown");
          return [[account, dash, unknown, dash, unknown, dash]];
        }

        return reported.map((window) => {
          const verdict = verdictOf(window, burnOf(burn, window), now);
          const estimate =
            verdict.kind === "empty"
              ? `empty ~${formatSpan(verdict.inMs)}`
              : verdict.kind === "ok"
                ? "ok"
                : paint(ctx, "dim", verdict.kind);
          return [
            account,
            WINDOW_LABEL[window.windowType],
            `${window.used}/${window.limit ?? dash}`,
            rateCell(window, burnOf(burn, window)),
            estimate,
            window.resetsAt === null ? dash : formatSpan(window.resetsAt - now),
          ];
        });
      });

      return table(
        [
          { header: "ACCOUNT" },
          { header: "WINDOW" },
          { header: "USED", align: "right" },
          { header: "RATE", align: "right" },
          { header: "ESTIMATE" },
          { header: "RESETS", align: "right" },
        ],
        rows,
      );
    });
  },
};
