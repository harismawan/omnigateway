import { dryRun, getModel, listModels, putModel, removeModel } from "@omni/control";
import type { ProviderId } from "@omni/ir";
import {
  catalogLimits,
  catalogPricing,
  PROVIDER_MODEL_CATALOG,
  type ProviderModelChoice,
} from "@omni/providers/catalog";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import type { Target, VirtualModel } from "@omni/store";
import { boolFlag, listFlag, requirePositional, stringFlag, UsageError } from "../args.ts";
import { type Command, provider, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, note, paint, table } from "../output.ts";
import { pluginProviders } from "./plugins.ts";

export const modelsList: Command = {
  usage: "models list",
  summary: "List virtual models and their targets",
  async run(_args, { ctx, writer }) {
    const models = await listModels(await ctx.store());

    emit(ctx, writer, { models }, () => {
      if (models.length === 0) return "no virtual models configured";
      return table(
        [
          { header: "ID" },
          { header: "STRATEGY" },
          { header: "ALIAS" },
          { header: "TARGETS", align: "right" },
          { header: "PROVIDERS" },
        ],
        models.map((model) => [
          model.id,
          model.strategy,
          model.isAlias ? "yes" : "no",
          String(model.targets.length),
          [...new Set(model.targets.map((t) => t.provider))]
            .map((id) => provider(ctx, id))
            .join(" "),
        ]),
      );
    });
  },
};

export const modelsShow: Command = {
  usage: "models show <id>",
  summary: "Show one virtual model's targets and pricing",
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "model id");
    const model = await getModel(await ctx.store(), id);
    // Only where one exists. A pin routes every request for that target to a
    // single account and fails rather than falling back, which is the first
    // thing to check when an operator asks why one account is serving
    // everything — but a column of dashes on the common unpinned case would
    // push an already wide table wider for nothing.
    const pinned = model.targets.some((target) => target.credentialId !== undefined);

    emit(ctx, writer, { model }, () =>
      [
        fields([
          ["id", model.id],
          ["strategy", model.strategy],
          ["alias", model.isAlias ? "yes" : "no"],
        ]),
        "",
        table(
          [
            { header: "PROVIDER" },
            { header: "MODEL" },
            ...(pinned ? [{ header: "ACCOUNT" }] : []),
            { header: "TIER", align: "right" },
            { header: "WEIGHT", align: "right" },
            { header: "IN $/MTOK", align: "right" },
            { header: "OUT $/MTOK", align: "right" },
            { header: "CACHE R", align: "right" },
            { header: "CACHE W 5M", align: "right" },
            { header: "CACHE W 1H", align: "right" },
            { header: "CONTEXT", align: "right" },
            { header: "MAX OUT", align: "right" },
            { header: "CAPABILITIES" },
          ],
          model.targets.map((target) => [
            provider(ctx, target.provider),
            target.model,
            ...(pinned ? [target.credentialId ?? "any"] : []),
            String(target.tier),
            String(target.weight),
            target.costPerMTok.input.toFixed(2),
            target.costPerMTok.output.toFixed(2),
            price(target.costPerMTok.cacheRead),
            price(target.costPerMTok.cacheWrite5m),
            price(target.costPerMTok.cacheWrite1h),
            tokens(target.contextWindow),
            tokens(target.maxOutputTokens),
            capabilityList(target),
          ]),
        ),
      ].join("\n"),
    );
  },
};

/**
 * A price the target names, or an em dash when it names none.
 *
 * Not `0.00`: an unnamed price is not a free one. The router falls back to a
 * multiple of input, so printing a zero would claim the operator is billed
 * nothing for a token class that in fact costs more than fresh input.
 */
function price(value: number | undefined): string {
  return value === undefined ? "\u2014" : value.toFixed(2);
}

/**
 * A token limit the target names, or an em dash when it names none.
 *
 * Unlike a price, an unnamed limit is not filled in from anywhere at read
 * time — `GET /v1/models` falls back to the catalog itself — so the dash means
 * "whatever the catalog says", not "unlimited".
 */
function tokens(value: number | undefined): string {
  return value === undefined ? "\u2014" : value.toLocaleString("en-US");
}

