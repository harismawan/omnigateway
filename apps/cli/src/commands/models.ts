import { dryRun, getModel, listModels, putModel, removeModel } from "@omni/control";
import { PROVIDER_CAPABILITIES, type ProviderId } from "@omni/ir";
import { catalogPricing, PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import type { Target, VirtualModel } from "@omni/store";
import { boolFlag, listFlag, requirePositional, stringFlag, UsageError } from "../args.ts";
import { type Command, provider, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, paint, table } from "../output.ts";

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
            { header: "TIER", align: "right" },
            { header: "WEIGHT", align: "right" },
            { header: "IN $/MTOK", align: "right" },
            { header: "OUT $/MTOK", align: "right" },
            { header: "CAPABILITIES" },
          ],
          model.targets.map((target) => [
            provider(ctx, target.provider),
            target.model,
            String(target.tier),
            String(target.weight),
            target.costPerMTok.input.toFixed(2),
            target.costPerMTok.output.toFixed(2),
            capabilityList(target),
          ]),
        ),
      ].join("\n"),
    );
  },
};

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
  if (!isCatalogProvider(providerId)) {
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
    // Capabilities are a property of the provider, not of the catalog entry;
    // the operator narrows them afterwards if a particular model is narrower.
    capabilities: PROVIDER_CAPABILITIES[providerId],
  };
}

function isCatalogProvider(value: string): value is ProviderId {
  return value in PROVIDER_MODEL_CATALOG;
}

/** The catalog flattened into rows, which is how an operator reads it. */
function catalogRows(): Array<{ provider: ProviderId; id: string; label: string }> {
  return Object.entries(PROVIDER_MODEL_CATALOG).flatMap(([id, entry]) =>
    entry.models.map((model) => ({ provider: id as ProviderId, id: model.id, label: model.label })),
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
        ],
        entries.map((entry) => {
          const price = catalogPricing(entry.provider, entry.id);
          return [
            provider(ctx, entry.provider),
            entry.id,
            entry.label,
            price === null ? "\u2014" : price.input.toFixed(2),
            price === null ? "\u2014" : price.output.toFixed(2),
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
    const result = await dryRun({ store: await ctx.store(), now: ctx.now }, id, {
      tools: boolFlag(args.values, "tools"),
      images: boolFlag(args.values, "images"),
      reasoning: boolFlag(args.values, "reasoning"),
    });

    emit(ctx, writer, result, () => {
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
