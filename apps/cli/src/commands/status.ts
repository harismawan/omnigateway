import { type BurnEstimate, createAdminAuth, credentialStatus } from "@omni/control";
import { describeError } from "@omni/ir";
import type { QuotaWindow } from "@omni/store";
import { type Command, provider, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, formatAge, note, paint, table } from "../output.ts";
import { status as serviceStatus } from "../service.ts";
import {
  type BurnIndex,
  burnIndex,
  burnNote,
  burnOf,
  byWindowLength,
  verdictOf,
  WINDOW_LABEL,
} from "./quota.ts";

/**
 * Every window the provider reported, in duration order.
 *
 * All of them, not just the tightest: a five-hour window at 90% and a weekly
 * one at 20% mean "pause for an hour", while the reverse means the account is
 * done for the week. One number cannot say which of those the operator is
 * looking at.
 */
function reportedWindows(windows: readonly QuotaWindow[]): QuotaWindow[] {
  return windows.filter((window) => window.limit !== null && window.limit > 0).sort(byWindowLength);
}

/**
 * One cell covering every window, e.g. `5h 62% ~2h10m · 7d 18% ok`.
 *
 * Each window is coloured on its own fraction, while the age note is printed
 * once from the oldest reading in the row: two windows arrive from the same
 * probe, so one timestamp describes both.
 *
 * The estimate is dim because the fraction beside it already carries the
 * colour, and a second tone here would compete with the state it qualifies.
 */
function quotaCell(
  ctx: Parameters<typeof paint>[0],
  windows: readonly QuotaWindow[],
  now: number,
  burn: BurnIndex,
): string {
  const reported = reportedWindows(windows);
  if (reported.length === 0) return paint(ctx, "dim", "unknown");

  const parts = reported.map((window) => {
    const used = Math.round((window.used / (window.limit as number)) * 100);
    const cell = state(ctx, used < 90, `${WINDOW_LABEL[window.windowType]} ${used}%`);
    const estimate = burnNote(verdictOf(window, burnOf(burn, window), now));
    return estimate.length === 0 ? cell : `${cell} ${paint(ctx, "dim", estimate)}`;
  });

  const observedAt = Math.min(...reported.map((window) => window.observedAt));
  return `${parts.join(" · ")} ${paint(ctx, "dim", `(${formatAge(observedAt, now)} ago)`)}`;
}

export const status: Command = {
  usage: "status",
  summary: "Show the gateway process, its accounts, and their quota",
  options: { system: { type: "boolean" } },
  async run(_args, { ctx, writer, service }) {
    const process = await serviceStatus(service());

    // A stopped gateway is still worth reporting on: the store is readable
    // either way, and "is it running" is usually the reason for asking.
    let store: Awaited<ReturnType<typeof ctx.store>> | null = null;
    let storeError: string | null = null;
    try {
      store = await ctx.store();
    } catch (error) {
      storeError = describeError(error, "could not open the database");
    }

    const persistent =
      store === null
        ? { adminConfigured: false, credentials: [] }
        : await credentialStatus(store, { now: ctx.now });
    const { adminConfigured: configured, credentials } = persistent;
    // A stopped gateway still has readings to render; an unreadable store has
    // no windows to estimate from, so the map stays empty rather than absent.
    const burn: BurnIndex =
      store === null
        ? new Map<string, BurnEstimate>()
        : await burnIndex(
            store,
            ctx.now,
            credentials.flatMap((credential) => credential.quota),
          );

    const data = {
      process,
      ...persistent,
      storeError,
    };

    emit(ctx, writer, data, () => {
      const header = fields([
        [
          "gateway",
          state(ctx, process.running, process.running ? "running" : "stopped") +
            paint(ctx, "dim", ` (${process.supervisor})`),
        ],
        ["root", ctx.root.root],
        ["admin password", configured ? "set" : state(ctx, false, "not set")],
      ]);

      if (storeError !== null) {
        return `${header}\n\n${state(ctx, false, storeError)}`;
      }
      if (credentials.length === 0) {
        return `${header}\n\nno credentials; add one with: omni connect <provider>`;
      }

      const rows = credentials.map((credential) => [
        credential.label,
        provider(ctx, credential.provider),
        state(ctx, credential.enabled, credential.enabled ? "enabled" : "disabled"),
        quotaCell(ctx, credential.quota, ctx.now(), burn),
      ]);

      return `${header}\n\n${table(
        [{ header: "ACCOUNT" }, { header: "PROVIDER" }, { header: "STATE" }, { header: "QUOTA" }],
        rows,
      )}`;
    });
  },
};

export const adminSetPassword: Command = {
  usage: "admin set-password",
  summary: "Set or replace the console password",
  async run(_args, { ctx, writer, prompt }) {
    const store = await ctx.store();
    const admin = createAdminAuth(store, { now: ctx.now, sessionTtlMs: 0 });

    const password = await prompt.secret("New admin password: ");
    if (prompt.isTty) {
      const again = await prompt.secret("Repeat it: ");
      if (again !== password) throw new CliError("the two passwords do not match");
    }

    try {
      await admin.setPassword(password);
    } catch (error) {
      throw new CliError(describeError(error, "could not set the password"));
    }

    // Sessions live in the gateway's memory, not here, so an operator who
    // changed the password because it leaked needs to restart to evict them.
    note(ctx, writer, "restart the gateway to end sessions signed in with the old password");
    emit(ctx, writer, { ok: true }, () => "admin password set");
  },
};
