/**
 * Secret masking for captured bodies.
 *
 * Excluding headers from capture is necessary but not sufficient. Secrets reach
 * bodies by other routes: a user pastes an API key into a prompt to ask why it
 * is failing, a provider echoes a credential fragment back in an error message,
 * a tool result contains a config file. A body corpus that leaks a live
 * credential is a worse failure than one that elides a base64 blob, so this runs
 * over everything before it is written, and it is deliberately blunt.
 *
 * Five rules, applied in order. The first four are structural — they recognise
 * the shape of a credential and keep the shape while dropping the secret, so a
 * reader can still see *that* a bearer token was present. The last is a length
 * rule with no notion of what it is looking at, and it is the one that costs
 * fidelity: it also hits base64 image data, content hashes, and minified source.
 * That is accepted. The tests pin both what is redacted and what survives, so
 * the false-positive surface is a known quantity rather than a discovery made
 * during an incident.
 *
 * The order is a chain, not a set, and the tests pin a property over it: a rule
 * added here may only ever redact *more* than the chain without it. That is not
 * automatic. A shape rule keeps its prefix in clear, so one that fires inside a
 * run the length rule would have eaten whole hands back everything to the left
 * of the prefix — which is exactly what a `\b` anchor did here, because `-` is
 * both a token character and a word boundary. Hence the lookbehinds below, and
 * hence `masking never redacts less than the chain without its shape rules` in
 * the tests.
 *
 * The shape rules are not decoration on top of the length rule; they exist
 * because the length rule provably cannot be the whole answer. Its threshold is
 * derived from base64url, and a great many real credentials fall outside that:
 * shorter than forty-one characters (a Google `AIza…` key is thirty-nine, a
 * `GOCSPX-…` client secret thirty-five, an Azure OpenAI key thirty-two hex), or
 * long enough but broken into short runs by a character outside the token class
 * (an AWS secret access key and a standard-base64 secret both contain `+` or
 * `/`), or exactly forty characters — which is unmaskable by construction,
 * because `req_<uuid>` is forty characters and masking that would destroy the
 * correlation this feature exists to serve. A prefix is precise where a length
 * is not, so every credential family that announces itself gets a rule and the
 * length rule is left to catch the ones that do not.
 */

const ELIDED = "[redacted]";

/**
 * `Bearer <token>`, in any casing, including the scheme so the reader can see
 * what was there. The token class is RFC 6750's `b64token` plus the characters
 * real providers use in practice.
 */
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * `sk-`, `ak-`, and `pk-` prefixed keys, which is how OpenAI, Anthropic, and
 * this gateway's own keys are all spelled. The prefix survives because knowing
 * which vendor's key leaked is what an operator acts on.
 *
 * Eight characters minimum so `sk-` in prose is not a match; every real key is
 * far longer.
 *
 * The lookbehind, rather than a `\b`, keeps it from firing part-way into a run
 * of token characters. `\b` would do that for `task-` — but `-` is itself a
 * boundary *and* a token character, so `\b` also fires on the `sk-` inside
 * `<forty chars>-sk-<key>`, which leaves everything to its left in clear where
 * `OPAQUE` would have elided the run whole. A real key always starts a run, so
 * excluding `-` as well costs nothing.
 */
const PREFIXED_KEY = /(?<![A-Za-z0-9_-])(?:sk|ak|pk)-[A-Za-z0-9_-]{8,}/g;

/**
 * The credential families that announce themselves and that neither of the rules
 * above nor the length rule below would reach.
 *
 * Every one of these was probed against the length rule and survived it:
 *
 * - `ghp_`/`gho_`/`ghs_`/`ghu_`, GitHub's token prefixes, are forty characters
 *   whole — one short of the threshold, and one short by construction, since the
 *   threshold sits above `req_<uuid>`'s forty.
 * - `github_pat_`, the fine-grained form, is long enough for the length rule, but
 *   only masking it here keeps the prefix that tells an operator *what* leaked.
 * - `AIza…`, Google's API key, is thirty-nine.
 * - `GOCSPX-…`, a Google OAuth client secret, is thirty-five.
 *
 * Anthropic's `sk-ant-…` is deliberately absent: `PREFIXED_KEY` already catches
 * it and leaves `sk-`, and a second rule for it would be a duplicate that only
 * changes which of the two fires first. `xai-` is absent for the opposite
 * reason, and has a rule of its own below.
 *
 * Eight trailing characters minimum, matching `PREFIXED_KEY`, so a bare prefix
 * written in prose is not a match. The prefix survives the replacement because
 * knowing which vendor's credential leaked is what an operator acts on.
 *
 * The lookbehind is `PREFIXED_KEY`'s, and is here for the same reason: a `\b`
 * fires after a `-`, so `<forty chars>-AIza<key>` matched from the prefix onward
 * and left the leading forty characters in clear, where the length rule alone
 * had elided the run whole. Every credential listed above starts a run.
 */
const VENDOR_KEY = /(?<![A-Za-z0-9_-])(?:gh[posu]_|github_pat_|AIza|GOCSPX-)[A-Za-z0-9_-]{8,}/g;

/** The part of a `VENDOR_KEY` match that survives it. */
const VENDOR_PREFIX = /^(?:gh[posu]_|github_pat_|AIza|GOCSPX-)/;

