/**
 * The per-model values Codex reads from its bundled model catalog.
 *
 * Copied from `codex-rs/models-manager/models.json` at `rust-v0.163.0`, the
 * release the OAuth fingerprint claims. Codex chooses the request shape and
 * several defaults per model from these fields, so a request for one model has
 * to carry that model's values to look like Codex's: `use_responses_lite`,
 * `default_verbosity`, `default_reasoning_level`, the lowest entry of
 * `supported_reasoning_levels`, and the two `node_repl_*` flags its turn
 * metadata repeats.
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
};

export const CODEX_CATALOG_RELEASE = "0.163.0";

const entry = (defaultEffort: string, nodeReplAutoReviewRequired: boolean): CodexModel => ({
  lite: true,
  verbosity: "low",
  defaultEffort,
  lowestEffort: "low",
  nodeReplAutoReviewRequired,
  nodeReplDisabled: false,
});

/**
 * What a model this table does not list is sent with.
 *
 * Every GPT model in the 0.163.0 catalog is lite, and a non-lite 0.163 request
 * was never captured, so an unlisted id — the bare `gpt-5.6` alias, a model
 * released after this table — takes the shape and defaults every listed model
 * shares rather than a shape nothing measured.
 */
const UNLISTED: CodexModel = entry("low", false);

/** Null-prototype, as every id-keyed table here: a model id is operator text. */
const MODELS: Readonly<Record<string, CodexModel>> = Object.assign(Object.create(null), {
  "gpt-6-astra": entry("low", true),
  "gpt-6.1-sol": entry("low", true),
  "gpt-6-sol": entry("medium", true),
  "gpt-6-luna": entry("medium", false),
  "gpt-5.6-sol": entry("low", false),
  "gpt-5.6-terra": entry("medium", false),
  "gpt-5.6-luna": entry("medium", false),
});

export function codexModel(model: string): CodexModel {
  return MODELS[model] ?? UNLISTED;
}