function capabilityList(target: Target): string {
  const on = Object.entries(target.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  return on.length === 0 ? "—" : on.join(",");
}

/**
 * Builds a target from the provider catalog.
 *
 * The catalog is where a target starts, not where its pricing lives: what is
 * written here is a copy the operator owns, and editing the catalog later
 * changes nothing about a model already saved.
 */
function targetFromCatalog(spec: string): Target {
  const separator = spec.indexOf(":");
  if (separator <= 0) {
    throw new UsageError(`--from-catalog expects <provider>:<model>, got "${spec}"`);
  }
  const providerId = spec.slice(0, separator);
  const model = spec.slice(separator + 1);
  // Resolved once, from the descriptors, and reused below. The membership test
  // this replaced read `PROVIDER_MODEL_CATALOG` while the capabilities came
  // from `PROVIDER_DESCRIPTORS` — two derived tables answering one question, so
  // a provider present in one and not the other would pass the check and then
  // fail to index. They agree today because both are built from the same six
  // literals; asking one of them twice is what keeps that from mattering.
  const descriptor = PROVIDER_DESCRIPTORS[providerId];
  if (descriptor === undefined) {
    throw new UsageError(`unknown provider "${providerId}" in "${spec}"`);
  }

  const pricing = catalogPricing(providerId, model);
  if (pricing === null) {
    throw new UsageError(`no catalog entry for "${spec}"; see omni models catalog`);
  }
  return {
    provider: providerId,
    model,
    tier: 1,
    weight: 1,
    costPerMTok: pricing,
    // Deliberately no token limits: unlike pricing, they are resolved when the
    // model is listed, from the catalog and from how the serving credential
    // authenticates. Copying them here would freeze the API's window onto a
    // target an OAuth credential serves through a narrower backend.
    // Capabilities are a property of the provider, not of the catalog entry;
    // the operator narrows them afterwards if a particular model is narrower.
    capabilities: descriptor.capabilities,
  };
}

/**
 * The catalog flattened into rows, which is how an operator reads it.
 *
 * Carries the prices and limits rather than just the names, so `--json` answers
 * the same question the table does.
 */
function catalogRows(): Array<ProviderModelChoice & { provider: ProviderId }> {
  return Object.entries(PROVIDER_MODEL_CATALOG).flatMap(([id, entry]) =>
    entry.models.map((model) => ({ ...model, provider: id as ProviderId })),
  );
}

export const modelsCatalog: Command = {
  usage: "models catalog [--provider P]",
  summary: "List the built-in model catalog and its list pricing",
  options: { provider: { type: "string" } },
  async run(args, { ctx, writer }) {
    const only = stringFlag(args.values, "provider");
    const entries = catalogRows().filter((entry) => only === undefined || entry.provider === only);

    emit(ctx, writer, { models: entries }, () =>
      table(
        [
          { header: "PROVIDER" },
          { header: "MODEL" },
          { header: "LABEL" },
          { header: "IN $/MTOK", align: "right" },
          { header: "OUT $/MTOK", align: "right" },
          { header: "CACHE R", align: "right" },
          { header: "CACHE W 5M", align: "right" },
          { header: "CACHE W 1H", align: "right" },
          { header: "CONTEXT", align: "right" },
          { header: "CONTEXT OAUTH", align: "right" },
          { header: "MAX OUT", align: "right" },
        ],
        entries.map((entry) => {
          const listed = catalogPricing(entry.provider, entry.id);
          const limits = catalogLimits(entry.provider, entry.id);
          // What the same model holds when an OAuth credential serves it: the
          // OpenAI adapter routes those to Codex, which takes a smaller prompt
          // than the API does. A dash means the two ways in are the same.
          const oauth = catalogLimits(entry.provider, entry.id, "oauth");
          return [
            provider(ctx, entry.provider),
            entry.id,
            entry.label,
            price(listed?.input),
            price(listed?.output),
            price(listed?.cacheRead),
            price(listed?.cacheWrite5m),
            price(listed?.cacheWrite1h),
            tokens(limits?.contextWindow),
            oauth?.contextWindow === limits?.contextWindow ? "—" : tokens(oauth?.contextWindow),
            tokens(limits?.maxOutputTokens),
          ];
        }),
      ),
    );
  },
};

export const modelsPut: Command = {
  usage: "models put <id> (-f model.json | --from-catalog <provider>:<model> ...)",
  summary: "Create or replace a virtual model",
  options: {
    file: { type: "string", short: "f" },
    "from-catalog": { type: "string", multiple: true },
    strategy: { type: "string" },
    alias: { type: "boolean" },
  },
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "model id");
    const file = stringFlag(args.values, "file");
    const catalog = listFlag(args.values, "from-catalog");

    if (file !== undefined && catalog !== undefined) {
      throw new UsageError("pass either -f or --from-catalog, not both");
    }

    let model: unknown;
    if (file !== undefined) {
      const text = await Bun.file(file)
        .text()
        .catch(() => {
          throw new CliError(`could not read ${file}`);
        });
      try {
        model = JSON.parse(text);
      } catch {
        throw new CliError(`${file} is not valid JSON`);
      }
    } else if (catalog !== undefined) {
      const draft: VirtualModel = {
        id,
        strategy: (stringFlag(args.values, "strategy") ?? "score") as VirtualModel["strategy"],
        isAlias: boolFlag(args.values, "alias"),
        targets: catalog.map(targetFromCatalog),
      };
      model = draft;
    } else {
      throw new UsageError("pass -f <file> or --from-catalog <provider>:<model>");
    }

    await putModel(await ctx.store(), id, model);
    emit(ctx, writer, { id, ok: true }, () => `${id} saved`);
  },
};

