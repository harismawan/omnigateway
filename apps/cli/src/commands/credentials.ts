import {
  createApiKeyCredential,
  createRefresher,
  credentialHealth,
  getCredential,
  listCredentials,
  listModels,
  OAUTH_PROVIDERS,
  PROVIDER_IDS,
  type ProviderExists,
  patchCredential,
  refreshCredential,
  removeCredential,
} from "@omni/control";
import { nodeHttpClient } from "@omni/providers";
import { boolFlag, numberFlag, requirePositional, stringFlag, UsageError } from "../args.ts";
import { type Command, provider, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, formatTime, note, paint, table } from "../output.ts";
import { pluginProviders } from "./plugins.ts";

/** One word for what the router would do with this credential right now. */
function condition(credential: {
  enabled: boolean;
  disabledReason: string | null;
  expiresAt: number | null;
  hasRefreshToken: boolean;
}): { ok: boolean; text: string } {
  if (!credential.enabled) return { ok: false, text: credential.disabledReason ?? "disabled" };
  if (credential.expiresAt !== null && credential.expiresAt <= Date.now()) {
    return credential.hasRefreshToken
      ? { ok: true, text: "expired (refreshable)" }
      : { ok: false, text: "expired" };
  }
  return { ok: true, text: "enabled" };
}

export const credentialsList: Command = {
  usage: "credentials list",
  summary: "List provider accounts and whether the router may use them",
  async run(_args, { ctx, writer }) {
    const credentials = await listCredentials(await ctx.store());

    emit(ctx, writer, { credentials }, () => {
      if (credentials.length === 0) return "no credentials; add one with: omni connect <provider>";
      return table(
        [
          { header: "ID" },
          { header: "PROVIDER" },
          { header: "LABEL" },
          { header: "AUTH" },
          { header: "TIER", align: "right" },
          { header: "WEIGHT", align: "right" },
          { header: "STATE" },
          { header: "EXPIRES" },
        ],
        credentials.map((c) => {
          const status = condition(c);
          return [
            c.id,
            provider(ctx, c.provider),
            c.label,
            c.authType,
            String(c.tier),
            String(c.weight),
            state(ctx, status.ok, status.text),
            formatTime(c.expiresAt),
          ];
        }),
      );
    });
  },
};

async function findCredential(
  ctx: { store: () => Promise<import("@omni/store").Store> },
  id: string,
) {
  return getCredential(await ctx.store(), id);
}

export const credentialsShow: Command = {
  usage: "credentials show <id>",
  summary: "Show one account in full, without its secrets",
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "credential id");
    const credential = await findCredential(ctx, id);
    const status = condition(credential);

    const data = {
      id: credential.id,
      provider: credential.provider,
      label: credential.label,
      authType: credential.authType,
      enabled: credential.enabled,
      tier: credential.tier,
      weight: credential.weight,
      expiresAt: credential.expiresAt,
      accountEmail: credential.accountEmail,
      providerData: credential.providerData,
      disabledReason: credential.disabledReason,
      disabledAt: credential.disabledAt,
      hasRefreshToken: credential.hasRefreshToken,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    };

    emit(ctx, writer, data, () =>
      fields([
        ["id", credential.id],
        ["provider", provider(ctx, credential.provider)],
        ["label", credential.label],
        ["auth", credential.authType],
        ["state", state(ctx, status.ok, status.text)],
        ["tier", String(credential.tier)],
        ["weight", String(credential.weight)],
        ["account", credential.accountEmail ?? "—"],
        ["expires", formatTime(credential.expiresAt)],
        ["refresh token", credential.hasRefreshToken ? "yes" : "no"],
        ["created", formatTime(credential.createdAt)],
        ["updated", formatTime(credential.updatedAt)],
      ]),
    );
  },
};

function toggle(enabled: boolean): Command {
  return {
    usage: `credentials ${enabled ? "enable" : "disable"} <id>`,
    summary: `${enabled ? "Let" : "Stop letting"} the router use an account`,
    async run(args, { ctx, writer }) {
      const id = requirePositional(args, 0, "credential id");
      await patchCredential({ store: await ctx.store(), now: ctx.now }, id, { enabled });
      emit(ctx, writer, { id, enabled }, () => `${id} ${enabled ? "enabled" : "disabled"}`);
    },
  };
}

export const credentialsEnable = toggle(true);
export const credentialsDisable = toggle(false);

