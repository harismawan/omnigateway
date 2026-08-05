# Task 3 report

## Files

- Added `apps/dashboard/src/api/queries.ts`: central TanStack Query keys and options, plus `useInvalidate`.
- Added `apps/dashboard/src/lib/format.ts`: token, USD, duration, relative-time, and expiry formatters.
- Added `apps/dashboard/test/helpers/render.tsx`: retry-free QueryClient and React Query render wrappers.
- Added `apps/dashboard/test/helpers/fixtures.ts`: typed dashboard wire-data fixtures.
- Added `apps/dashboard/test/api/queries.test.tsx`: stable keys, envelope unwrapping, query encoding, polling, and formatter coverage.

## TDD

- RED: `bun test apps/dashboard/test/api/queries.test.tsx` failed as expected because `../../src/api/queries.ts` did not exist.
- GREEN: focused suite passes with 5 tests and 21 assertions; all dashboard tests pass with 15 tests and 44 assertions.

## Verification

- `bunx biome check` on all Task 3 files passes.
- `git diff --check` passes.
- Dashboard build/typecheck is blocked by the pre-existing store SQL declaration error:
  `../../packages/store/src/sqlite/db.ts(2,21): error TS2307: Cannot find module './migrations/001_init.sql' or its corresponding type declarations.`
- Root `bun run typecheck` additionally does not load dashboard JSX/path configuration, producing pre-existing dashboard JSX and `@/` resolution errors.
- Root `bun run lint` is blocked by the pre-existing generated file error:
  `apps/dashboard/src/routeTree.gen.ts:18:6 lint/suspicious/noExplicitAny`.

## Self-review

- Query keys include all dynamic arguments; usage query parameters are encoded with `URLSearchParams`.
- Data-envelope query functions return their consumer-facing arrays/settings value.
- Query test clients disable retries; no production fetch behavior was added or changed.
- All fixture fields follow the Task 2 wire types and use synthetic values.

## Concerns

- The known `@omni/store` SQL declaration issue prevents dashboard build/typecheck. It was not changed because it is outside Task 3 scope.
