import {
  type BurnEstimate,
  burnEstimates,
  createRefresher,
  credentialStatus,
  getSettings,
  listCredentials,
  OAUTH_PROVIDERS,
  type QuotaRefreshOutcome,
  quotaHistory,
  quotaOps,
} from "@omni/control";
import { memoryCoord } from "@omni/coord";
import { nodeHttpClient } from "@omni/providers";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { type QuotaWindow, quotaVerdict, type Store, type WindowType } from "@omni/store";
import { UsageError } from "../args.ts";
import { type Command, provider } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, formatSpan, note, paint, table } from "../output.ts";
import { connectRegistryFor } from "./plugins.ts";

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
 * What can honestly be said about one window, plus the countdown to print.
 *
 * The judgement itself is `quotaVerdict` in `@omni/store/types`, which the
 * console phrases from as well. It lives in that leaf because the CLI reaches
 * it through `@omni/control` and the console through `/api/*`, and neither can
 * reach the other — written twice, the two surfaces drifted, and the console
 * ended up printing "lasts the window" for an account with no ceiling. All this
 * adds is the span, which is measured against each surface's own `now`.
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
  const kind = quotaVerdict(window, estimate);
  if (kind !== "empty") return { kind };
  // `quotaVerdict` returns `empty` only with an instant to count down from.
  return { kind, inMs: (estimate?.exhaustsAt ?? now) - now };
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

/** How each outcome reads on a terminal, and whether it means the refresh ran. */
const OUTCOME_NOTE: Record<QuotaRefreshOutcome["kind"], string> = {
  refreshed: "refreshed",
  coalesced: "refreshed by a concurrent probe",
  noData: "provider reported nothing",
  cooldown: "cooling down after a rate limit",
  unsupported: "no usage endpoint",
  disabled: "disabled",
  failed: "failed",
};

/**
 * Outcomes that mean the operator did not get what they asked for.
 *
 * `cooldown` counts: the provider was not called, so the reading on screen is
 * as old as it was. `noData`, `unsupported` and `disabled` do not — the refresh
 * ran, or could never have run, and the account is reported either way.
 */
export function unmet(outcome: QuotaRefreshOutcome): boolean {
  return outcome.kind === "failed" || outcome.kind === "cooldown";
}

export const quotaRefresh: Command = {
  usage: "quota refresh <id> | --all",
  summary: "Read provider quota now, for one account or for every account",
  options: { all: { type: "boolean" } },
  async run(args, { ctx, writer }) {
    const all = args.values.all === true;
    const id = args.positionals[0];
    // Never "an id, or everything when it is missing": bulk provider traffic is
    // something an operator asks for, not something a forgotten argument does.
    if (all === (id !== undefined)) {
      throw new UsageError("give an account id or --all, not both");
    }

    const store = await ctx.store();
    const credentials = await listCredentials(store);
    // Not checked for existence here: `refresh` refuses an id nothing matches,
    // and a second copy of that rule is one that can disagree with it. This
    // narrows which provider modules have to be loaded, nothing more.
    const wanted = id === undefined ? credentials : credentials.filter((c) => c.id === id);

    // The same short-circuit `credentials refresh` makes, for the same reason:
    // loading every provider-declaring plugin runs third-party top-level code,
    // and it is only needed when one of the accounts in scope came from one.
    const providers = wanted.every((c) => Object.hasOwn(PROVIDER_DESCRIPTORS, c.provider))
      ? OAUTH_PROVIDERS
      : (await connectRegistryFor(ctx.root.root)).providers;
    const http = nodeHttpClient();
    const ops = quotaOps({
      store,
      // One process, one pass: nothing else is probing these accounts, so the
      // in-memory coordinator is the whole truth about who holds what.
      coord: memoryCoord({ now: ctx.now }),
      providers,
      http,
      refresh: createRefresher({ store, providers, http, now: ctx.now }),
      now: ctx.now,
    });

    note(ctx, writer, id === undefined ? "refreshing every account…" : `refreshing ${id}…`);
    const result = await ops.refresh(
      id === undefined ? { kind: "all" } : { kind: "one", credentialId: id },
    );

    const labels = new Map(credentials.map((c) => [c.id, c.label]));
    emit(ctx, writer, result, () => {
      const rows = result.outcomes.map((outcome) => [
        `${labels.get(outcome.credentialId) ?? outcome.credentialId}`,
        OUTCOME_NOTE[outcome.kind],
        outcome.kind === "refreshed" || outcome.kind === "coalesced"
          ? `${outcome.windows} window${outcome.windows === 1 ? "" : "s"}`
          : outcome.kind === "failed"
            ? outcome.code
            : dash,
      ]);
      const refreshed = result.outcomes.filter(
        (o) => o.kind === "refreshed" || o.kind === "coalesced",
      ).length;
      const failed = result.outcomes.filter((o) => o.kind === "failed").length;
      const skipped = result.outcomes.length - refreshed - failed;
      return [
        table(
          [{ header: "ACCOUNT" }, { header: "OUTCOME" }, { header: "DETAIL", align: "right" }],
          rows,
        ),
        "",
        `refreshed ${refreshed}; failed ${failed}; skipped ${skipped}`,
      ].join("\n");
    });

    // After the report, never instead of it: the operator wants to see which
    // account did what even when the command is about to exit nonzero.
    const bad = result.outcomes.filter(unmet);
    if (bad.length > 0) {
      throw new CliError(
        bad.length === result.outcomes.length
          ? "quota refresh did not run"
          : `quota refresh did not run for ${bad.length} of ${result.outcomes.length} accounts`,
      );
    }
  },
};
