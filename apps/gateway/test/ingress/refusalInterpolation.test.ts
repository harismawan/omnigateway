import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every value a refusal interpolates, checked at the source rather than by
 * remembering.
 *
 * `reasonField` prints an error's message to stdout whenever the error names no
 * provider, which every refusal built before a provider is chosen does. So each
 * `${…}` inside a `GatewayError` or `fail()` template is a decision about the
 * redaction boundary, and the question is only whether the value is this
 * repository's own or the client's.
 *
 * This is a source-level check because three rounds of case-by-case review each
 * found sites the last one missed, and a fourth found that the parameterised
 * sweep written to end that pattern did not notice a new interpolation at all —
 * it was a hand-written table of request bodies wearing an instrument's clothes.
 * A table lists what someone thought of. This fails on anything unrecognised,
 * which is the property the thing it guards actually needs.
 *
 * Adding an entry to `GATEWAY_OWNED` is the escape hatch, and it is meant to be
 * used — with a value this repository owns, and a reason.
 */

/**
 * Expressions whose value cannot be client text.
 *
 * Each is either a literal this repository wrote, a bounded identifier it
 * minted, or a value already passed through `safeToken`. Loop counters and
 * field paths composed only of schema keys are structure, not content.
 */
const GATEWAY_OWNED = new Set([
  // Structure, not content: a field path built from schema keys, a loop
  // position, or a suffix composed of them. Where a *client* key enters a path
  // it is bounded at the site, which is the half a bound on the message alone
  // does nothing about.
  "path",
  "field",
  "i",
  "index",
  "suffix",
  // The composed argument to `fail`, whose two halves are each checked here on
  // their own line.
  "message",
  // Closed sets this repository defines: a spec's own required field names, a
  // tool's fixed name, a message role from an enum, a byte cap, and the two
  // client labels `/api/agent-setup` accepts.
  "required",
  "spec.name",
  "type",
  "role",
  "m.role",
  "cap",
  "client",
  // Composed inside `schemas.ts`, where the one client-supplied part — a data
  // URL's declared media type — is bounded at source.
  "detail",
  "result.detail",
  // A provider id from stored configuration, not from a request. Operator text
  // at worst, and `sqlite/config.ts` reads targets back with a bare
  // `JSON.parse`, so it is unvalidated — but it is not the client's.
  "candidate.target.provider",
  // Vocabulary from a closed union.
  "reason",
  // A loop position.
  "j",
  // This repository's own pattern, printed so a client learns the rule it
  // broke without being quoted its own value back.
  "TOOL_NAME.source",
  // A restore failure's own text, on an admin route a client cannot reach.
  "error.message",
  // Not a filename: a `DatabaseDeps` object caught by the bare-argument arm and
  // never interpolated into anything. Kept because the arm reports it, and
  // named accurately because an unverifiable justification is worth less than
  // no entry at all.
  "database",
  // The upstream's own words on the in-stream error path. Not bounded — it is
  // *withheld*, because that throw stamps the provider and `reasonField` prints
  // no message for an error that names one, exactly as `httpError` does on the
  // non-streaming path. The stamp is what makes this entry true, and
  // `dispatch.test.ts` pins it: removing the stamp fails there, not here.
  "event.message",
  // Already bounded, by the two functions that exist to do it.
  "safeToken",
  "zodDetail",
]);

const ROOTS = [
  "apps/gateway/src/ingress",
  "apps/gateway/src/routes",
  "apps/gateway/src/dispatch",
  "packages/router/src",
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * The text of a refusal call, from its opening paren to its balanced close.
 *
 * Balanced rather than a fixed window: the first shape of this check read 600
 * characters and a message beginning past that was invisible, which is a hole
 * you close by counting parens rather than by choosing a bigger number.
 */
function callRegion(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from);
}

/**
 * Names that build a refusal in this file: the constructor, `fail`, and any
 * local helper that throws one.
 *
 * Discovered rather than listed, because a helper wrapping `new GatewayError`
 * is the natural way to write a multi-branch message and the check was blind to
 * exactly that — it knew `fail` by name and nothing else.
 */
