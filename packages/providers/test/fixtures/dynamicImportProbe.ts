/**
 * A module that does the thing a leaf must never do, so the probe for it has a
 * positive control.
 *
 * `leafSubpaths.test.ts` asserts the leaf bundles contain no `import(`. Nothing
 * in `packages/providers` legitimately contains one, so that assertion would
 * pass identically against a probe that never fires — the exact failure mode
 * that file's own comments warn about, and that three earlier versions of it
 * shipped with.
 *
 * The specifier is interpolated on purpose: that is the form the import walk
 * cannot resolve and the bundler declines to follow, which is why the bundle
 * probe is the only instrument that sees it.
 */
const id = "anthropic";

export const load = (): Promise<unknown> => import(`../../src/${id}/index.ts`);
