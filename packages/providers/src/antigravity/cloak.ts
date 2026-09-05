import type { ChatRequest } from "@omni/ir";

/**
 * Client tool names, renamed to something Cloud Code will accept.
 *
 * **Measured 2026-09-05: an unusable function name is a 400 for the whole
 * request**, every other tool included — `Invalid function name. Must start
 * with a letter or an underscore. Must be alphameric …`, and separately
 * `Duplicate function declaration found: …`. The name is not this gateway's to
 * choose: it comes from the client's tool list, and an MCP server may name a
 * tool anything at all.
 *
 * Renaming rather than dropping, because dropping costs the client a capability
 * it asked for and never learns it lost. The cost of renaming is that the model
 * answers with the name it was given, so the map has to survive to `decode.ts`
 * — which is what `decodeState` exists for.
 *
 * **This is the second copy of this machinery**; `anthropic/cloak.ts` is the
 * first, and the two are near-identical in shape and different in every policy
 * that matters — Anthropic renames to defeat fingerprinting so *most* names
 * change, this renames only what the grammar refuses so *almost none* do.
 * Forked per boundary rule 2 rather than shared, on the same standing this
 * file's `hasCacheControl` note takes: a third copy should promote the gather /
 * claim / suffix loop to the package root beside `system.ts` and leave the two
 * policies where they are.
 */
export type ToolCloak = { toWire: Map<string, string>; fromWire: Map<string, string> };

/**
 * What Cloud Code accepts as a function name.
 *
 * Measured, including the bound the error message does not state: 128
 * characters pass and 129 do not. Dots and dashes are legal, so `mcp__srv__tool`
 * and dotted namespaces reach the wire untouched.
 */
export const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

const MAX_NAME = 128;
const SUFFIX_LENGTH = 6;

/**
 * The bare alias, plus whether it must carry a suffix whatever else claims it.
 *
 * The sanitisation is deliberately lossy — every run of refused characters
 * collapses to one `_` — so two different names can derive one alias. That is
 * what `forced` and the claim loop below are for; correctness rests on the
 * suffix, never on the sanitiser being injective.
 *
 * A name that survives with nothing left, or one that had to lose characters to
 * fit the ceiling, takes the suffix unconditionally: both transformations
 * destroy the distinctness the alias needs.
 */
function aliasFor(name: string): { base: string; forced: boolean } {
  let base = name.replace(/[^A-Za-z0-9_.-]+/g, "_");
  // The first character is its own rule: digits, dots and dashes are legal
  // *inside* a name and refused at the front.
  if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
  if (base === "_") return { base: "_tool", forced: true };
  if (base.length > MAX_NAME) {
    return { base: base.slice(0, MAX_NAME - SUFFIX_LENGTH), forced: true };
  }
  return { base, forced: false };
}

/**
 * Every client tool name that can reach the wire, split by what happens to it.
 *
 * Four sources rather than the three Anthropic's sibling gathers. The extra one
 * is this encoder's own: a `toolResult` whose call is missing from history is
 * sent under its **id** in place of a name, so the id has to pass the same
 * grammar the names do — and a client's id is as free-form as its names.
 *
 * `reserved` matters as much as `renamable`. A name that already satisfies the
 * grammar is not renamed, so it reaches the wire under its own spelling and has
 * to claim it: without that, `read file` could derive `read_file` and land on a
 * genuine `read_file` sitting beside it.
 */
function clientToolNames(request: ChatRequest): { renamable: string[]; reserved: string[] } {
  const renamable = new Set<string>();
  const reserved = new Set<string>();
  const add = (name: string): void => {
    (FUNCTION_NAME.test(name) ? reserved : renamable).add(name);
  };

  const called = new Set<string>();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "toolUse") called.add(block.id);
    }
  }

  for (const tool of request.tools ?? []) {
    if (tool.kind === "portable") add(tool.name);
  }
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "toolUse") add(block.name);
      if (block.type === "toolResult" && !called.has(block.toolUseId)) add(block.toolUseId);
    }
  }
  if (request.toolChoice?.type === "tool") add(request.toolChoice.name);
  return { renamable: [...renamable], reserved: [...reserved] };
}

/**
 * Six hex characters of the original name.
 *
 * Derived from the source name rather than from a position in `tools[]`, so a
 * colliding tool's alias survives the client reordering the array — the same
 * property, and the same primitive, as the Anthropic sibling. Twenty-four bits
 * for the reason recorded there: `fromWire` keeps whichever alias was written
 * last, so a collision sends one tool's replies back under another's name.
 */
function suffixFor(name: string): string {
  const digest = Bun.hash.xxHash64(Buffer.from(name, "utf8")) & 0xffffffn;
  return digest.toString(16).padStart(SUFFIX_LENGTH, "0");
}

export function buildToolCloak(request: ChatRequest): ToolCloak | null {
  const { renamable, reserved } = clientToolNames(request);

  // Every name that reaches the wire unrenamed claims its spelling before any
  // alias is handed out, so a candidate deriving one of them collides like any
  // other.
  const claims = new Map<string, number>();
  const claim = (name: string): void => {
    claims.set(name, (claims.get(name) ?? 0) + 1);
  };
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
    // the first: leaving the first bare would make its alias depend on the order
    // the names were walked in.
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