function refusalCallers(source: string): RegExp {
  const names = new Set(["fail"]);
  for (const declaration of source.matchAll(
    /function\s+(\w+)\s*\([^)]*\)[^{]*\{[\s\S]{0,400}?throw new GatewayError/g,
  )) {
    if (declaration[1] !== undefined) names.add(declaration[1]);
  }
  return new RegExp(`(?:new GatewayError\\(|\\b(?:${[...names].join("|")})\\()`, "g");
}

/** Every interpolation, and every non-literal message, a refusal can carry. */
function interpolations(source: string): { expression: string; line: number }[] {
  const found: { expression: string; line: number }[] = [];
  for (const match of source.matchAll(refusalCallers(source))) {
    const start = match.index + match[0].length - 1;
    const region = callRegion(source, start);
    const line = source.slice(0, start).split("\n").length;

    for (const template of region.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
      for (const expr of template[0].matchAll(/\$\{([^{}]*)\}/g)) {
        found.push({ expression: (expr[1] ?? "").trim(), line });
      }
    }

    // A message built by concatenation carries the same values a template
    // would, and the template scan above cannot see it.
    for (const concat of region.matchAll(/"[^"]*"\s*\+\s*([A-Za-z_$][\w.$]*)/g)) {
      found.push({ expression: (concat[1] ?? "").trim(), line });
    }

    // A message assembled elsewhere and passed as an identifier. The value is
    // opaque here, so it is reported rather than assumed safe.
    for (const arg of region.matchAll(/,\s*([A-Za-z_$][\w.$]*)\s*[,)]/g)) {
      const name = (arg[1] ?? "").trim();
      if (!/^(?:undefined|true|false)$/.test(name)) found.push({ expression: name, line });
    }
  }
  return found;
}

test("every value a refusal interpolates is this gateway's own or bounded", () => {
  const unowned: string[] = [];

  for (const root of ROOTS) {
    for (const file of sources(root)) {
      const source = readFileSync(file, "utf8");
      for (const { expression, line } of interpolations(source)) {
        // Exact name, or a bare call to one of the two functions that bound a
        // value. A substring match let `${safeToken("a") + " " + key}` through:
        // one interpolation can both call the bounding function and concatenate
        // the raw value beside it, and `includes` cannot tell those apart.
        const owned =
          GATEWAY_OWNED.has(expression) ||
          /^(?:safeToken|zodDetail|issuePath)\([^+]*\)$/.test(expression);
        if (!owned) unowned.push(`${file}:${line}  \${${expression}}`);
      }
    }
  }

  expect(unowned).toEqual([]);
});

/**
 * Every parser bounds the model name, discovered rather than listed.
 *
 * `requested_model` and `resolved_model` are columns and `ON CONFLICT` keys of
 * `usage_rollup` and `usage_daily`, so an unbounded model persists whatever the
 * client sent — on a *succeeding* request, past `bodyLoggingOptOut`, into the
 * snapshot this repository documents as never a prompt corpus.
 *
 * This exists because two of the three parsers were bounded and the third was
 * not: it was on another branch when the bound was written, and arrived with a
 * rebase. Enumerating the parsers would have had the same hole, so this asks the
 * directory instead. A fourth parser fails here on the day it is written.
 *
 * The refusal-interpolation check above cannot catch this: it reads what a
 * message says, and this is about what a column stores.
 */
test("every ingress parser bounds the model name it will store", () => {
  const unbounded: string[] = [];

  for (const file of sources("apps/gateway/src/ingress")) {
    const source = readFileSync(file, "utf8");
    // A parser is a file that turns a body into a ChatRequest.
    if (!/export function parse\w+Request/.test(source)) continue;

    // The *request* schema, not every schema with a model in it: the one that
    // also names the field carrying the conversation is the one whose `model`
    // becomes `requestedModel`. `anthropic.ts` has a second, `fallbackModel`,
    // which describes the `from`/`to` of a model-change block and rides the
    // vendor bag rather than a column.
    for (const declaration of source.matchAll(/\bmodel:\s*z\.string\(\)([^,\n]*)/g)) {
      const after = source.slice(declaration.index, declaration.index + 1200);
      const isRequestSchema = /\n\s{2}(?:messages|input):/.test(after);
      if (!isRequestSchema) continue;
      if (!(declaration[1] ?? "").includes("max(MODEL_NAME_MAX)")) {
        unbounded.push(`${file}  model: z.string()${declaration[1] ?? ""}`);
      }
    }
  }

  expect(unbounded).toEqual([]);
});