export const credentialsSet: Command = {
  usage: "credentials set <id> [--label L] [--tier N] [--weight W]",
  summary: "Change an account's label, tier, or weight",
  options: {
    label: { type: "string" },
    tier: { type: "string" },
    weight: { type: "string" },
  },
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "credential id");
    const label = stringFlag(args.values, "label");
    const tier = numberFlag(args.values, "tier");
    const weight = numberFlag(args.values, "weight");

    if (label === undefined && tier === undefined && weight === undefined) {
      throw new UsageError("nothing to change: pass --label, --tier, or --weight");
    }

    const patch = {
      ...(label === undefined ? {} : { label }),
      ...(tier === undefined ? {} : { tier }),
      ...(weight === undefined ? {} : { weight }),
    };
    await patchCredential({ store: await ctx.store(), now: ctx.now }, id, patch);
    emit(ctx, writer, { id, ...patch }, () => `${id} updated`);
  },
};

export const credentialsRemove: Command = {
  usage: "credentials rm <id>",
  summary: "Delete an account and its stored tokens",
  async run(args, { ctx, writer, prompt }) {
    const id = requirePositional(args, 0, "credential id");
    const credential = await findCredential(ctx, id);

    // Named before the prompt, not after the deletion. A pinned target has no
    // fallback, so removing the account it names stops that target serving
    // outright — a different fact from an unpinned target losing one of
    // several, and the operator can only weigh it beforehand. The console says
    // the same thing at the same moment; a headless install would otherwise
    // learn it from a client.
    const pinned = (await listModels(await ctx.store()))
      .filter((model) => model.targets.some((target) => target.credentialId === id))
      .map((model) => model.id);

    const confirmed = await prompt.confirm(
      `delete ${credential.provider} credential "${credential.label}" (${id})?` +
        (pinned.length === 0
          ? ""
          : ` ${pinned.length === 1 ? "model" : "models"} ${pinned.join(", ")} ` +
            `${pinned.length === 1 ? "pins a target" : "pin targets"} to it, and ` +
            `${pinned.length === 1 ? "that target" : "those targets"} will fail rather than ` +
            "fall back to another account."),
    );
    if (!confirmed) throw new CliError("cancelled");

    await removeCredential(await ctx.store(), id);
    emit(ctx, writer, { id, removed: true }, () => `${id} removed`);
  },
};

export const credentialsRefresh: Command = {
  usage: "credentials refresh <id>",
  summary: "Force an OAuth token refresh now",
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "credential id");
    const store = await ctx.store();
    const credential = await findCredential(ctx, id);
    const refresh = createRefresher({
      store,
      providers: OAUTH_PROVIDERS,
      http: nodeHttpClient(),
      now: ctx.now,
    });

    note(ctx, writer, `refreshing ${credential.provider} credential ${id}…`);
    const updated = await refreshCredential({ store, refresh }, id);

    emit(
      ctx,
      writer,
      { id, expiresAt: updated.expiresAt },
      () => `${id} refreshed; expires ${formatTime(updated.expiresAt)}`,
    );
  },
};

