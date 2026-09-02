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
  // Vocabulary from closed unions.
  "reason",
  "code",
  "kind",
  "dimension",
  "window",
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

/** Every `${…}` inside a template literal that is an argument to a refusal. */
function interpolations(source: string): { expression: string; line: number }[] {
  const found: { expression: string; line: number }[] = [];
  // Templates belonging to a refusal: the call spans lines, so the scan starts
  // at the call and takes every backtick string until its closing paren.
  const calls = /(?:new GatewayError\(|\bfail\()/g;
  for (const match of source.matchAll(calls)) {
    const start = match.index;
    const region = source.slice(start, start + 600);
    const end = region.indexOf(");");
    const body = region.slice(0, end === -1 ? region.length : end);
    for (const template of body.matchAll(/`[^`]*`/g)) {
      for (const expr of template[0].matchAll(/\$\{([^}]*)\}/g)) {
        found.push({
          expression: (expr[1] ?? "").trim(),
          line: source.slice(0, start).split("\n").length,
        });
      }
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
        const owned = [...GATEWAY_OWNED].some(
          (safe) => expression === safe || expression.includes(`${safe}(`),
        );
        if (!owned) unowned.push(`${file}:${line}  \${${expression}}`);
      }
    }
  }

  expect(unowned).toEqual([]);
});
