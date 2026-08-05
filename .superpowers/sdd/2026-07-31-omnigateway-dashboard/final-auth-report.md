# Final auth integration report

## Status

DONE

## Design

- Login and first-run setup now replace the cached status with `{ configured: true, authenticated: true }` before navigating into the guarded application shell, preventing the production five-second stale cache from bouncing a successful authentication back to `/login`.
- `createDashboardQueryClient` centralizes `ApiError` 401 handling for both query and mutation caches. It clears session-derived cache data and invokes an injected unauthenticated callback.
- The bootstrap injects router location and navigation callbacks after declaring the router binding, avoiding imports of the generated route tree in tests and avoiding a QueryClient/router construction cycle.
- A single in-flight handler suppresses duplicate redirects from concurrent polling failures. Errors on `/login` remain visible and do not clear the public status cache or trigger a redirect loop.

## TDD and tests

- Added actual-router guard tests for successful login and setup with a fresh unauthenticated status cache and production-like `staleTime`; both finish on `/credentials` without another status request.
- Added centralized query-401, mutation-401, concurrent-401 deduplication, and login-route no-op tests with synthetic `ApiError` values and fetch stubs only.
- Dashboard tests: 113 passed, 0 failed.
- Root tests: 466 passed, 0 failed.
- Root typecheck passed.
- Dashboard production build passed.
- Biome passed on all changed source and test files.

## Concerns

- Repository-wide `bun run lint` remains non-zero because Biome reports the pre-existing `postman/OmniGateway.postman_collection.json` formatting error. The changed files are clean under direct Biome checks.
- Dashboard route generation emits the existing Node circular-dependency warning from the router tooling during typecheck; typecheck still exits successfully.