export const modelsRemove: Command = {
  usage: "models rm <id>",
  summary: "Delete a virtual model",
  async run(args, { ctx, writer, prompt }) {
    const id = requirePositional(args, 0, "model id");
    await getModel(await ctx.store(), id);

    if (!(await prompt.confirm(`delete virtual model "${id}"?`))) throw new CliError("cancelled");

    await removeModel(await ctx.store(), id);
    emit(ctx, writer, { id, removed: true }, () => `${id} removed`);
  },
};

export const modelsDryRun: Command = {
  usage: "models dry-run <id> [--tools] [--images] [--reasoning]",
  summary: "Show where a request for this model would be sent, and why",
  options: {
    tools: { type: "boolean" },
    images: { type: "boolean" },
    reasoning: { type: "boolean" },
  },
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "model id");
    // The plugin-supplied providers too, or this command answers
    // `provider:missing` for a target the running gateway is serving — and does
    // so in red, on the surface an operator reaches for when something looks
    // wrong. `omni doctor` on the same installation already reads the manifests
    // and calls that configuration healthy; a diagnostic that contradicts
    // another diagnostic is worse than one that says nothing.
    const { descriptors, failures } = await pluginProviders(ctx.root.root);
    const result = await dryRun(
      { store: await ctx.store(), now: ctx.now, providers: descriptors },
      id,
      {
        tools: boolFlag(args.values, "tools"),
        images: boolFlag(args.values, "images"),
        reasoning: boolFlag(args.values, "reasoning"),
      },
    );

    // Named before the result, because a plugin that failed to read is the
    // likeliest reason a target below is about to be reported as missing.
    for (const failure of failures) {
      note(ctx, writer, paint(ctx, "yellow", `plugin ${failure.id}: ${failure.reason}`));
    }

    // Carried in the payload, not only on stderr. `note()` is a no-op under
    // `--json`, so a script or a support ticket built on it saw
    // `provider:missing` with the cause deleted — and the cause is the whole
    // reason these lines are printed before the result.
    emit(ctx, writer, { ...result, pluginFailures: failures }, () => {
      const header = fields([
        ["model", result.modelId],
        ["strategy", result.strategy],
        // A weighted model draws a candidate at random per request; this ranking
        // is one possible order, not the order.
        ["deterministic", result.deterministic ? "yes" : "no (weighted draw)"],
      ]);

      const candidates =
        result.candidates.length === 0
          ? state(ctx, false, "no candidate can serve this request")
          : table(
              [
                { header: "#", align: "right" },
                { header: "CREDENTIAL" },
                { header: "PROVIDER" },
                { header: "MODEL" },
                { header: "TIER", align: "right" },
                { header: "SCORE", align: "right" },
              ],
              result.candidates.map((candidate, index) => [
                String(index + 1),
                candidate.credentialLabel,
                provider(ctx, candidate.provider),
                candidate.model,
                String(candidate.tier),
                candidate.score.toFixed(3),
              ]),
            );

      const excluded =
        result.excluded.length === 0
          ? ""
          : `\n\n${paint(ctx, "dim", "excluded")}\n${table(
              [{ header: "CREDENTIAL" }, { header: "MODEL" }, { header: "REASON" }],
              result.excluded.map((row) => [row.credentialId, row.model, row.reason]),
            )}`;

      return `${header}\n\n${candidates}${excluded}`;
    });
  },
};
