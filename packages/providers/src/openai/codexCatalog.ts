/**
 * The per-model values Codex reads from its bundled model catalog.
 *
 * Copied from `codex-rs/models-manager/models.json` at `rust-v0.163.0`, the
 * release the OAuth fingerprint claims. Codex chooses the request shape and
 * several defaults per model from these fields, so a request for one model has
 * to carry that model's values to look like Codex's: `use_responses_lite`,
 * `default_verbosity`, `default_reasoning_level`, the lowest entry of
 * `supported_reasoning_levels`, `supports_parallel_tool_calls`, and the two
 * `node_repl_*` flags its turn metadata repeats. Every row is copied, hidden
 * models included.
 *
 * Refreshed with the version, never separately: the bump procedure in
 * `scripts/codex-capture/README.md` names this file.
 */
export type CodexModel = {
  /** `use_responses_lite`: tools and base instructions travel inside `input`. */
  lite: boolean;
  /** `default_verbosity`, sent as `text.verbosity`. */
  verbosity: string;
  /** `default_reasoning_level`: the effort sent when the client named none. */
  defaultEffort: string;
  /** The lowest supported level: what `off` and `betweenTools` become. */
  lowestEffort: string;
  nodeReplAutoReviewRequired: boolean;
  nodeReplDisabled: boolean;
  /**
   * `supports_parallel_tool_calls`: what a non-lite request sends as
   * `parallel_tool_calls` (lite always sends `false`). True on every row.
   */
  supportsParallelToolCalls: boolean;
};

export const CODEX_CATALOG_RELEASE = "0.163.0";

const entry = (
  defaultEffort: string,
  nodeReplAutoReviewRequired: boolean,
  over: Partial<CodexModel> = {},
): CodexModel => ({
  lite: true,
  verbosity: "low",
  defaultEffort,
  lowestEffort: "low",
  nodeReplAutoReviewRequired,
  nodeReplDisabled: false,
  supportsParallelToolCalls: true,
  ...over,
});

/**
 * What a model this table does not list is sent with.
 *
 * Every model in the 0.163.0 catalog but `gpt-5.5` is lite, and a non-lite
 * 0.163 request was never captured, so an unlisted id — the bare `gpt-5.6`
 * alias, a model released after this table — takes the shape and defaults the
 * lite rows share rather than a shape nothing measured.
 */
const UNLISTED: CodexModel = entry("low", false);

/**
 * Every row of the bundled catalog, hidden ones included: a target may name any
 * of them, and Codex sends each with its own values.
 *
 * Null-prototype, as every id-keyed table here: a model id is operator text.
 */
const MODELS: Readonly<Record<string, CodexModel>> = Object.assign(Object.create(null), {
  "gpt-6-astra": entry("low", true),
  "gpt-6.1-sol": entry("low", true),
  "gpt-6-sol": entry("medium", true),
  "gpt-6-luna": entry("medium", false),
  "gpt-5.6-sol": entry("low", false),
  "gpt-5.6-terra": entry("medium", false),
  "gpt-5.6-luna": entry("medium", false),
  "gpt-daybreak-blue-latest": entry("low", false),
  "gpt-daybreak-red-latest": entry("medium", false, { verbosity: "high" }),
  "gpt-5.5": entry("medium", false, { lite: false }),
  "codex-auto-review": entry("medium", false),
});

export function codexModel(model: string): CodexModel {
  return MODELS[model] ?? UNLISTED;
}
