import type { ProviderId } from "@omni/ir";

export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
};

/** Top-level JSON key order, matching each CLI's own serializer. */
export const BODY_ORDER: Readonly<Record<ProviderId, readonly string[]>> = {
  anthropic: [
    "model",
    "messages",
    "system",
    "tools",
    "tool_choice",
    "metadata",
    "max_tokens",
    "temperature",
    "thinking",
    "context_management",
    "output_config",
    "stream",
  ],
  openai: [
    "model",
    "stream",
    "input",
    "instructions",
    "store",
    "reasoning",
    "prompt_cache_key",
    "tools",
    "tool_choice",
    "include",
    "service_tier",
    "client_metadata",
    "parallel_tool_calls",
    "metadata",
  ],
  // Constructed, not captured. See the profile note in Task 8B.
  kimi: ["model", "messages", "tools", "tool_choice", "max_tokens", "temperature", "stream"],
};

/**
 * Rebuilds an object with `order`'s keys first.
 *
 * Only top-level keys are ordered; nested objects keep whatever order they
 * were built with. Keys absent from `obj` are skipped, and keys absent from
 * `order` append in their original order.
 *
 * Caveat: V8 hoists integer-like keys ("0", "42") ahead of string keys no
 * matter what this function does. No order above contains one, and
 * body.test.ts holds that line.
 */
export function orderFields(
  obj: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const key of order) {
    if (Object.hasOwn(obj, key)) {
      out[key] = obj[key];
      seen.add(key);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!seen.has(key)) out[key] = obj[key];
  }
  return out;
}

const BUILD_REVISION = envOr("OMNI_ANTHROPIC_BUILD_REVISION", "250");
const CLI_VERSION = envOr("OMNI_ANTHROPIC_CLI_VERSION", "2.1.219");

/** Placeholder is the same width as the real token, so substitution is safe. */
const CCH_PLACEHOLDER = "00000";
const CCH_SEED = 0x6e52736ac806831en;
const CCH_MASK = 0xfffffn;

const BILLING_PREFIX = "x-anthropic-billing-header:";
const AGENT_PREAMBLE = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

function envOr(name: string, fallback: string): string {
  const raw = Bun.env[name];
  return typeof raw === "string" && /^[\x20-\x7E]{1,200}$/.test(raw) ? raw : fallback;
}

function billingBlock(): string {
  return (
    `${BILLING_PREFIX} cc_version=${CLI_VERSION}.${BUILD_REVISION}; ` +
    `cc_entrypoint=cli; cch=${CCH_PLACEHOLDER};`
  );
}

/** Paragraphs mentioning any of these are dropped whole. */
const BANNED_SUBSTRINGS = [
  "github.com/anomalyco/o‍pencode",
  "o‍pencode.ai/docs",
  "github.com/c‍line/c‍line",
  "github.com/getc‍ursor/c‍ursor",
  "c‍ontinue.dev",
];

const REWRITES: readonly (readonly [string, string])[] = [
  ["if O‍penCode honestly", "if the assistant honestly"],
  [
    "Here is some useful information about the environment you are running in:",
    "Environment context you are running in:",
  ],
];

/**
 * Runs the system blocks through the Anthropic pipeline.
 *
 * This rewrites what the model sees. Order matters: drop, then rewrite, then
 * prepend, so the prepended text is never itself rewritten. Filtering is per
 * paragraph within each block, so one banned paragraph does not take an
 * otherwise good block with it.
 *
 * Idempotent — the billing block and the preamble are filtered out on the way
 * in, so re-running never stacks a second copy.
 */
export function applyAnthropicSystem(system: readonly SystemBlock[]): SystemBlock[] {
  const kept: SystemBlock[] = [];

  for (const block of system) {
    const text = block.text
      .split(/\n{2,}/)
      .filter((p) => !BANNED_SUBSTRINGS.some((b) => p.includes(b)))
      .filter((p) => !p.trimStart().startsWith("You are O‍penCode"))
      .filter((p) => !p.includes(BILLING_PREFIX))
      .filter((p) => p.trim() !== AGENT_PREAMBLE)
      .join("\n\n");

    let rewritten = text;
    for (const [from, to] of REWRITES) rewritten = rewritten.replaceAll(from, to);
    // A caller's cache breakpoint rides on its block. Rewriting the text
    // changes what is cached, but dropping the marker would cache nothing at
    // all, which is the worse of the two.
    if (rewritten.trim().length > 0) {
      kept.push({
        type: "text",
        text: rewritten,
        ...(block.cache_control === undefined ? {} : { cache_control: block.cache_control }),
      });
    }
  }

  return [{ type: "text", text: billingBlock() }, { type: "text", text: AGENT_PREAMBLE }, ...kept];
}

/** xxHash64 of the body, masked to 20 bits, as five zero-padded hex digits. */
export function computeCch(body: string): string {
  const digest = Bun.hash.xxHash64(Buffer.from(body, "utf8"), CCH_SEED);
  return (digest & CCH_MASK).toString(16).padStart(5, "0");
}

/**
 * Replaces the cch placeholder with a token computed over the serialized body.
 *
 * The token is computed over the body *containing the placeholder*, then
 * swapped in. Both are five characters, so the bytes on the wire are the bytes
 * that were hashed — length-preserving substitution is the whole trick.
 */
export function signAnthropicBody(json: string): string {
  const needle = `cch=${CCH_PLACEHOLDER};`;
  if (!json.includes(needle)) return json;
  return json.replace(needle, `cch=${computeCch(json)};`);
}