export const credentialsAddKey: Command = {
  usage:
    "credentials add-key <provider> [--label L] [--endpoint-id ID --endpoint-label L --origin URL --protocol P]",
  summary: "Store a provider API key, read from a prompt or stdin",
  options: {
    label: { type: "string" },
    "endpoint-id": { type: "string" },
    "endpoint-label": { type: "string" },
    origin: { type: "string" },
    protocol: { type: "string" },
  },
  async run(args, { ctx, writer, prompt }) {
    const providerId = requirePositional(args, 0, "provider");
    // Every provider, unlike `connect`: a key is the one way in that `custom`
    // has — and the only way in a plugin-supplied provider has at all, since a
    // plugin declares no OAuth flow.
    //
    // The **real registry**, not a manifest guess. This asked
    // `providerLoadable`, which reads a manifest's `provider` capability — and
    // the comment beside it said, correctly, that the fourth way this goes
    // wrong (a plugin that loads cleanly, declares the capability, and never
    // supplies a provider) "cannot be closed by reading a manifest at all".
    // `readPluginProviders` closes it exactly, by reading the declaration, and
    // it was written in the same commit and not threaded here. Confirmed by
    // review: `omni credentials add-key ghost-ai` stored a live encrypted
    // secret under a provider id that could never exist.
    //
    // So `doctor`'s `stranded credentials` line is now the safety net for a
    // plugin that stops supplying a provider *after* the account was minted —
    // not for one that never did.
    //
    // The same predicate is handed to `createApiKeyCredential` below rather than
    // being checked only here. Control asks the existence question again on its
    // own — it is the one place that can refuse an unreachable credential before
    // it is stored — and with the built-in registry as its only answer it
    // refused everything this guard had just admitted. A guard whose decision
    // the next call overturns is not a guard, and for one commit this one was
    // not: the widened check was the only mutant of fourteen that survived.
    //
    // Annotated `ProviderExists` rather than `(id: string) => boolean`. The two
    // are the same type — `ProviderId` is a validated string — so this buys
    // nothing from the compiler and is exactly why it is worth writing: the
    // exported type had no consumer at all, which made it documentation nothing
    // pointed at.
    const { descriptors, failures } = await pluginProviders(ctx.root.root);
    // Named before the refusal, because a plugin that failed to read is the
    // likeliest reason the provider below is about to be reported as unknown.
    for (const failure of failures) {
      note(ctx, writer, paint(ctx, "yellow", `plugin ${failure.id}: ${failure.reason}`));
    }
    const providerExists: ProviderExists = (id) => Object.hasOwn(descriptors, id);
    if (!providerExists(providerId)) {
      // The capability and the loading are both named, because those are the
      // two ways an operator who *has* installed the right plugin still lands
      // here, and "or an installed plugin that supplies one" sent them to look
      // at the one thing that was already true.
      throw new UsageError(
        `provider must be one of ${PROVIDER_IDS.join(", ")}, or a plugin that loads and ` +
          `supplies one; omni plugin list shows which`,
      );
    }

    const protocolFlag = stringFlag(args.values, "protocol");
    const protocol =
      protocolFlag === "chat-completions"
        ? "chat_completions"
        : protocolFlag === "responses"
          ? "responses"
          : protocolFlag;
    const key = await prompt.secret(`${providerId} API key: `);
    if (key.length === 0) throw new CliError("no API key given");

    const store = await ctx.store();
    const endpointId = stringFlag(args.values, "endpoint-id");
    const existingEndpoint =
      providerId === "custom" && endpointId !== undefined
        ? (await listCredentials(store)).find(
            (credential) =>
              credential.provider === "custom" &&
              credential.providerData.endpointId === endpointId.trim(),
          )
        : undefined;
    // Reusing an endpoint resolves its metadata from an existing projection.
    // The origin rejoins any stored base path so the resolved value is exactly
    // what the operator first entered, not the origin alone.
    const existingOrigin =
      existingEndpoint === undefined
        ? undefined
        : `${String(existingEndpoint.providerData.origin)}${
            typeof existingEndpoint.providerData.basePath === "string"
              ? existingEndpoint.providerData.basePath
              : ""
          }`;
    const created = await createApiKeyCredential(
      store,
      {
        provider: providerId,
        apiKey: key,
        label: stringFlag(args.values, "label"),
        endpointId,
        endpointLabel:
          stringFlag(args.values, "endpoint-label") ?? existingEndpoint?.providerData.endpointLabel,
        origin: stringFlag(args.values, "origin") ?? existingOrigin,
        protocol: protocol ?? existingEndpoint?.providerData.protocol,
      },
      undefined,
      providerExists,
    );

    emit(
      ctx,
      writer,
      { id: created.id, provider: created.provider },
      () => `stored ${created.provider} api key as ${created.id}`,
    );
  },
};

/** Health and quota as the router currently sees them. */
export const credentialsHealth: Command = {
  usage: "credentials health",
  summary: "Show breaker state and latency per credential and model",
  options: { all: { type: "boolean" } },
  async run(args, { ctx, writer }) {
    const store = await ctx.store();
    const [{ health: rows }, credentials] = await Promise.all([
      credentialHealth({ store, now: ctx.now }),
      listCredentials(store),
    ]);
    const labels = new Map(credentials.map((c) => [c.id, c.label]));
    const shown = boolFlag(args.values, "all")
      ? rows
      : rows.filter((r) => r.breakerState !== "closed" || r.consecutiveFailures > 0);

    emit(ctx, writer, { health: rows }, () => {
      if (shown.length === 0) return "every credential is healthy";
      return table(
        [
          { header: "CREDENTIAL" },
          { header: "MODEL" },
          { header: "BREAKER" },
          { header: "FAILS", align: "right" },
          { header: "TTFT", align: "right" },
          { header: "LAST USED" },
        ],
        shown.map((row) => [
          labels.get(row.credentialId) ?? row.credentialId,
          row.model,
          state(ctx, row.breakerState === "closed", row.breakerState),
          String(row.consecutiveFailures),
          row.ewmaTtftMs === null ? "—" : `${Math.round(row.ewmaTtftMs)}ms`,
          paint(ctx, "dim", formatTime(row.lastUsedAt)),
        ]),
      );
    });
  },
};
