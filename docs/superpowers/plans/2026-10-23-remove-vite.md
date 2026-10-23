# Remove Vite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Remove Vite from dashboard development/preview and dependencies, accepting development reload/state reset as explicitly authorized by the user.

**Architecture:** Reuse the already verified native production/shared build graph. A Bun.serve development server rebuilds on source changes and notifies browsers to reload only after successful builds; preview serves existing dist without watching. Do not build a custom React/TanStack HMR compiler. Keep the framework-owned production transforms until a native equivalent exists.

**Tech Stack:** Bun 1.4.4, TypeScript, Bun.build/Bun.serve, filesystem watch, existing TanStack/Babel transforms.

**Spec:** The user's 2026-10-23 instruction supersedes only the earlier Vite dev/preview and state-preserving-HMR constraints in `docs/superpowers/specs/2026-10-22-bun-builtins-design.md`. All other compatibility/security constraints remain binding.

## Global Constraints

- Work in existing isolated `feat/bun-1-4-4-builtins`; preserve all prior uncommitted migration changes. Do not commit/stage/merge/push.
- Remove Vite runtime/tool dependencies and configs, not TanStack routing or styled-components behavior.
- Development may use full page reload and reset component state. No promise of React Fast Refresh.
- Retain port 5173 for dev, preview default 4173, configurable host/port, API/health forwarding to 127.0.0.1:9000, deep-link SPA fallback and public assets.
- API forwarding preserves paths/query, method/body, request cookies, response Set-Cookie/status, redirects without following them, cancellation and streaming. Do not accidentally serve index.html for gateway failures.
- Preview does not rebuild; production assets gain no development reload code.
- Do not silently add gateway WebSocket or plugin-assets proxy support: old Vite configuration enabled neither.
- Tests must use portable temporary directories, independent servers and allocated ports; no CI dependency on /tmp/opencode.

## Review Focus

- Failed builds must retain the last successful serving artifact and allow recovery on the next edit; no automatic success reload for failed builds.
- Generated route writes must not cause endless rebuild loops; route additions/deletions and nested directories must trigger regeneration.
- Repeated source edits during an in-flight build must serialize/coalesce without losing the final change.
- Proxy redirects/multiple cookies/stream aborts and backend-down errors must not turn into SPA HTML or buffered streams.
- Vite removal must be real in the installed lock graph, including auto-installed optional peer dependencies and framework adapter entrypoints.

### Task 1: Native development and preview server

**Files:** Create `apps/dashboard/tooling/{serve,watch}.ts`, tests `scripts/test/dashboardServe.test.ts` (native Bun, not happy-dom); extend `apps/dashboard/tooling/build.ts` only where required for clean output staging.

**Interfaces:** Export testable server startup accepting dashboard root/output directory, host/port, upstream URL and dev/preview mode; return a closeable server. Keep `buildDashboard(root)` existing callers working. Keep build graph unchanged; permit explicit output directory for staging when needed.

- [x] Write failing tests for preview SPA/static/favicon/CSS/font behavior, missing dist diagnostic, and preview isolation from reload code.
- [x] Write failing tests for API/health forwarding (POST/query/cookie/multiple Set-Cookie/manual redirect/chunked stream/cancellation/upstream-down).
- [x] Add build/watch tests with an injected build operation: initial build, successful rebuild notification, failure retention/recovery, rapid-edit serialization, route add/delete and generated-output ignore rules.
- [x] Run focused tests and observe intended failures before implementation.
- [x] Implement Bun.serve static/proxy handlers and native reload notification; implement serialized source watching with portable filesystem APIs and explicit cleanup. Inject reload code into development responses only, never production files. Publish completed build output rather than clearing live output during a rebuild.
- [x] Run focused tests and existing build/transforms/static/federation tests; expect zero failures.

### Task 2: Remove Vite integration and dependencies

**Files:** `apps/dashboard/package.json`, `bun.lock`, `apps/dashboard/tooling/transforms.ts`, `apps/dashboard/test/transforms.test.ts`, `apps/dashboard/tsconfig.json`, `apps/dashboard/src/vite-env.d.ts` if present, `apps/dashboard/vite.config.ts`, active README/CLAUDE/ARCHITECTURE/audit guidance.

**Interfaces:** `dev` invokes native development command, `preview` invokes static native preview; build/build:production/build:shared/typecheck retain existing semantics. Native public TanStack adapter must not import or install Vite itself.

- [x] Characterize current router-plugin public entrypoints and optional peer resolution. Add tests requiring no installed Vite/plugin-react and working scripts/transforms after removal.
- [x] Run tests RED before dependency/config changes.
- [x] Remove Vite/plugin-react declarations/config/client types and switch scripts. Use a non-Vite public TanStack adapter if the existing /vite facade imports the Vite package; never replace framework compilers with custom implementations or private imports.
- [x] Regenerate lockfile narrowly, inspect all changes and confirm frozen install leaves it byte-identical. Verify fresh/pruned installs do not pull Vite through optional peers.
- [x] Update docs to describe full-reload development explicitly and supersede the old retained-Vite decision without rewriting historical probe evidence.
- [x] Run focused tests/build/types/lint/claims/dead checks; expect zero failures.

### Task 3: Browser and integration verification

**Files:** Test evidence and this plan; no unrelated product changes.

- [x] Chrome smoke real dev server login/deep routes/assets, edit-update/reload, route add/delete, syntax error then recovery, no runtime/import errors after recovery; use scratch copies instead of overwriting application source.
- [x] Preview smoke built dashboard and shared plugin React/context identity; verify preview does not watch/rebuild.
- [x] Run full service-enabled core/dashboard suites, root types/lint/claims/dead, frozen install, dashboard/npm/binary/Docker builds and browser smoke. Record exact counts and any skips.
- [x] Fresh whole-diff review; fix Important/Critical issues with reproductions and repeat affected verification. Keep branch/worktree uncommitted for the user.
