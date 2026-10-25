/**
 * Elasticsearch index names: the pattern rule shared by the config write in
 * `export.ts` and the gateway's bulk encoder. Pure — no clock; the instant is
 * always a parameter.
 *
 * One copy here rather than in the encoder because `@omni/control` cannot
 * import from `apps/gateway`, and a pattern the write accepted must be one the
 * encoder accepts.
 */

export const DEFAULT_INDEX_PATTERN = "omni-logs-{yyyy.MM.dd}";

/** The one token a pattern may carry: the row's UTC start day. */
export const INDEX_DATE_TOKEN = "{yyyy.MM.dd}";

const MAX_INDEX_BYTES = 255;
const FORBIDDEN = /[\\/*?"<>| ,#:]/;
const utf8 = new TextEncoder();

/**
 * Why Elasticsearch would refuse this index name, or `null` when it would not.
 *
 * Checked before sending because a refused index comes back as a per-item 400
 * on every document — which the bulk reader rightly reads as "drop these" — so
 * a bad pattern would silently discard everything the destination sends.
 */
export function indexNameProblem(name: string): string | null {
  if (name.length === 0) return "index name is empty";
  if (name !== name.toLowerCase()) return "index name must be lowercase";
  if (name === "." || name === "..") return "index name cannot be . or ..";
  if (/^[-_+]/.test(name)) return "index name cannot start with -, _ or +";
  if (FORBIDDEN.test(name)) return 'index name cannot contain \\ / * ? " < > | space , # or :';
  if (utf8.encode(name).length > MAX_INDEX_BYTES) return "index name is longer than 255 bytes";
  return null;
}

/**
 * The pattern with every `{yyyy.MM.dd}` replaced by the UTC day of `at` (epoch
 * ms); everything else is kept verbatim. Not checked — pair with
 * {@link indexNameProblem}.
 */
export function expandIndexPattern(pattern: string, at: number): string {
  const day = new Date(at);
  const date = [
    String(day.getUTCFullYear()).padStart(4, "0"),
    String(day.getUTCMonth() + 1).padStart(2, "0"),
    String(day.getUTCDate()).padStart(2, "0"),
  ].join(".");
  return pattern.replaceAll(INDEX_DATE_TOKEN, date);
}