/**
 * xAI's key, which needs a narrower trailing class than the families above and
 * therefore cannot share their rule.
 *
 * Every other prefix here belongs to a shape only that vendor's secrets are
 * spelled in. `xai-` is not: it is also how clients and aggregators name xAI
 * *models*, so `xai-grok-4-latest` in a captured body is an ordinary payload and
 * not a leak. Under the shared class every such alias was destroyed, which is a
 * false positive on exactly the text this feature exists to let someone read.
 *
 * The separator is what tells the two apart. An xAI key is the prefix followed
 * by one long alphanumeric run, so requiring the eight trailing characters to
 * hold no `-` keeps every key and releases every alias, whose segments are
 * dash-separated words far shorter than eight characters each.
 *
 * That test is not applied to the others, because it does not hold for them: a
 * `GOCSPX-` secret and a `github_pat_` token both carry `-` or `_` inside the
 * secret, and narrowing their class would cut a real credential in half and
 * leave the tail in clear — the very failure this file is about.
 */
const XAI_KEY = /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9_]{8,}/g;

/**
 * The blunt rule: an unbroken run of token characters long enough that nothing
 * written by a human is likely to be there.
 *
 * `.`, `/`, `:`, and whitespace are outside the class on purpose, which is what
 * keeps file paths, URLs, dotted identifiers, timestamps, and ordinary prose
 * intact — those break into short runs.
 *
 * The threshold is pinned between two real lengths rather than picked round. The
 * longest id the gateway mints is `req_` plus a UUID, forty characters, and it
 * is the key that joins an artifact to its log line — redacting it would break
 * the correlation this feature exists to serve. The shortest base64url encoding
 * of a 256-bit secret is forty-three characters, and this gateway's own API keys
 * are exactly that. Forty-one is the only band that keeps the first and catches
 * the second, so it is a boundary rather than a guess.
 *
 * It is a boundary for *base64url* specifically, and the guarantee is no wider
 * than that. Standard base64 encodes the same 256 bits in forty-four characters
 * and this rule still misses it, because `+` and `/` are outside the class and
 * split the run into sub-threshold pieces — the same reason it misses an AWS
 * secret access key. Anything at exactly forty characters is out of reach
 * permanently, since that is where `req_<uuid>` sits. The shape rules above
 * exist for the families this leaves behind, and all of them together are still
 * best-effort rather than a guarantee.
 *
 * A JWT is caught by this rule rather than by a shape of its own, because its
 * three dot-separated segments are each individually over the threshold.
 */
const OPAQUE = /[A-Za-z0-9_-]{41,}/g;

/** Which rule a chain entry is, so a test can rebuild the chain it joined. */
export type MaskRuleId = "bearer" | "prefixedKey" | "vendorKey" | "xaiKey" | "opaque";

/**
 * One rule: what it recognises, and how much of what it recognised survives.
 *
 * `keep` counts leading characters of the match rather than returning the text
 * to put back, because the monotonicity test reasons in *input positions* — it
 * compares which characters each chain elided — and a rule that described its
 * survivors as a string could not be lined up against the input.
 */
export type MaskRule = {
  id: MaskRuleId;
  pattern: RegExp;
  /** How many leading characters of a match are left in clear. */
  keep: (match: string) => number;
};

/**
 * The chain, in order. Exported so the tests can reconstruct an earlier chain
 * from it and assert this one never redacts less than that one did.
 */
export const MASK_RULES: readonly MaskRule[] = [
  {
    id: "bearer",
    pattern: BEARER,
    // Scheme and the whitespace after it, verbatim: the separator is part of
    // what the reader is being shown was there.
    keep: (match) => match.length - match.replace(/^bearer\s+/i, "").length,
  },
  // Two characters of prefix and the hyphen.
  { id: "prefixedKey", pattern: PREFIXED_KEY, keep: () => 3 },
  {
    id: "vendorKey",
    pattern: VENDOR_KEY,
    keep: (match) => VENDOR_PREFIX.exec(match)?.[0].length ?? 0,
  },
  { id: "xaiKey", pattern: XAI_KEY, keep: () => "xai-".length },
  { id: "opaque", pattern: OPAQUE, keep: () => 0 },
];

/** Masks one string. Exported for the tests that pin the surface both ways. */
export function maskString(value: string): string {
  return MASK_RULES.reduce(
    (masked, rule) =>
      masked.replace(
        rule.pattern,
        (match: string) => `${match.slice(0, rule.keep(match))}${ELIDED}`,
      ),
    value,
  );
}

/**
 * Masks every string value in a JSON-shaped tree, leaving the structure alone.
 *
 * Object *keys* are not masked. A key is a schema name chosen by the client or
 * the provider, not a place secrets are carried, and rewriting one would corrupt
 * the very structure the artifact exists to let someone read.
 *
 * Runs before structural bounding rather than after. Bounding truncates strings,
 * and a secret cut in half is a secret that may no longer match the rule that
 * would have caught it whole.
 */
export function maskSecrets(value: unknown): unknown {
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value !== null && typeof value === "object") {
    // `fromEntries` defines own properties, so a `__proto__` key that arrived
    // through `JSON.parse` stays a key rather than becoming an assignment.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecrets(v)]));
  }
  return value;
}
