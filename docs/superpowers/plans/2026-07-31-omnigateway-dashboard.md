# OmniGateway Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React admin UI for OmniGateway — five screens (Credentials, Models, Usage, Logs, Keys) over the gateway's `/api/*` control surface, plus first-run setup and session login.

**Architecture:** A Vite-built React 19 SPA at `apps/dashboard/`. TanStack Router does file-based routing with an authenticated layout route that redirects to `/login` when the session cookie is absent. TanStack Query owns every byte of server state: one typed fetch client wraps `/api/*`, and each screen composes `queryOptions` factories from it. The only client state is form drafts held in `useState` inside the component that owns the form. Tests run under `bun test` with happy-dom and React Testing Library; the fetch layer is stubbed at `globalThis.fetch` so no test touches a live gateway.

**Tech Stack:** React 19.2, Vite 8, TanStack Router 1.170 (file-based), TanStack Query 5.101, Tailwind 4 + shadcn/ui, TypeScript strict, `bun test` + `@testing-library/react` + `@happy-dom/global-registrator`.

**Spec:** `docs/superpowers/specs/2026-07-31-omnigateway-design.md`

**Gateway plan (already written, not modified here):** `docs/superpowers/plans/2026-07-31-omnigateway-core.md`

---

## Global Constraints

- **Runtime and package manager:** Bun 1.4.0 or later. `bun` installs, `bun test` runs tests. The dashboard is a workspace member under the existing root `package.json` `workspaces: ["packages/*", "apps/*"]`.
- **Dependency floors:** `react@19.2.8`, `react-dom@19.2.8`, `vite@8.2.0`, `@vitejs/plugin-react@6.0.5`, `@tanstack/react-router@1.170.18`, `@tanstack/router-plugin@1.168.23`, `@tanstack/react-query@5.101.4`, `tailwindcss@4.3.3`, `@tailwindcss/vite@4.3.3`, `@testing-library/react@16.3.2`, `@testing-library/user-event@14.6.1`, `@happy-dom/global-registrator@20.11.1`, `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, `recharts@3.10.1`.
- **TypeScript:** `strict: true`. **No `any` in committed code**, including tests — use `unknown` and narrow, or a named type. `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on, inherited from `tsconfig.base.json`.
- **Control API prefix is `/api/*`, never `/admin/*`.** The core plan deliberately moved the control surface off `/admin` so the dashboard bundle can own `/`. Every request this app makes goes to `/api/...`.
- **There is no `packages/shared`.** Contract types are imported from `@omni/store` (a workspace dependency) where the shape is identical to the stored row, and declared locally in `src/api/types.ts` where the wire shape diverges — for example `Credential` on the wire has no `secrets()` thunk, and `POST /api/keys` returns a one-time `key` field that exists in no stored type.
- **There is no WebSocket.** `WS /admin/stream` from the spec does not exist. The Logs screen polls `GET /api/logs?limit=` on an interval via TanStack Query `refetchInterval`. Nothing in this plan opens a socket.
- **Auth is a session cookie, not a gateway API key.** `POST /api/login` sets an `HttpOnly; SameSite=Strict` cookie named `omni_admin`. The browser sends it automatically, so **every** `fetch` in this app passes `credentials: "same-origin"` and never sets an `Authorization` header. A `401` response means the session lapsed and the app must land on `/login`.
- **Server state lives only in TanStack Query.** No Redux, no Zustand, no React Context holding fetched data. Client state is limited to form drafts and transient UI toggles.
- **Tests:** `bun test apps/dashboard`. Every test stubs `globalThis.fetch`; no test performs real network I/O. Query clients in tests are constructed with `retry: false` so a deliberate failure does not stall the test for the retry backoff.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`), scoped `dashboard`. One commit per task minimum, at the step marked Commit.
- **Secrets:** No token, credential value, or raw API key is ever written to a test fixture or a console line. Fixtures use synthetic values of the form `test-key-<n>`.

---

## Deviations from the spec, and why

Three carried forward from the core plan, one new to this plan. Each is a decision, not an oversight.

1. **`/api/*` instead of `/admin/*`** — inherited from the core plan. Non-negotiable: the routes the gateway actually serves are the ones listed above.
2. **No `packages/shared`** — inherited. This plan imports from `@omni/store` and declares wire-only types in `src/api/types.ts` (Task 2).
3. **Logs poll instead of streaming over a WebSocket** — inherited. `refetchInterval: 3000` on the logs query, pausable from the UI.
4. **The dry-run panel requires a control route the core plan does not have.** Resolved in **Task 8** by specifying `POST /api/models/:id/dry-run` as a gateway addition. See that task's preamble for the full rationale and the exact server-side contract the gateway must implement.

---

## File Structure

```
apps/dashboard/
  package.json
  vite.config.ts
  tsconfig.json
  index.html
  components.json                       shadcn/ui config
  bunfig.toml                           bun test preload (repo root; see Task 1)
  src/
    main.tsx                            React root, router + query client wiring
    index.css                           tailwind entry + shadcn theme tokens
    routeTree.gen.ts                    generated by @tanstack/router-plugin
    lib/
      utils.ts                          cn() — shadcn's class merger
      format.ts                         number, money, duration, relative-time formatting
    api/
      types.ts                          wire types: re-exports from @omni/store + local shapes
      client.ts                         typed fetch wrapper over /api/*, ApiError
      queries.ts                        queryOptions factories + mutation helpers
    components/
      ui/                               shadcn primitives (button, input, card, ...)
      AppShell.tsx                      sidebar nav + outlet
      Health.tsx                        breaker/health pill
      QuotaBar.tsx                      one quota window as a labelled bar
      ErrorState.tsx                    render an ApiError with a retry action
    routes/
      __root.tsx                        document shell, devtools, error boundary
      login.tsx                         /login — setup-or-login, chosen by /api/status
      _app.tsx                          authenticated layout; beforeLoad guard + AppShell
      _app.index.tsx                    / — redirects to /credentials
      _app.credentials.tsx              Credentials screen
      _app.models.tsx                   Models screen (editor + dry-run panel)
      _app.usage.tsx                    Usage screen
      _app.logs.tsx                     Logs screen (polling tail)
      _app.keys.tsx                     Keys screen
    features/
      credentials/
        CredentialCard.tsx              one account row: health, expiry, quota, inline edit
        ProviderGroup.tsx               accounts grouped under a provider header
        ConnectDialog.tsx               OAuth flow UI: redirect / paste / device-code
      models/
        ModelEditor.tsx                 targets, strategy, drag reorder
        TargetRow.tsx                   one target: tier, weight, cost, capabilities
        DryRunPanel.tsx                 ranked candidates + score breakdown + exclusions
      usage/
        UsageChart.tsx                  recharts series over time
        UsageTable.tsx                  grouped totals
      logs/
        LogRow.tsx                      one request, expandable to its attempt trace
      keys/
        KeyTable.tsx                    list + revoke
        MintKeyDialog.tsx               create, then show the raw key exactly once
  test/
    setup/
      happydom.ts                       GlobalRegistrator.register()
      cleanup.ts                        afterEach(cleanup)
    helpers/
      fetchStub.ts                      route-table fetch stub + call recorder
      render.tsx                        renderWithProviders — QueryClient + memory router
      fixtures.ts                       credential(), model(), logRow(), key(), bucket()
    api/client.test.ts
    routes/login.test.tsx
    routes/guard.test.tsx
    features/credentials.test.tsx
    features/connect.test.tsx
    features/models.test.tsx
    features/dryrun.test.tsx
    features/usage.test.tsx
    features/logs.test.tsx
    features/keys.test.tsx
```

Files split by screen rather than by layer, because a change to the Credentials screen touches its card, its group header, and its connect dialog together and touches nothing else.

---

## Task 1: Workspace scaffold — Vite, Tailwind, shadcn, and a passing test run

**Files:**
- Create: `apps/dashboard/package.json`, `apps/dashboard/vite.config.ts`, `apps/dashboard/tsconfig.json`, `apps/dashboard/index.html`, `apps/dashboard/components.json`, `apps/dashboard/src/main.tsx`, `apps/dashboard/src/index.css`, `apps/dashboard/src/lib/utils.ts`, `apps/dashboard/src/routes/__root.tsx`, `apps/dashboard/src/routes/index.tsx`, `apps/dashboard/test/setup/happydom.ts`, `apps/dashboard/test/setup/cleanup.ts`, `apps/dashboard/test/smoke.test.tsx`
- Modify: `bunfig.toml` at the repository root (create if the gateway plan has not)

**Interfaces:**
- Consumes: nothing. This is the first dashboard task.
- Produces: a buildable Vite app; `cn(...inputs: ClassValue[]): string` from `src/lib/utils.ts`; a `bun test` environment where `document` exists and React components render.

The router plugin **must** be listed before `react()` in the Vite plugin array — it generates `routeTree.gen.ts` from `src/routes/`, and the React plugin has to see the generated file.

`GlobalRegistrator.register()` must live in a file that imports nothing else. JavaScript hoists imports above statements, so a preload file that also imports `@testing-library/react` would evaluate Testing Library before `document` exists.

- [ ] **Step 1: Write the package manifest**

`apps/dashboard/package.json`:

```json
{
  "name": "@omni/dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@omni/store": "workspace:*",
    "@tanstack/react-query": "^5.101.4",
    "@tanstack/react-router": "^1.170.18",
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/sortable": "^10.0.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.28.0",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "recharts": "^3.10.1",
    "tailwind-merge": "^3.6.0"
  },
  "devDependencies": {
    "@happy-dom/global-registrator": "^20.11.1",
    "@tailwindcss/vite": "^4.3.3",
    "@tanstack/react-query-devtools": "^5.101.4",
    "@tanstack/router-plugin": "^1.168.23",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.0.5",
    "tailwindcss": "^4.3.3",
    "vite": "^8.2.0"
  }
}
```

- [ ] **Step 2: Write the Vite config**

`apps/dashboard/vite.config.ts`:

```ts
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // Must precede react(): it writes routeTree.gen.ts, which react() then compiles.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // The gateway serves this directory as static files in production.
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-only. In production the gateway serves the bundle from the same
      // origin, so these paths resolve without a proxy.
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/oauth": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
});
```

- [ ] **Step 3: Write the TypeScript config**

`apps/dashboard/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["bun-types"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Write the HTML entry, the CSS entry, and the class merger**

`apps/dashboard/index.html`:

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OmniGateway</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/dashboard/src/index.css`:

```css
@import "tailwindcss";

@theme {
  --color-ok: oklch(0.72 0.15 150);
  --color-warn: oklch(0.78 0.15 85);
  --color-bad: oklch(0.63 0.2 25);
}
```

`apps/dashboard/src/lib/utils.ts`:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class merger: conditional classes, with later Tailwind utilities winning. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 5: Write the shadcn config and install the primitives**

`apps/dashboard/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

Run, from `apps/dashboard`:

```bash
bun install
bunx shadcn@latest add button input label card badge dialog table select switch tabs progress separator
```

Expected: files appear under `src/components/ui/`, and `src/index.css` gains the shadcn theme variable block above the `@theme` block already there.

- [ ] **Step 6: Write the root route and the index route**

`apps/dashboard/src/routes/__root.tsx`:

```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => <Outlet />,
});
```

`apps/dashboard/src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <p>OmniGateway</p>,
});
```

- [ ] **Step 7: Write the React entry point**

`apps/dashboard/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { routeTree } from "./routeTree.gen.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A control panel on localhost: stale data is cheap to refetch and
      // confusing to look at, so keep windows short.
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("#root is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 8: Write the test environment preload files**

`apps/dashboard/test/setup/happydom.ts` — imports nothing but the registrator, so `document` exists before any other module is evaluated:

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
```

`apps/dashboard/test/setup/cleanup.ts`:

```ts
import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
```

`bunfig.toml` at the repository root:

```toml
[test]
preload = ["./apps/dashboard/test/setup/happydom.ts", "./apps/dashboard/test/setup/cleanup.ts"]
```

- [ ] **Step 9: Write the failing smoke test**

`apps/dashboard/test/smoke.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { cn } from "../src/lib/utils.ts";

test("cn merges conditional classes and lets the later utility win", () => {
  expect(cn("p-2", false && "hidden", "p-4")).toBe("p-4");
});

test("the dom environment renders a react component", () => {
  render(<p>OmniGateway</p>);
  expect(screen.getByText("OmniGateway")).toBeDefined();
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `bun test apps/dashboard/test/smoke.test.tsx`
Expected: FAIL — cannot resolve `../src/lib/utils.ts` if Step 4 was skipped, or `document is not defined` if the preload is misconfigured. If Steps 1–8 were completed in order it passes; run it anyway to confirm the environment, because a preload that silently does not load produces exactly this failure later, in a harder-to-read place.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `bun test apps/dashboard`
Expected: 2 pass, 0 fail.

- [ ] **Step 12: Verify the production build**

Run: `cd apps/dashboard && bun run build`
Expected: `tsc --noEmit` reports no errors, and `dist/index.html` plus a hashed JS bundle are written.

- [ ] **Step 13: Commit**

```bash
git add apps/dashboard bunfig.toml
git commit -m "feat(dashboard): scaffold vite, tailwind, shadcn and the bun test environment"
```

---

## Task 2: The typed `/api/*` client and its wire types

**Files:**
- Create: `apps/dashboard/src/api/types.ts`, `apps/dashboard/src/api/client.ts`
- Test: `apps/dashboard/test/api/client.test.ts`, `apps/dashboard/test/helpers/fetchStub.ts`

**Interfaces:**
- Consumes: `Credential`, `CredentialHealth`, `QuotaWindow`, `VirtualModel`, `Target`, `Settings`, `ScoringWeights`, `ApiKey`, `RequestLog`, `UsageBucket`, `Strategy`, `BreakerState`, `WindowType`, `ProviderId` — all from `@omni/store` (gateway plan Task 5).
- Produces:
  - `ApiError` (class) with `status: number`, `code: string`, `message: string`
  - `api` — an object with `get`, `post`, `put`, `patch`, `del` methods, each `<T>(path: string, body?: unknown) => Promise<T>`
  - Wire types: `WireCredential`, `CredentialsResponse`, `ModelsResponse`, `SettingsResponse`, `KeysResponse`, `MintedKey`, `UsageResponse`, `LogsResponse`, `StatusResponse`, `ConnectStart`, `ConnectFinish`, `ConnectPoll`
  - `createFetchStub(routes)` test helper
- Every later task consumes `api` and these types.

`@omni/store`'s `CredentialView` carries a `secrets()` thunk that exists only server-side; the wire shape is plain `Credential` minus nothing, because `GET /api/credentials` projects exactly the `Credential` fields. `WireCredential` is therefore an alias, declared explicitly so a future divergence has one place to live.

- [ ] **Step 1: Write the failing test**

`apps/dashboard/test/api/client.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { api, ApiError } from "../../src/api/client.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("get resolves the parsed json body", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
  expect(await api.get<{ configured: boolean }>("/api/status")).toEqual({
    configured: true,
    authenticated: false,
  });
});

test("every request carries the session cookie and no authorization header", async () => {
  const stub = createFetchStub({ "GET /api/credentials": () => ({ credentials: [] }) });
  await api.get("/api/credentials");
  const init = stub.calls[0]?.init;
  expect(init?.credentials).toBe("same-origin");
  expect(new Headers(init?.headers).get("authorization")).toBeNull();
});

test("post sends json and sets the content type", async () => {
  const stub = createFetchStub({ "POST /api/login": () => ({ ok: true }) });
  await api.post("/api/login", { password: "hunter2hunter2" });
  const init = stub.calls[0]?.init;
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  expect(init?.body).toBe(JSON.stringify({ password: "hunter2hunter2" }));
});

test("an error body becomes an ApiError carrying the gateway code", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      status: 401,
      body: { error: { code: "AUTH", message: "admin session required" } },
    }),
  });
  const error = (await api.get("/api/credentials").catch((e: unknown) => e)) as ApiError;
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(401);
  expect(error.code).toBe("AUTH");
  expect(error.message).toBe("admin session required");
});

test("a non-json error body still produces an ApiError rather than a parse crash", async () => {
  createFetchStub({ "GET /api/logs": () => ({ status: 502, text: "<html>bad gateway</html>" }) });
  const error = (await api.get("/api/logs").catch((e: unknown) => e)) as ApiError;
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(502);
  expect(error.code).toBe("INTERNAL");
});

test("a 204 resolves to null rather than failing to parse an empty body", async () => {
  createFetchStub({ "DELETE /api/keys/k1": () => ({ status: 204 }) });
  expect(await api.del("/api/keys/k1")).toBeNull();
});

test("patch and put reach the right method and path", async () => {
  const stub = createFetchStub({
    "PATCH /api/credentials/c1": () => ({ ok: true }),
    "PUT /api/models/fast": () => ({ ok: true }),
  });
  await api.patch("/api/credentials/c1", { tier: 2 });
  await api.put("/api/models/fast", { id: "fast" });
  expect(stub.calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
    "PATCH /api/credentials/c1",
    "PUT /api/models/fast",
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/dashboard/test/api/client.test.ts`
Expected: FAIL — cannot resolve `../../src/api/client.ts`.

- [ ] **Step 3: Write the fetch stub helper**

`apps/dashboard/test/helpers/fetchStub.ts`:

```ts
/**
 * Replaces `globalThis.fetch` with a route table.
 *
 * A handler returns either the JSON body directly, or a `StubResponse` when the
 * test needs a specific status. Nothing here touches the network, so a test
 * that forgets a route gets a loud 501 rather than a hanging socket.
 */
