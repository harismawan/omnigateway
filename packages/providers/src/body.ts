import { createHash } from "node:crypto";
import { ANTHROPIC_CLI_VERSION, anthropicBodyOrder } from "./anthropic/profile.ts";
import { antigravityBodyOrder } from "./antigravity/profile.ts";
import { customBodyOrder } from "./custom/profile.ts";
import { grokBodyOrder } from "./grok/profile.ts";
import { kiloBodyOrder } from "./kilo/profile.ts";
import { kimiBodyOrder } from "./kimi/profile.ts";
import { museBodyOrder } from "./muse/profile.ts";
import { openaiBodyOrder } from "./openai/profile.ts";

export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
};

/** Top-level JSON key order, matching each CLI's own serializer. */
export const BODY_ORDER: Readonly<Record<string, readonly string[]>> = {
  anthropic: anthropicBodyOrder,
  openai: openaiBodyOrder,
  kimi: kimiBodyOrder,
  kilo: kiloBodyOrder,
  grok: grokBodyOrder,
  antigravity: antigravityBodyOrder,
  muse: museBodyOrder,
  custom: customBodyOrder,
};

// Nothing to inherit; see the note on `PROVIDER_DESCRIPTORS`.
Object.setPrototypeOf(BODY_ORDER, null);

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

/** Placeholder is the same width as the real token, so substitution is safe. */
const CCH_PLACEHOLDER = "00000";
const CCH_SEED = 0x6e52736ac806831en;
const CCH_MASK = 0xfffffn;

/** Salt the CLI hashes its `cc_version` suffix with (2.1.258, `LFo`). */
const CCV_SALT = "59cf53e54c78";

const BILLING_PREFIX = "x-anthropic-billing-header:";
const AGENT_PREAMBLE = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * The suffix after the version in `cc_version` is not a build number. The CLI
 * takes the text of the first user message, picks the characters at 4, 7 and
 * 20 (`"0"` where the text is shorter), and hashes salt + those + version with
 * SHA-256, keeping three hex digits. So it changes per conversation, and a
 * fixed `250` was the right width and never the right value.
 */
export function ccVersionSuffix(firstUserText: string): string {
  const picked = [4, 7, 20].map((i) => firstUserText[i] ?? "0").join("");
  return createHash("sha256")
    .update(`${CCV_SALT}${picked}${ANTHROPIC_CLI_VERSION}`)
    .digest("hex")
    .slice(0, 3);
}

function billingBlock(firstUserText: string): string {
  return (
    `${BILLING_PREFIX} cc_version=${ANTHROPIC_CLI_VERSION}.${ccVersionSuffix(firstUserText)}; ` +
    `cc_entrypoint=cli; cch=${CCH_PLACEHOLDER};`
  );
}

/** Paragraphs mentioning any of these are dropped whole. */
const BANNED_SUBSTRINGS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
  "github.com/cline/cline",
  "github.com/getcursor/cursor",
  "continue.dev",
  // Hermes Agent's help paragraph (`HERMES_AGENT_HELP_GUIDANCE` in its
  // `agent/prompt_builder.py`). Its repository URL is deliberately absent:
  // that string does not appear in the prompt, only in third-party copies of
  // this list, and a banned substring that matches nothing is worse than no
  // entry — it reads as coverage.
  "hermes-agent.nousresearch.com",
];

/**
 * Paragraphs opening with one of these are dropped whole.
 *
 * Each is the first phrase of an identity paragraph the client assembles as a
 * standalone section, so dropping the paragraph takes the identity and nothing
 * around it.
 */
const IDENTITY_PREFIXES = ["You are OpenCode", "You are Hermes Agent"];

const REWRITES: readonly (readonly [string, string])[] = [
  ["if OpenCode honestly", "if the assistant honestly"],
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
 *
 * `firstUserText` is what the CLI hashes into `cc_version`: the first text
 * block of the first user message. It diverges from the CLI's own value in two
 * known shapes: the CLI skips its own meta messages there and the gateway
 * cannot tell which those were, and Claude Code often puts a system-reminder
 * block as the first text block, so the hashed characters come from the
 * reminder rather than the prompt. A first user turn with no text block at all
 * hashes as "". Every one of those is still one value per conversation, which
 * a constant never was.
 */
export function applyAnthropicSystem(
  system: readonly SystemBlock[],
  firstUserText: string,
): SystemBlock[] {
  const kept: SystemBlock[] = [];

  for (const block of system) {
    const text = block.text
      .split(/\n{2,}/)
      .filter((p) => !BANNED_SUBSTRINGS.some((b) => p.includes(b)))
      .filter((p) => !IDENTITY_PREFIXES.some((i) => p.trimStart().startsWith(i)))
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

  return [
    { type: "text", text: billingBlock(firstUserText) },
    { type: "text", text: AGENT_PREAMBLE },
    ...kept,
  ];
}

/** xxHash64 of the body, masked to 20 bits, as five zero-padded hex digits. */
export function computeCch(body: string): string {
  const digest = Bun.hash.xxHash64(Buffer.from(body, "utf8"), CCH_SEED);
  return (digest & CCH_MASK).toString(16).padStart(5, "0");
}

/**
 * Where the billing block starts in the serialized body. The framing quotes
 * are unescaped, so this sequence cannot occur inside any JSON string value —
 * which is what makes it safe against a tool result that quotes the block.
 */
const BILLING_ANCHOR = `"system":[{"type":"text","text":"${BILLING_PREFIX}`;

/**
 * Replaces the cch placeholder with a token computed over the serialized body.
 *
 * The token is computed over the body *containing the placeholder*, then
 * swapped in. Both are five characters, so the bytes on the wire are the bytes
 * that were hashed — length-preserving substitution is the whole trick.
 *
 * Only the placeholder inside the system billing block is replaced. `messages`
 * serialize before `system`, and a first-match replace once landed on a tool
 * result that quoted `cch=00000;` — rewriting that message with a fresh hash
 * every request, which broke the prompt cache from that turn onward for the
 * rest of the conversation.
 */
export function signAnthropicBody(json: string): string {
  const needle = `cch=${CCH_PLACEHOLDER};`;
  const anchor = json.indexOf(BILLING_ANCHOR);
  if (anchor < 0) return json;
  const at = json.indexOf(needle, anchor);
  if (at < 0) return json;
  return `${json.slice(0, at)}cch=${computeCch(json)};${json.slice(at + needle.length)}`;
}
