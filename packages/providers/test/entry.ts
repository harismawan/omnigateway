/**
 * Reads one entry out of a provider-keyed table, naming what was absent.
 *
 * Every such table is keyed by `string` since `ProviderId` widened, so a read
 * by a built-in id answers `| undefined`. A `!` would silence that and turn a
 * missing entry into `TypeError: Cannot read properties of undefined` several
 * assertions later, under a test name describing something else entirely. This
 * fails at the read, and says which table and which id.
 *
 * Its own file rather than `@omni/testkit`, which the tests in other packages
 * use for the same job: testkit depends on `@omni/providers`, so this package
 * cannot depend on testkit without closing a cycle.
 *
 * Use it only where the id is a built-in the assembly is expected to hold.
 * Where absence is the behaviour under test, assert on `undefined` directly.
 */
export function entry<T>(table: Readonly<Record<string, T>>, id: string, name: string): T {
  const found = table[id];
  if (found === undefined) {
    throw new Error(`${name} has no entry for "${id}"; it holds ${Object.keys(table).join(", ")}`);
  }
  return found;
}