export type StubResponse = { status?: number; body?: unknown; text?: string };

export type StubHandler = (input: { url: string; init: RequestInit | undefined }) =>
  | StubResponse
  | Record<string, unknown>
  | Array<unknown>;

export type FetchStub = {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  /** Replace or add a route after the stub is installed. */
  set(route: string, handler: StubHandler): void;
};

function isStubResponse(value: unknown): value is StubResponse {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 && keys.every((k) => k === "status" || k === "body" || k === "text")
  );
}

export function createFetchStub(routes: Record<string, StubHandler>): FetchStub {
  const table = new Map(Object.entries(routes));
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = raw.startsWith("http") ? new URL(raw).pathname + new URL(raw).search : raw;
    calls.push({ url, init });

    const method = (init?.method ?? "GET").toUpperCase();
    const handler = table.get(`${method} ${url}`);
    if (handler === undefined) {
      return new Response(
        JSON.stringify({ error: { code: "INTERNAL", message: `no stub for ${method} ${url}` } }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    }

    const result = handler({ url, init });
    if (isStubResponse(result)) {
      const status = result.status ?? 200;
      if (status === 204) return new Response(null, { status });
      if (typeof result.text === "string") {
        return new Response(result.text, { status, headers: { "content-type": "text/html" } });
      }
      return new Response(JSON.stringify(result.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return {
    calls,
    set(route, handler) {
      table.set(route, handler);
    },
  };
}
```

- [ ] **Step 4: Write the wire types**

`apps/dashboard/src/api/types.ts`:

```ts
import type {
  ApiKey,
  BreakerState,
  Credential,
  CredentialHealth,
  ProviderId,
  QuotaWindow,
  RequestLog,
  ScoringWeights,
  Settings,
  Strategy,
  Target,
  UsageBucket,
  VirtualModel,
  WindowType,
} from "@omni/store";

export type {
  ApiKey,
  BreakerState,
  Credential,
  CredentialHealth,
  ProviderId,
  QuotaWindow,
  RequestLog,
  ScoringWeights,
  Settings,
  Strategy,
  Target,
  UsageBucket,
  VirtualModel,
  WindowType,
};

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "kimi"];

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kimi: "Kimi Coding",
};

export const STRATEGIES: readonly Strategy[] = ["score", "priority", "roundRobin", "weighted"];

/**
 * What `GET /api/credentials` actually serializes.
 *
 * The store's `CredentialView` adds a `secrets()` thunk that never crosses the
 * wire. Aliasing it here rather than importing `Credential` at every call site
 * gives a future divergence exactly one place to be expressed.
 */
export type WireCredential = Credential;

export type CredentialsResponse = { credentials: WireCredential[] };
export type ModelsResponse = { models: VirtualModel[] };
export type SettingsResponse = { settings: Settings };
export type UsageResponse = { rows: UsageBucket[] };
export type LogsResponse = { logs: RequestLog[] };
export type OkResponse = { ok: true };

/** `GET /api/status` — drives the first-run branch in Task 4. */
export type StatusResponse = { configured: boolean; authenticated: boolean };

/** `GET /api/keys`. The stored `hash` is deliberately absent from the wire shape. */
export type WireApiKey = Omit<ApiKey, "hash">;
export type KeysResponse = { keys: WireApiKey[] };

/**
 * `POST /api/keys`. `key` is the plaintext value, returned exactly once because
 * this is the only moment it exists outside the operator's clipboard.
 */
export type MintedKey = { id: string; label: string; prefix: string; key: string };

export type MintKeyInput = {
  label: string;
  modelAllowlist: string[] | null;
  rateLimitPerMin: number | null;
};

/** Only these credential fields are operator-editable; the gateway rejects the rest. */
export type CredentialPatch = {
  label?: string;
  enabled?: boolean;
  tier?: number;
  weight?: number;
};

/** `POST /api/connect/start` */
export type ConnectStart = {
  flowId: string;
  authorizeUrl: string;
  userCode: string | null;
  kind: "pkce" | "device";
  supportsManualPaste: boolean;
  pollIntervalMs: number;
};

/** `POST /api/connect/finish` — the response carries an id and nothing else. */
export type ConnectFinish = { id: string };

/** `POST /api/connect/poll` — 202 while pending, 200 with the id on completion. */
export type ConnectPoll = { status: "pending" } | { status: "complete"; id: string };

export type UsageGroupBy = "credential" | "model" | "apiKey" | "hour";

export const USAGE_GROUP_BY: readonly UsageGroupBy[] = ["model", "credential", "apiKey", "hour"];
```

- [ ] **Step 5: Write the client**

`apps/dashboard/src/api/client.ts`:

```ts
/**
 * The one place this app talks to the gateway.
 *
 * Two invariants, both load-bearing:
 *   - `credentials: "same-origin"` on every call, because auth is the HttpOnly
 *     `omni_admin` cookie. No `Authorization` header is ever set; a gateway API
 *     key would be the wrong credential for this surface entirely.
 *   - Failures throw `ApiError`, never a bare `Response`. TanStack Query's
 *     error path then carries a code and a message the UI can render.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** True when the session lapsed and the app should send the operator to /login. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

type ErrorBody = { error?: { code?: unknown; message?: unknown } };

async function toApiError(response: Response): Promise<ApiError> {
  let code = "INTERNAL";
  let message = `request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as ErrorBody;
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // A proxy or a crash can return HTML. The status is still the useful part.
  }
  return new ApiError(response.status, code, message);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    // The session cookie is HttpOnly, so the browser attaches it; this opts in.
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return null as T;

  const text = await response.text();
  if (text.length === 0) return null as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>("GET", path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>("PATCH", path, body),
  del: <T>(path: string): Promise<T> => request<T>("DELETE", path),
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test apps/dashboard`
Expected: 9 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard
git commit -m "feat(dashboard): add the typed /api client and its wire types"
```

---

## Task 3: Query options, mutation helpers, and the render harness

**Files:**
- Create: `apps/dashboard/src/api/queries.ts`, `apps/dashboard/src/lib/format.ts`, `apps/dashboard/test/helpers/render.tsx`, `apps/dashboard/test/helpers/fixtures.ts`
- Test: `apps/dashboard/test/api/queries.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` (Task 2); every wire type from `src/api/types.ts` (Task 2).
- Produces:
  - `qk` — the query-key namespace: `qk.status()`, `qk.credentials()`, `qk.models()`, `qk.settings()`, `qk.keys()`, `qk.usage(groupBy, sinceMs)`, `qk.logs(limit)`
  - `statusQuery()`, `credentialsQuery()`, `modelsQuery()`, `settingsQuery()`, `keysQuery()`, `usageQuery(groupBy, sinceMs)`, `logsQuery(limit, pollMs)` — each returns a TanStack Query `queryOptions` object
  - `useInvalidate()` — `(keys: readonly unknown[][]) => Promise<void>`
  - `formatTokens`, `formatUsd`, `formatMs`, `formatRelative`, `formatExpiry` from `src/lib/format.ts`
  - `renderWithProviders(ui, opts?)` and `makeQueryClient()` test helpers
  - `credentialFixture`, `healthFixture`, `quotaFixture`, `modelFixture`, `targetFixture`, `keyFixture`, `logFixture`, `bucketFixture` test fixtures
- Tasks 4–11 all consume these.

Query keys are centralized because a mutation in one screen frequently invalidates data another screen owns — editing a credential's tier changes the ranking the Models dry-run panel shows.

- [ ] **Step 1: Write the failing test**

`apps/dashboard/test/api/queries.test.tsx`:

```tsx
import { afterEach, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { credentialsQuery, logsQuery, qk, usageQuery } from "../../src/api/queries.ts";
import { formatMs, formatTokens, formatUsd } from "../../src/lib/format.ts";
import { credentialFixture } from "../helpers/fixtures.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { queryWrapper } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("query keys are stable and distinguish their arguments", () => {
  expect(qk.credentials()).toEqual(["credentials"]);
  expect(qk.usage("model", 100)).toEqual(["usage", "model", 100]);
  expect(qk.usage("credential", 100)).not.toEqual(qk.usage("model", 100));
  expect(qk.logs(50)).toEqual(["logs", 50]);
});

test("credentialsQuery unwraps the credentials envelope", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture({ id: "c1" })] }),
  });
  const { result } = renderHook(() => useQuery(credentialsQuery()), { wrapper: queryWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.[0]?.id).toBe("c1");
});

test("usageQuery encodes groupBy and since into the query string", async () => {
  const stub = createFetchStub({
    "GET /api/usage?groupBy=credential&since=1000": () => ({ rows: [] }),
  });
  const { result } = renderHook(() => useQuery(usageQuery("credential", 1000)), {
    wrapper: queryWrapper(),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(stub.calls[0]?.url).toBe("/api/usage?groupBy=credential&since=1000");
});

test("logsQuery caps the limit and sets a refetch interval", () => {
  const options = logsQuery(50, 3000);
  expect(options.queryKey).toEqual(["logs", 50]);
  expect(options.refetchInterval).toBe(3000);
  // Polling with a stale time above the interval would serve cache forever.
  expect(options.staleTime).toBe(0);
});

test("formatters render the units an operator reads", () => {
  expect(formatTokens(1_500_000)).toBe("1.5M");
  expect(formatTokens(2_400)).toBe("2.4K");
  expect(formatTokens(42)).toBe("42");
  expect(formatUsd(1.5)).toBe("$1.50");
  expect(formatUsd(0.0004)).toBe("$0.0004");
  expect(formatMs(950)).toBe("950ms");
  expect(formatMs(2_500)).toBe("2.5s");
  expect(formatMs(null)).toBe("—");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/dashboard/test/api/queries.test.tsx`
Expected: FAIL — cannot resolve `../../src/api/queries.ts`.

- [ ] **Step 3: Write the formatters**

`apps/dashboard/src/lib/format.ts`:

```ts
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function formatUsd(n: number): string {
  // Sub-cent costs are the common case for a single request; rounding them all
  // to $0.00 would make the per-request cost column useless.
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

const UNITS: ReadonlyArray<[limit: number, ms: number, label: string]> = [
  [60_000, 1_000, "s"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
  [Number.POSITIVE_INFINITY, 86_400_000, "d"],
];

/** "12s ago" / "in 4h". Coarse on purpose: exact clock times invite squinting. */
export function formatRelative(at: number, now: number): string {
  const delta = at - now;
  const abs = Math.abs(delta);
  if (abs < 1_000) return "just now";
  const unit = UNITS.find(([limit]) => abs < limit) ?? UNITS[UNITS.length - 1];
  const value = Math.round(abs / (unit as [number, number, string])[1]);
  const label = `${value}${(unit as [number, number, string])[2]}`;
  return delta < 0 ? `${label} ago` : `in ${label}`;
}

/** Token expiry, with `null` meaning a credential whose token does not expire. */
export function formatExpiry(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "no expiry";
  return expiresAt <= now ? "expired" : `expires ${formatRelative(expiresAt, now)}`;
}
```

- [ ] **Step 4: Write the query options**

`apps/dashboard/src/api/queries.ts`:

```ts
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { api } from "./client.ts";
import type {
  CredentialsResponse,
  KeysResponse,
  LogsResponse,
  ModelsResponse,
  RequestLog,
  SettingsResponse,
  StatusResponse,
  UsageGroupBy,
  UsageResponse,
  VirtualModel,
  WireApiKey,
  WireCredential,
} from "./types.ts";
import type { Settings, UsageBucket } from "./types.ts";

/**
 * Every query key in the app.
 *
 * Centralized because invalidation crosses screens: raising a credential's tier
 * changes what the Models dry-run panel would rank, and the mutation that did
 * it should not have to guess the other screen's key shape.
 */
export const qk = {
  status: () => ["status"] as const,
  credentials: () => ["credentials"] as const,
  models: () => ["models"] as const,
  settings: () => ["settings"] as const,
  keys: () => ["keys"] as const,
  usage: (groupBy: UsageGroupBy, sinceMs: number) => ["usage", groupBy, sinceMs] as const,
  logs: (limit: number) => ["logs", limit] as const,
  dryRun: (modelId: string) => ["dryRun", modelId] as const,
};

export function statusQuery() {
  return queryOptions({
    queryKey: qk.status(),
    queryFn: () => api.get<StatusResponse>("/api/status"),
    // The login gate reads this; a cached "authenticated: true" after a logout
    // would bounce the operator into a screen that 401s on every panel.
    staleTime: 0,
    retry: false,
  });
}

export function credentialsQuery() {
  return queryOptions({
    queryKey: qk.credentials(),
    queryFn: async (): Promise<WireCredential[]> =>
      (await api.get<CredentialsResponse>("/api/credentials")).credentials,
  });
}

export function modelsQuery() {
  return queryOptions({
    queryKey: qk.models(),
    queryFn: async (): Promise<VirtualModel[]> =>
      (await api.get<ModelsResponse>("/api/models")).models,
  });
}

export function settingsQuery() {
  return queryOptions({
    queryKey: qk.settings(),
    queryFn: async (): Promise<Settings> =>
      (await api.get<SettingsResponse>("/api/settings")).settings,
  });
}

export function keysQuery() {
  return queryOptions({
    queryKey: qk.keys(),
    queryFn: async (): Promise<WireApiKey[]> => (await api.get<KeysResponse>("/api/keys")).keys,
  });
}

export function usageQuery(groupBy: UsageGroupBy, sinceMs: number) {
  return queryOptions({
    queryKey: qk.usage(groupBy, sinceMs),
    queryFn: async (): Promise<UsageBucket[]> =>
      (await api.get<UsageResponse>(`/api/usage?groupBy=${groupBy}&since=${sinceMs}`)).rows,
  });
}

/**
 * The live tail.
 *
 * The core plan has no WebSocket, so "live" is a poll. `staleTime: 0` matters:
 * a stale time above the interval would let the cache satisfy every refetch and
 * the tail would silently stop moving.
 */
export function logsQuery(limit: number, pollMs: number) {
  return queryOptions({
    queryKey: qk.logs(limit),
    queryFn: async (): Promise<RequestLog[]> =>
      (await api.get<LogsResponse>(`/api/logs?limit=${limit}`)).logs,
    refetchInterval: pollMs,
    staleTime: 0,
  });
}

/** Invalidate several keys at once, awaited so a form can disable while it settles. */
export function useInvalidate(): (keys: readonly (readonly unknown[])[]) => Promise<void> {
  const queryClient = useQueryClient();
  return async (keys) => {
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
}
```

- [ ] **Step 5: Write the render harness**

`apps/dashboard/test/helpers/render.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

/**
 * Retries off, so a test asserting an error path waits for one failure rather
 * than the default backoff schedule.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function queryWrapper(client: QueryClient = makeQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options: { client?: QueryClient } = {},
): RenderResult & { client: QueryClient } {
  const client = options.client ?? makeQueryClient();
  const result = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...result, client };
}
```

- [ ] **Step 6: Write the fixtures**

`apps/dashboard/test/helpers/fixtures.ts`:

```ts
import type {
  CredentialHealth,
  QuotaWindow,
  RequestLog,
  Target,
  UsageBucket,
  VirtualModel,
  WireApiKey,
  WireCredential,
} from "../../src/api/types.ts";

export const NOW = 1_700_000_000_000;

export function credentialFixture(patch: Partial<WireCredential> = {}): WireCredential {
  return {
    id: "c1",
    provider: "anthropic",
    label: "work",
    authType: "oauth",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: NOW + 3_600_000,
    accountEmail: "user@example.com",
    providerData: {},
    hasRefreshToken: true,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    ...patch,
  };
}

export function healthFixture(patch: Partial<CredentialHealth> = {}): CredentialHealth {
  return {
    credentialId: "c1",
    model: "claude-opus-4",
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: 420,
    lastUsedAt: NOW - 60_000,
    ...patch,
  };
}

export function quotaFixture(patch: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    credentialId: "c1",
    windowType: "fiveHour",
    startsAt: NOW - 1_800_000,
    used: 250,
    limit: 1_000,
    ...patch,
  };
}

export function targetFixture(patch: Partial<Target> = {}): Target {
  return {
    provider: "anthropic",
    model: "claude-opus-4",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 15, output: 75 },
    capabilities: { tools: true, images: true, reasoning: true },
    ...patch,
  };
}

export function modelFixture(patch: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id: "fast",
    targets: [targetFixture()],
    strategy: "score",
    isAlias: false,
    ...patch,
  };
}

export function keyFixture(patch: Partial<WireApiKey> = {}): WireApiKey {
  return {
    id: "k1",
    label: "laptop",
    prefix: "omni_sk_abcd",
    modelAllowlist: null,
    rateLimitPerMin: null,
    createdAt: NOW - 86_400_000,
    revokedAt: null,
    ...patch,
  };
}

export function logFixture(patch: Partial<RequestLog> = {}): RequestLog {
  return {
    id: "r1",
    at: NOW - 5_000,
    apiKeyId: "k1",
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 1_200,
    outputTokens: 340,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: 410,
    durationMs: 2_100,
    costUsd: 0.0435,
    degradations: [],
    ...patch,
  };
}

export function bucketFixture(patch: Partial<UsageBucket> = {}): UsageBucket {
  return {
    key: "claude-opus-4",
    requests: 12,
    inputTokens: 14_400,
    outputTokens: 4_080,
    costUsd: 0.52,
    errors: 1,
    ...patch,
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test apps/dashboard`
Expected: 14 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard
git commit -m "feat(dashboard): add query options, formatters and the test harness"
```

---

## Task 4: First run and login — setup, forced password, session gate

**Files:**
- Create: `apps/dashboard/src/routes/login.tsx`, `apps/dashboard/src/components/ErrorState.tsx`
- Test: `apps/dashboard/test/routes/login.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` (Task 2); `statusQuery`, `qk` (Task 3); `renderWithProviders`, `makeQueryClient` (Task 3); `createFetchStub` (Task 2).
- Produces:
  - `LoginScreen` — the default export component of `/login`, exported by name for testing
  - `ErrorState({ error, onRetry })` — renders an `ApiError`'s message with an optional retry button
- Task 5 consumes `ErrorState`; Task 5's route guard depends on the session this task establishes.

`GET /api/status` returns `{ configured, authenticated }`. `configured: false` is first run: no admin password has ever been set, so the screen renders the **setup** form, which POSTs `/api/setup`. The gateway sets the session cookie from `/api/setup` directly, so a successful setup is also a successful login — the operator is never asked to type the password twice in a row.

The gateway enforces a 12-character minimum. The form enforces the same rule client-side so the operator gets the message before a round trip, but the server remains the authority: a `400` from `/api/setup` is rendered verbatim.

- [ ] **Step 1: Write the failing test**

`apps/dashboard/test/routes/login.test.tsx`:

```tsx
import { afterEach, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginScreen } from "../../src/routes/login.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("an unconfigured gateway renders the first-run setup form", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: false, authenticated: false }) });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  expect(await screen.findByRole("heading", { name: /set an admin password/i })).toBeDefined();
  expect(screen.getByLabelText(/^password$/i)).toBeDefined();
  expect(screen.getByLabelText(/confirm password/i)).toBeDefined();
});

test("a configured gateway renders the login form instead", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  expect(await screen.findByRole("heading", { name: /sign in/i })).toBeDefined();
  expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
});

test("setup posts the password and reports success upward", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({ ok: true }),
  });
  let authenticated = false;
  renderWithProviders(<LoginScreen onAuthenticated={() => { authenticated = true; }} />);
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.type(screen.getByLabelText(/confirm password/i), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  await waitFor(() => expect(authenticated).toBe(true));
  const setup = stub.calls.find((c) => c.url === "/api/setup");
  expect(setup?.init?.body).toBe(JSON.stringify({ password: "correct-horse-battery" }));
});

test("setup refuses to submit when the confirmation does not match", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({ ok: true }),
  });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.type(screen.getByLabelText(/confirm password/i), "correct-horse-batteryy");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  expect(await screen.findByText(/passwords do not match/i)).toBeDefined();
  expect(stub.calls.some((c) => c.url === "/api/setup")).toBe(false);
});

test("setup refuses a password under twelve characters without a round trip", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({ ok: true }),
  });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "short");
  await user.type(screen.getByLabelText(/confirm password/i), "short");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  expect(await screen.findByText(/at least 12 characters/i)).toBeDefined();
  expect(stub.calls.some((c) => c.url === "/api/setup")).toBe(false);
});

test("login posts the password and reports success upward", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: true, authenticated: false }),
    "POST /api/login": () => ({ ok: true }),
  });
  let authenticated = false;
  renderWithProviders(<LoginScreen onAuthenticated={() => { authenticated = true; }} />);
  await screen.findByRole("heading", { name: /sign in/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: /sign in/i }));

  await waitFor(() => expect(authenticated).toBe(true));
  expect(stub.calls.find((c) => c.url === "/api/login")?.init?.method).toBe("POST");
});

test("a rejected password surfaces the gateway's own message", async () => {
  createFetchStub({
    "GET /api/status": () => ({ configured: true, authenticated: false }),
    "POST /api/login": () => ({
      status: 401,
      body: { error: { code: "AUTH", message: "invalid password" } },
    }),
  });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  await screen.findByRole("heading", { name: /sign in/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "wrong-password-here");
  await user.click(screen.getByRole("button", { name: /sign in/i }));

  expect(await screen.findByText(/invalid password/i)).toBeDefined();
});

test("a setup conflict tells the operator to sign in instead of retrying setup", async () => {
  createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({
      status: 409,
      body: { error: { code: "CONFLICT", message: "an admin password is already configured" } },
    }),
  });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.type(screen.getByLabelText(/confirm password/i), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  expect(await screen.findByText(/already configured/i)).toBeDefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/dashboard/test/routes/login.test.tsx`
Expected: FAIL — cannot resolve `../../src/routes/login.tsx`.

- [ ] **Step 3: Write the error state component**

`apps/dashboard/src/components/ErrorState.tsx`:

```tsx
import { ApiError } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "something went wrong";
  const code = error instanceof ApiError ? error.code : null;

  return (
    <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-4 text-sm">
      <p className="font-medium">{message}</p>
      {code !== null && <p className="mt-1 text-xs opacity-70">{code}</p>}
      {onRetry !== undefined && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the login screen**

`apps/dashboard/src/routes/login.tsx`:

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { statusQuery } from "@/api/queries.ts";
import type { OkResponse } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

/** Matches the gateway's MIN_PASSWORD_LENGTH. The server stays the authority. */
const MIN_PASSWORD_LENGTH = 12;

export function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const status = useQuery(statusQuery());
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const isFirstRun = status.data?.configured === false;

  const submit = useMutation({
    mutationFn: (value: string) =>
      api.post<OkResponse>(isFirstRun ? "/api/setup" : "/api/login", { password: value }),
    onSuccess: () => {
      setPassword("");
      setConfirm("");
      onAuthenticated();
    },
  });

  if (status.isPending) return <p className="p-8 text-sm opacity-70">Checking gateway…</p>;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => status.refetch()} />;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);

    if (isFirstRun) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirm) {
        setLocalError("Passwords do not match.");
        return;
      }
    }
    submit.mutate(password);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">
          {isFirstRun ? "Set an admin password" : "Sign in"}
        </h1>
        <p className="mt-1 text-sm opacity-70">
          {isFirstRun
            ? "This gateway has no admin password yet. Choose one to finish setup."
            : "Enter the admin password for this gateway."}
        </p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={isFirstRun ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {isFirstRun && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}

          {localError !== null && (
            <p role="alert" className="text-sm text-bad">
              {localError}
            </p>
          )}
          {submit.isError && <ErrorState error={submit.error} />}

          <Button type="submit" className="w-full" disabled={submit.isPending}>
            {isFirstRun ? "Create password" : "Sign in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

function LoginRoute() {
  const navigate = useNavigate();
  return (
    <LoginScreen
      onAuthenticated={() => {
        void navigate({ to: "/credentials" });
      }}
    />
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test apps/dashboard`
Expected: 22 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard
git commit -m "feat(dashboard): add the first-run setup and login screen"
```

---

## Task 5: The app shell, the authenticated layout, and the 401 handler

**Files:**
- Create: `apps/dashboard/src/routes/_app.tsx`, `apps/dashboard/src/routes/_app.index.tsx`, `apps/dashboard/src/components/AppShell.tsx`
- Modify: `apps/dashboard/src/routes/__root.tsx`, `apps/dashboard/src/routes/index.tsx` (delete — replaced by `_app.index.tsx`), `apps/dashboard/src/main.tsx`
- Test: `apps/dashboard/test/routes/guard.test.tsx`

**Interfaces:**
- Consumes: `statusQuery`, `qk` (Task 3); `api` (Task 2); `ErrorState` (Task 4).
- Produces:
  - `AppShell({ onSignOut, children })` — sidebar nav plus the routed outlet
  - The `_app` pathless layout route, whose `beforeLoad` throws `redirect({ to: "/login" })` when `/api/status` reports `authenticated: false`
  - `NAV_ITEMS` — the five screens' paths and labels
- Tasks 6–11 mount their screens under `_app`.

The guard reads `/api/status` through `queryClient.ensureQueryData`, so the router's `beforeLoad` and the components share one cache entry rather than issuing two requests on every navigation.

- [ ] **Step 1: Write the failing test**

`apps/dashboard/test/routes/guard.test.tsx`:

```tsx
import { afterEach, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppShell, NAV_ITEMS, requireSession } from "../../src/components/AppShell.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { makeQueryClient } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Ctx = { queryClient: QueryClient };

/**
 * A miniature router with the same guard the real `_app` layout uses. Building
 * it here rather than importing routeTree.gen.ts keeps the test independent of
 * the generated file, which does not exist until the Vite plugin has run.
 */
function harness(initial: string) {
  const queryClient = makeQueryClient();
  const rootRoute = createRootRouteWithContext<Ctx>()({ component: () => <Outlet /> });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_app",
    beforeLoad: ({ context }) => requireSession(context.queryClient),
    component: () => (
      <AppShell onSignOut={() => {}}>
        <Outlet />
      </AppShell>
    ),
  });
  const credentialsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "/credentials",
    component: () => <p>credentials screen</p>,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => <p>login screen</p>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      appRoute.addChildren([credentialsRoute]),
      loginRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initial] }),
    context: { queryClient },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

test("an authenticated session renders the guarded screen", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: true }) });
  harness("/credentials");
  expect(await screen.findByText("credentials screen")).toBeDefined();
});

test("an unauthenticated session redirects to login", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
  harness("/credentials");
  expect(await screen.findByText("login screen")).toBeDefined();
  expect(screen.queryByText("credentials screen")).toBeNull();
});

test("the shell links to all five screens", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: true }) });
  harness("/credentials");
  await screen.findByText("credentials screen");
  for (const item of NAV_ITEMS) {
    expect(screen.getByRole("link", { name: item.label })).toBeDefined();
  }
  expect(NAV_ITEMS.map((i) => i.to)).toEqual([
    "/credentials",
    "/models",
    "/usage",
    "/logs",
    "/keys",
  ]);
});

test("signing out posts logout and clears the cached status", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: true, authenticated: true }),
    "POST /api/logout": () => ({ ok: true }),
  });
  const { queryClient } = harness("/credentials");
  await screen.findByText("credentials screen");

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /sign out/i }));

  await waitFor(() => expect(stub.calls.some((c) => c.url === "/api/logout")).toBe(true));
  await waitFor(() => expect(queryClient.getQueryData(["status"])).toBeUndefined());
});
```

Note: the test imports `Outlet` from `@tanstack/react-router`; add it to the import list at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/dashboard/test/routes/guard.test.tsx`
Expected: FAIL — cannot resolve `../../src/components/AppShell.tsx`.

- [ ] **Step 3: Write the app shell and the guard**

`apps/dashboard/src/components/AppShell.tsx`:

```tsx
import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, redirect, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "@/api/client.ts";
import { qk, statusQuery } from "@/api/queries.ts";
import type { OkResponse } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

export const NAV_ITEMS = [
  { to: "/credentials", label: "Credentials" },
  { to: "/models", label: "Models" },
  { to: "/usage", label: "Usage" },
  { to: "/logs", label: "Logs" },
  { to: "/keys", label: "Keys" },
] as const;

/**
 * The route guard.
 *
 * Reads `/api/status` through the shared query cache, so navigating between
 * guarded screens costs zero extra requests: `beforeLoad` and the components
 * below it hit the same entry.
 */
export async function requireSession(queryClient: QueryClient): Promise<void> {
  const status = await queryClient.ensureQueryData(statusQuery());
  if (!status.authenticated) {
    throw redirect({ to: "/login" });
  }
}

export function AppShell({
  onSignOut,
  children,
}: {
  onSignOut: () => void;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();

  const signOut = useMutation({
    mutationFn: () => api.post<OkResponse>("/api/logout"),
    onSettled: async () => {
      // Everything in the cache was fetched with a session that no longer
      // exists. Clearing beats invalidating: a refetch would just 401.
      queryClient.clear();
      onSignOut();
    },
  });

  return (
    <div className="flex min-h-screen">
      <nav className="w-56 shrink-0 border-r p-4">
        <p className="px-2 pb-4 text-sm font-semibold tracking-tight">OmniGateway</p>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className={cn(
                  "block rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                  "aria-[current=page]:bg-muted aria-[current=page]:font-medium",
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <Button
          variant="ghost"
          size="sm"
          className="mt-6 w-full justify-start"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </Button>
      </nav>
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}

/** Re-exported for the route file, which needs the key to clear it on sign-out. */
export const STATUS_KEY = qk.status();
```

- [ ] **Step 4: Write the layout route and the index redirect**

`apps/dashboard/src/routes/_app.tsx`:

```tsx
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { AppShell, requireSession } from "@/components/AppShell.tsx";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context }) => requireSession(context.queryClient),
  component: AppLayout,
});

function AppLayout() {
  const navigate = useNavigate();
  return (
    <AppShell
      onSignOut={() => {
        void navigate({ to: "/login" });
      }}
    >
      <Outlet />
    </AppShell>
  );
}
```

`apps/dashboard/src/routes/_app.index.tsx`:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  // Credentials is the screen an operator opens on: nothing else works until
  // at least one account is connected.
  beforeLoad: () => {
    throw redirect({ to: "/credentials" });
  },
});
```

Delete `apps/dashboard/src/routes/index.tsx` — `_app.index.tsx` replaces it.

- [ ] **Step 5: Give the root route its typed context**

`apps/dashboard/src/routes/__root.tsx`:

```tsx
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

export type RouterContext = { queryClient: QueryClient };

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});
```

`apps/dashboard/src/main.tsx` already passes `context: { queryClient }` to `createRouter` (Task 1, Step 7); no change is needed there.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test apps/dashboard`
Expected: 26 pass, 0 fail.

- [ ] **Step 7: Verify the build still typechecks**

Run: `cd apps/dashboard && bun run build`
Expected: no TypeScript errors; the generated `routeTree.gen.ts` contains `/login`, `/_app`, and `/_app/`.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard
git commit -m "feat(dashboard): add the app shell and the authenticated layout guard"
```

---
