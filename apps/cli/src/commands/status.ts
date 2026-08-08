import { createAdminAuth } from "@omni/control";
import { quotaHeadroom } from "@omni/router";
import type { QuotaWindow } from "@omni/store";
import { type Command, provider, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, formatAge, note, paint, table } from "../output.ts";
import { status as serviceStatus } from "../service.ts";

/** The quota window an operator is most likely asking about: the tightest one. */
function tightest(windows: readonly QuotaWindow[]): QuotaWindow | null {
  let worst: QuotaWindow | null = null;
  for (const window of windows) {
    if (window.limit === null || window.limit <= 0) continue;
    if (worst === null || window.used / window.limit > worst.used / (worst.limit ?? 1)) {
      worst = window;
    }
  }
  return worst;
}

function quotaCell(
  ctx: Parameters<typeof paint>[0],
  windows: readonly QuotaWindow[],
  headroom: number,
  now: number,
): string {
  const window = tightest(windows);
  if (window === null || window.limit === null) return paint(ctx, "dim", "unknown");

  const used = Math.round((window.used / window.limit) * 100);
  const age = formatAge(window.observedAt, now);
  // Headroom is pace, not raw remainder: 5% left reads as fine minutes before a
  // reset and as urgent with six days to run.
  return `${state(ctx, headroom >= 0.5, `${used}% used`)} ${paint(ctx, "dim", `(${window.windowType}, ${age} ago)`)}`;
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
      storeError = error instanceof Error ? error.message : "could not open the database";
    }

    const credentials = store === null ? [] : await store.credentials.list();
    const quotaRows = store === null ? [] : await store.credentials.listQuota();
    const settings = store === null ? null : await store.config.getSettings();
    const configured =
      store === null
        ? false
        : await createAdminAuth(store, {
            now: ctx.now,
            sessionTtlMs: 0,
          }).isConfigured();

    const byCredential = new Map<string, QuotaWindow[]>();
    for (const row of quotaRows) {
      const list = byCredential.get(row.credentialId);
      if (list === undefined) byCredential.set(row.credentialId, [row]);
      else list.push(row);
    }

    const data = {
      process,
      adminConfigured: configured,
      credentials: credentials.map((credential) => ({
        id: credential.id,
        provider: credential.provider,
        label: credential.label,
        enabled: credential.enabled,
        quota: byCredential.get(credential.id) ?? [],
      })),
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

      const rows = credentials.map((credential) => {
        const windows = byCredential.get(credential.id) ?? [];
        const headroom = quotaHeadroom(
          credential,
          windows,
          ctx.now(),
          settings?.quotaPollIntervalMs ?? 0,
        );
        return [
          credential.label,
          provider(ctx, credential.provider),
          state(ctx, credential.enabled, credential.enabled ? "enabled" : "disabled"),
          quotaCell(ctx, windows, headroom, ctx.now()),
        ];
      });

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
      throw new CliError(error instanceof Error ? error.message : "could not set the password");
    }

    // Sessions live in the gateway's memory, not here, so an operator who
    // changed the password because it leaked needs to restart to evict them.
    note(ctx, writer, "restart the gateway to end sessions signed in with the old password");
    emit(ctx, writer, { ok: true }, () => "admin password set");
  },
};
