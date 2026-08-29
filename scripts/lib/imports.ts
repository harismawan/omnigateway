/**
 * Walking a directory for imports a boundary rule forbids.
 *
 * Two packages need this and neither can hold it for the other. `packages/router`
 * must not reach `@omni/providers`' package root, and `apps/dashboard/src` must
 * not reach `@omni/providers` at all — the same instrument, one rule apart. It
 * cannot live in `packages/testkit`, which imports `@omni/router` and would make
 * the router's own test a cycle, and it cannot be a package the console imports
 * without widening rule 12's allowlist to admit it. So it sits here, with no
 * dependencies, imported by relative path from both tests the way
 * `apps/gateway/test/routes/providerIdMirror.test.ts` already reaches across.
 *
 * Written once rather than twice on purpose: this review round found four
 * defects that were each a repair applied to one of a pair.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ForbiddenImport = {
  /** Matched against the bare specifier. */
  pattern: RegExp;
  /** Printed on a violation; says what the rule protects, not that it exists. */
  why: string;
  /**
   * Whether a **type-only** import also breaks this rule.
   *
   * Default false, because for most rules it does not and saying otherwise
   * would forbid an arrangement the repository documents. The router's edge
   * into `@omni/store` is the worked example: every package-root import there is
   * `import type`, erased at build, which is exactly why rule 3 tolerates it —
   * only `@omni/store/types` may be imported for values.
   *
   * Set it where the *type system* is the thing being protected.
   * `@omni/providers` is that case: `import type { … }` of a descriptor, or of
   * `keyof typeof PROVIDER_DESCRIPTORS`, puts a build-time-closed provider set
   * back into a consumer that must not have one, and it does so with no runtime
   * bytes to give it away.
   */
  alsoTypeOnly?: boolean;
};

/** Every `.ts`/`.tsx` under `dir`, recursively. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Bare specifiers `file` imports, **including type-only ones**.
 *
 * Two passes, and the second is the one that was missing. `Bun.Transpiler`
 * erases type-only imports before reporting them — measured:
 * `import type { A } from "@omni/providers/catalog"` and
 * `export type { B } from "@omni/providers/descriptors"` both come back as `[]`.
 * So the console's guard, whose docstring said it "names exactly what rule 12
 * forbids", enforced that rule only at runtime.
 *
 * That gap is not academic. A type-only import of a descriptor type, or of
 * `keyof typeof PROVIDER_DESCRIPTORS`, puts a build-time-closed provider set
 * back into the console's type system — which is the thing the sub-project
 * removed, arriving with no runtime bytes to give it away.
 *
 * The second pass is a regex over `from "…"`, which the parser's own docstring
 * rightly rejects for *general* import parsing. It is sound for this narrower
 * question: a specifier appearing anywhere in the file, including inside a
 * comment or a string, is at worst a false positive — a loud failure someone
 * reads — and never a silent pass. Union, not replacement, so the parser still
 * covers `require` and dynamic `import()` forms the regex would miss.
 */
export function bareImportsOf(file: string): { value: string[]; any: string[] } {
  const source = readFileSync(file, "utf8");
  const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
  const bare = (paths: string[]): string[] => [
    ...new Set(paths.filter((path) => path !== "" && !path.startsWith("."))),
  ];
  const value = bare(transpiler.scanImports(source).map((record) => record.path));
  const textual = [...source.matchAll(/from\s*["']([^"']+)["']/g)].map(([, path]) => path ?? "");
  return { value, any: bare([...value, ...textual]) };
}

/**
 * `dir`'s violations of `rules`, as printable lines.
 *
 * Returns rather than asserts, so a caller can also assert the walk found
 * something: "no violations" is what an empty directory reports too.
 */
export function forbiddenImportsIn(
  dir: string,
  rules: readonly ForbiddenImport[],
): { files: string[]; violations: string[] } {
  const files = sourceFiles(dir);
  const violations: string[] = [];
  for (const file of files) {
    const { value, any } = bareImportsOf(file);
    for (const rule of rules) {
      const seen = (rule.alsoTypeOnly === true ? any : value).filter((path) =>
        rule.pattern.test(path),
      );
      for (const specifier of seen) {
        violations.push(`${file.slice(dir.length + 1)} imports ${specifier} — ${rule.why}`);
      }
    }
  }
  return { files, violations };
}
