import type { ChatRequest } from "@omni/ir";

export type ToolCloak = { toWire: Map<string, string>; fromWire: Map<string, string> };

/** Already in the target shape, so renaming it would change nothing. */
const ALREADY_CLOAKED = /^[A-Z][A-Za-z0-9]*$/;

/**
 * The prefix an MCP server's tools arrive under.
 *
 * It is routing, not decoration: the client resolves the server and the remote
 * tool out of the name, so a rename would break the call it names.
 */
const MCP_PREFIX = "mcp__";

/** Whether a client's tool name is one this cloak declines to rename. */
function isExempt(name: string): boolean {
  return ALREADY_CLOAKED.test(name) || name.startsWith(MCP_PREFIX);
}

/** Anthropic accepts `^[a-zA-Z0-9_-]{1,128}$`, which every alias must satisfy. */
const MAX_ALIAS = 128;
const SUFFIX_LENGTH = 6;

/**
 * The bare alias, plus whether it must carry a suffix whatever else claims it.
 *
 * Two shapes cannot stand on their own: a name with no alphanumerics has no
 * words to capitalise, and one longer than the ceiling has to lose characters
 * to fit. Both are given the suffix, which restores the distinctness the
 * transformation just removed.
 *
 * An empty name is not reachable through ingress validation, so `Tool` plus a
 * suffix is what it degrades to rather than a case worth guarding. Note the
 * asymmetry with `encodeTool`, which *does* test `name === ""` — there it is
 * `mcp_toolset`, an Anthropic tool that legitimately has no name at all.
 */
function aliasFor(name: string): { base: string; forced: boolean } {
  const joined = name
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  if (joined === "") return { base: "Tool", forced: true };
  if (joined.length > MAX_ALIAS) {
    return { base: joined.slice(0, MAX_ALIAS - SUFFIX_LENGTH), forced: true };
  }
  return { base: joined, forced: false };
}

/**
 * Every client tool name that can reach the wire, split by what happens to it.
 *
 * Three sources, not one: a `CustomToolDef` in `tools[]`, a `toolUse` block in
 * message history, and a `tool_choice` naming one. A name can appear in the
 * second and not the first — the client dropped the tool but kept the turn that
 * called it — and building from `tools[]` alone would send that one out
 * unrenamed.
 *
 * `reserved` matters as much as `renamable`. An exempt name is not renamed, so
 * it reaches the wire under its own spelling and has to claim it: without that,
 * a client sending both `ReadFile` and `read_file` gets one alias landing on
 * the other tool's real name.
 */
function clientToolNames(request: ChatRequest): { renamable: string[]; reserved: string[] } {
  const renamable = new Set<string>();
  const reserved = new Set<string>();
  const add = (name: string): void => {
    (isExempt(name) ? reserved : renamable).add(name);
  };

  for (const tool of request.tools ?? []) {
    if (tool.provider === "custom") add(tool.name);
  }
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "toolUse") add(block.name);
    }
  }
  if (request.toolChoice?.type === "tool") add(request.toolChoice.name);
  return { renamable: [...renamable], reserved: [...reserved] };
}

/**
 * Six hex characters of the original name, capitalised.
 *
 * Derived from the source name rather than from a position in `tools[]`, which
 * is what makes a colliding tool's alias survive the client reordering the
 * array. The primitive is the one `computeCch` already uses.
 *
 * Twenty-four bits, not sixteen. Two names that share a base *and* draw the
 * same suffix produce one alias, and `fromWire` keeps whichever was written
 * last — so that tool's replies come back under the other one's name, silently.
 * The suffix is the only thing standing between a collision and that outcome,
 * and two extra characters take the odds from roughly one in 65 thousand to one
 * in 16 million.
 *
 * Two residual cases remain, both left open deliberately. Two names can share a
 * base *and* draw the same suffix; and a suffixed alias is never re-checked
 * against `claims`, so a client tool literally named `ReadFileEa70ad` beside a
 * `read_file` that derives it would still collide. Both need the hash to hit an
 * adversarially chosen string, so the loop below closes the first-order case
 * and stops there — but it does stop there, and a reader told the odds are one
 * in 16 million should not read that as "closed".
 */
function suffixFor(name: string): string {
  const digest = Bun.hash.xxHash64(Buffer.from(name, "utf8")) & 0xffffffn;
  const hex = digest.toString(16).padStart(SUFFIX_LENGTH, "0");
  return hex.charAt(0).toUpperCase() + hex.slice(1);
}

export function buildToolCloak(request: ChatRequest): ToolCloak | null {
  const { renamable, reserved } = clientToolNames(request);

  // Every name that reaches the wire unrenamed claims its spelling before any
  // alias is handed out, so a candidate deriving one of them is in a collision
  // like any other. Two kinds qualify, for the same reason and not the same
  // rule: Anthropic's own names are fixed by Anthropic, and an exempt client
  // name is one this cloak declined to touch. Leaving the second kind out is
  // what let `read_file` derive `ReadFile` while the client's own `ReadFile`
  // sat beside it — two tools under one name upstream, and the genuine one
  // coming back as the other.
  const claims = new Map<string, number>();
  const claim = (name: string): void => {
    claims.set(name, (claims.get(name) ?? 0) + 1);
  };
  for (const tool of request.tools ?? []) {
    if (tool.provider === "anthropic" && tool.name !== "") claim(tool.name);
  }
  for (const name of reserved) claim(name);

  const bases = new Map<string, { base: string; forced: boolean }>();
  for (const name of renamable) {
    const derived = aliasFor(name);
    bases.set(name, derived);
    claim(derived.base);
  }

  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const [name, { base, forced }] of bases) {
    // Every member of a contested group takes a suffix, not just the ones after
    // the first: leaving the first bare would make its alias depend on which
    // order the names were walked in. A reserved name is the one exception, and
    // cannot be otherwise — it is on the wire under its own spelling already.
    const alias = forced || (claims.get(base) ?? 0) > 1 ? base + suffixFor(name) : base;
    toWire.set(name, alias);
    fromWire.set(alias, name);
  }

  return toWire.size === 0 ? null : { toWire, fromWire };
}

export function cloakName(cloak: ToolCloak | null, name: string): string {
  return cloak?.toWire.get(name) ?? name;
}

export function uncloakName(cloak: ToolCloak | null, name: string): string {
  return cloak?.fromWire.get(name) ?? name;
}
