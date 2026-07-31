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

## Task 6: Credentials screen — grouping, health, expiry, quota, inline edit

**Files:**
- Create: `apps/dashboard/src/components/Health.tsx`, `apps/dashboard/src/components/QuotaBar.tsx`, `apps/dashboard/src/features/credentials/CredentialCard.tsx`, `apps/dashboard/src/features/credentials/ProviderGroup.tsx`, `apps/dashboard/src/routes/_app.credentials.tsx`
- Test: `apps/dashboard/test/features/credentials.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 2); `WireCredential`, `CredentialHealth`, `QuotaWindow`, `ProviderId`, `PROVIDER_IDS`, `PROVIDER_LABELS`, `CredentialPatch` (Task 2); `credentialsQuery`, `qk`, `useInvalidate` (Task 3); `formatExpiry`, `formatMs`, `formatRelative` (Task 3); `ErrorState` (Task 4); fixtures and `renderWithProviders` (Task 3).
- Produces:
  - `HealthPill({ health, now })` — one of `healthy` / `rate limited` / `breaker open` / `unused`
  - `QuotaBar({ window: QuotaWindow })` — a labelled bar, rendered only when `limit !== null`
  - `CredentialCard({ credential, health, quota, now })` — one account, with inline tier and weight editing
  - `ProviderGroup({ provider, credentials, health, quota, now })`
  - `CredentialsScreen({ now })` — the screen body, exported for testing
- Task 7 mounts its connect dialog into `CredentialsScreen`.

**Health and quota are not on `GET /api/credentials`.** The core plan's credential projection carries only the `Credential` fields; `CredentialHealth` and `QuotaWindow` rows live behind `store.credentials.listHealth()` and `listQuota()`, which no `/api/*` route exposes. This task therefore ships the health and quota **rendering** driven by props, with the screen passing empty collections, and **Task 12** adds the single control route (`GET /api/credentials/health`) that fills them. Splitting it this way keeps the two independently reviewable: a reviewer can reject the server addition without rejecting the card layout.

The gateway's `credentialPatchSchema` is `.strict()` and accepts exactly `label`, `enabled`, `tier`, `weight`. Sending anything else is a 400, so `CredentialPatch` (Task 2) mirrors it exactly.

- [ ] **Step 1: Write the failing test**

`apps/dashboard/test/features/credentials.test.tsx`:

```tsx
import { afterEach, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CredentialsScreen } from "../../src/routes/_app.credentials.tsx";
import { HealthPill } from "../../src/components/Health.tsx";
import { QuotaBar } from "../../src/components/QuotaBar.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { credentialFixture, healthFixture, NOW, quotaFixture } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("accounts are grouped under their provider heading", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [
        credentialFixture({ id: "c1", provider: "anthropic", label: "work" }),
        credentialFixture({ id: "c2", provider: "anthropic", label: "personal" }),
        credentialFixture({ id: "c3", provider: "kimi", label: "kimi one" }),
      ],
    }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);

  const anthropic = await screen.findByRole("region", { name: /anthropic/i });
  expect(within(anthropic).getByText("work")).toBeDefined();
  expect(within(anthropic).getByText("personal")).toBeDefined();

  const kimi = screen.getByRole("region", { name: /kimi coding/i });
  expect(within(kimi).getByText("kimi one")).toBeDefined();
  expect(within(kimi).queryByText("work")).toBeNull();
});

test("a provider with no accounts still renders its group so the operator can add one", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  expect(await screen.findByRole("region", { name: /openai/i })).toBeDefined();
  expect(screen.getAllByRole("button", { name: /add account/i })).toHaveLength(3);
});

test("the health pill names each breaker state", () => {
  const { rerender } = renderWithProviders(
    <HealthPill health={[healthFixture({ breakerState: "closed" })]} now={NOW} />,
  );
  expect(screen.getByText(/healthy/i)).toBeDefined();

  rerender(
    <HealthPill
      health={[healthFixture({ breakerState: "open", openedAt: NOW - 1_000, consecutiveFailures: 3 })]}
      now={NOW}
    />,
  );
  expect(screen.getByText(/breaker open/i)).toBeDefined();

  rerender(
    <HealthPill health={[healthFixture({ rateLimitedUntil: NOW + 60_000 })]} now={NOW} />,
  );
  expect(screen.getByText(/rate limited/i)).toBeDefined();

  rerender(<HealthPill health={[]} now={NOW} />);
  expect(screen.getByText(/unused/i)).toBeDefined();
});

test("an expired rate limit reads as healthy again", () => {
  renderWithProviders(
    <HealthPill health={[healthFixture({ rateLimitedUntil: NOW - 1_000 })]} now={NOW} />,
  );
  expect(screen.getByText(/healthy/i)).toBeDefined();
});

test("the quota bar shows used against limit and its fill percentage", () => {
  renderWithProviders(
    <QuotaBar window={quotaFixture({ windowType: "fiveHour", used: 250, limit: 1_000 })} />,
  );
  const bar = screen.getByRole("progressbar", { name: /5-hour/i });
  expect(bar.getAttribute("aria-valuenow")).toBe("25");
  expect(screen.getByText("250 / 1,000")).toBeDefined();
});

test("a window with no configured limit says so instead of rendering a bar", () => {
  renderWithProviders(<QuotaBar window={quotaFixture({ limit: null, used: 900 })} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText(/no limit configured/i)).toBeDefined();
});

test("token expiry is rendered in relative terms", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [credentialFixture({ id: "c1", expiresAt: NOW + 3_600_000 })],
    }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  expect(await screen.findByText(/expires in 1h/i)).toBeDefined();
});

test("an expired credential with no refresh token is called out", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [
        credentialFixture({ id: "c1", expiresAt: NOW - 1_000, hasRefreshToken: false }),
      ],
    }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  expect(await screen.findByText(/expired/i)).toBeDefined();
  expect(screen.getByText(/reconnect required/i)).toBeDefined();
});

test("editing tier patches only the changed field", async () => {
  const stub = createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture({ id: "c1", tier: 1 })] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
    "PATCH /api/credentials/c1": () => ({ ok: true }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  await screen.findByText("work");

  const user = userEvent.setup();
  const tier = screen.getByLabelText(/tier/i);
  await user.clear(tier);
  await user.type(tier, "3");
  await user.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(stub.calls.some((c) => c.url === "/api/credentials/c1")).toBe(true),
  );
  const patch = stub.calls.find((c) => c.url === "/api/credentials/c1");
  expect(patch?.init?.method).toBe("PATCH");
  expect(patch?.init?.body).toBe(JSON.stringify({ tier: 3 }));
});

test("editing weight and toggling enabled send both fields in one patch", async () => {
  const stub = createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [credentialFixture({ id: "c1", weight: 1, enabled: true })],
    }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
    "PATCH /api/credentials/c1": () => ({ ok: true }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  await screen.findByText("work");

  const user = userEvent.setup();
  const weight = screen.getByLabelText(/weight/i);
  await user.clear(weight);
  await user.type(weight, "2.5");
  await user.click(screen.getByRole("switch", { name: /enabled/i }));
  await user.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(stub.calls.some((c) => c.url === "/api/credentials/c1")).toBe(true),
  );
  expect(stub.calls.find((c) => c.url === "/api/credentials/c1")?.init?.body).toBe(
    JSON.stringify({ enabled: false, weight: 2.5 }),
  );
});

test("save is disabled until a field actually changes", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture({ id: "c1" })] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  await screen.findByText("work");
  expect(screen.getByRole("button", { name: /save/i }).hasAttribute("disabled")).toBe(true);
});

test("a successful patch refetches the credential list", async () => {
  let listCalls = 0;
  createFetchStub({
    "GET /api/credentials": () => {
      listCalls += 1;
      return { credentials: [credentialFixture({ id: "c1", tier: 1 })] };
    },
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
    "PATCH /api/credentials/c1": () => ({ ok: true }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  await screen.findByText("work");
  expect(listCalls).toBe(1);

  const user = userEvent.setup();
  const tier = screen.getByLabelText(/tier/i);
  await user.clear(tier);
  await user.type(tier, "2");
  await user.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() => expect(listCalls).toBe(2));
});

test("deleting an account asks first and then calls delete", async () => {
  const stub = createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture({ id: "c1" })] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
    "DELETE /api/credentials/c1": () => ({ ok: true }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  await screen.findByText("work");

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /remove/i }));
  expect(await screen.findByText(/remove “work”\?/i)).toBeDefined();
  await user.click(screen.getByRole("button", { name: /^remove account$/i }));

  await waitFor(() =>
    expect(stub.calls.some((c) => c.url === "/api/credentials/c1" && c.init?.method === "DELETE")).toBe(true),
  );
});

test("a failed list renders the gateway's error rather than an empty page", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      status: 500,
      body: { error: { code: "INTERNAL", message: "database is locked" } },
    }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  renderWithProviders(<CredentialsScreen now={NOW} />);
  expect(await screen.findByText(/database is locked/i)).toBeDefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/dashboard/test/features/credentials.test.tsx`
Expected: FAIL — cannot resolve `../../src/components/Health.tsx`.

- [ ] **Step 3: Write the health pill**

`apps/dashboard/src/components/Health.tsx`:

```tsx
import type { CredentialHealth } from "@/api/types.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { formatMs, formatRelative } from "@/lib/format.ts";

export type HealthSummary = {
  label: "healthy" | "rate limited" | "breaker open" | "unused";
  tone: "ok" | "warn" | "bad" | "muted";
  detail: string | null;
};

/**
 * Health is per (credential, model), so one credential has several rows. The
 * pill shows the worst of them: an account healthy for one model and dead for
 * another is not an account an operator should read as "healthy".
 */
export function summarizeHealth(rows: CredentialHealth[], now: number): HealthSummary {
  if (rows.length === 0) return { label: "unused", tone: "muted", detail: null };

  const open = rows.find((r) => r.breakerState === "open");
  if (open !== undefined) {
    return {
      label: "breaker open",
      tone: "bad",
      detail: `${open.model}, ${open.consecutiveFailures} consecutive failures`,
    };
  }

  const limited = rows.find((r) => r.rateLimitedUntil !== null && r.rateLimitedUntil > now);
  if (limited !== undefined) {
    return {
      label: "rate limited",
      tone: "warn",
      detail: `${limited.model}, clears ${formatRelative(limited.rateLimitedUntil as number, now)}`,
    };
  }

  const latencies = rows.flatMap((r) => (r.ewmaTtftMs === null ? [] : [r.ewmaTtftMs]));
  const detail =
    latencies.length === 0
      ? null
      : `TTFT ${formatMs(latencies.reduce((a, b) => a + b, 0) / latencies.length)}`;
  return { label: "healthy", tone: "ok", detail };
}

const TONE_CLASS: Readonly<Record<HealthSummary["tone"], string>> = {
  ok: "bg-ok/15 text-ok border-ok/30",
  warn: "bg-warn/15 text-warn border-warn/30",
  bad: "bg-bad/15 text-bad border-bad/30",
  muted: "bg-muted text-muted-foreground border-transparent",
};

export function HealthPill({ health, now }: { health: CredentialHealth[]; now: number }) {
  const summary = summarizeHealth(health, now);
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="outline" className={TONE_CLASS[summary.tone]}>
        {summary.label}
      </Badge>
      {summary.detail !== null && (
        <span className="text-xs opacity-60">{summary.detail}</span>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Write the quota bar**

`apps/dashboard/src/components/QuotaBar.tsx`:

```tsx
import type { QuotaWindow, WindowType } from "@/api/types.ts";

const WINDOW_LABELS: Readonly<Record<WindowType, string>> = {
  fiveHour: "5-hour",
  daily: "Daily",
  weekly: "Weekly",
};

export function QuotaBar({ window }: { window: QuotaWindow }) {
  const label = WINDOW_LABELS[window.windowType];

  // A credential with no configured limit is never excluded by the quota
  // filter, so drawing a bar against an imaginary ceiling would be a lie.
  if (window.limit === null) {
    return (
      <div className="text-xs">
        <span className="font-medium">{label}</span>
        <span className="ml-2 opacity-60">no limit configured</span>
      </div>
    );
  }

  const percent = Math.min(100, Math.round((window.used / window.limit) * 100));
  const tone = percent >= 90 ? "bg-bad" : percent >= 70 ? "bg-warn" : "bg-ok";

  return (
    <div className="text-xs">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{label}</span>
        <span className="opacity-70">
          {window.used.toLocaleString("en-US")} / {window.limit.toLocaleString("en-US")}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} quota`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the credential card**

`apps/dashboard/src/features/credentials/CredentialCard.tsx`:

```tsx
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { qk, useInvalidate } from "@/api/queries.ts";
import type {
  CredentialHealth,
  CredentialPatch,
  OkResponse,
  QuotaWindow,
  WireCredential,
} from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { HealthPill } from "@/components/Health.tsx";
import { QuotaBar } from "@/components/QuotaBar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { formatExpiry } from "@/lib/format.ts";

/** Only the fields that actually changed. The gateway's patch schema is strict. */
function buildPatch(
  original: WireCredential,
  draft: { enabled: boolean; tier: number; weight: number },
): CredentialPatch {
  const patch: CredentialPatch = {};
  if (draft.enabled !== original.enabled) patch.enabled = draft.enabled;
  if (draft.tier !== original.tier) patch.tier = draft.tier;
  if (draft.weight !== original.weight) patch.weight = draft.weight;
  return patch;
}

export function CredentialCard({
  credential,
  health,
  quota,
  now,
}: {
  credential: WireCredential;
  health: CredentialHealth[];
  quota: QuotaWindow[];
  now: number;
}) {
  const invalidate = useInvalidate();
  const [enabled, setEnabled] = useState(credential.enabled);
  const [tier, setTier] = useState(String(credential.tier));
  const [weight, setWeight] = useState(String(credential.weight));
  const [confirming, setConfirming] = useState(false);

  const draft = { enabled, tier: Number(tier), weight: Number(weight) };
  const patch = buildPatch(credential, draft);
  const valid = Number.isInteger(draft.tier) && draft.tier >= 1 && draft.weight > 0;
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => api.patch<OkResponse>(`/api/credentials/${credential.id}`, patch),
    // Ranking depends on tier and weight, so the dry-run panel is stale too.
    onSuccess: () => invalidate([qk.credentials(), qk.dryRun(credential.id)]),
  });

  const remove = useMutation({
    mutationFn: () => api.del<OkResponse>(`/api/credentials/${credential.id}`),
    onSuccess: () => invalidate([qk.credentials()]),
  });

  const expired = credential.expiresAt !== null && credential.expiresAt <= now;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{credential.label}</p>
          <p className="truncate text-xs opacity-60">
            {credential.accountEmail ?? credential.id}
          </p>
        </div>
        <HealthPill health={health} now={now} />
      </div>

      <p className="mt-3 text-xs opacity-70">
        {formatExpiry(credential.expiresAt, now)}
        {expired && !credential.hasRefreshToken && (
          <span className="ml-2 text-bad">reconnect required</span>
        )}
      </p>

      {quota.length > 0 && (
        <div className="mt-3 space-y-2">
          {quota.map((w) => (
            <QuotaBar key={`${w.credentialId}-${w.windowType}-${w.startsAt}`} window={w} />
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div className="w-20 space-y-1.5">
          <Label htmlFor={`tier-${credential.id}`}>Tier</Label>
          <Input
            id={`tier-${credential.id}`}
            type="number"
            min={1}
            step={1}
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          />
        </div>
        <div className="w-24 space-y-1.5">
          <Label htmlFor={`weight-${credential.id}`}>Weight</Label>
          <Input
            id={`weight-${credential.id}`}
            type="number"
            min={0.1}
            step={0.1}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id={`enabled-${credential.id}`}
            aria-label="Enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <Label htmlFor={`enabled-${credential.id}`}>Enabled</Label>
        </div>

        <div className="ml-auto flex gap-2 pb-1">
          <Button
            size="sm"
            disabled={!dirty || !valid || save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        </div>
      </div>

      {confirming && (
        <div role="alertdialog" className="mt-4 rounded-md border border-bad/40 p-3 text-sm">
          <p>Remove “{credential.label}”? Its tokens are deleted and cannot be recovered.</p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove account
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {save.isError && <ErrorState error={save.error} />}
      {remove.isError && <ErrorState error={remove.error} />}
    </Card>
  );
}
```

- [ ] **Step 6: Write the provider group**

`apps/dashboard/src/features/credentials/ProviderGroup.tsx`:

```tsx
import type { CredentialHealth, ProviderId, QuotaWindow, WireCredential } from "@/api/types.ts";
import { PROVIDER_LABELS } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { CredentialCard } from "./CredentialCard.tsx";

export function ProviderGroup({
  provider,
  credentials,
  health,
  quota,
  now,
  onAdd,
}: {
  provider: ProviderId;
  credentials: WireCredential[];
  health: CredentialHealth[];
  quota: QuotaWindow[];
  now: number;
  onAdd: (provider: ProviderId) => void;
}) {
  const label = PROVIDER_LABELS[provider];
  return (
    <section aria-label={label} className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">{label}</h2>
        <Button size="sm" variant="outline" onClick={() => onAdd(provider)}>
          Add account
        </Button>
      </div>

      {credentials.length === 0 ? (
        <p className="text-sm opacity-60">No accounts connected.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {credentials.map((credential) => (
            <CredentialCard
              key={credential.id}
              credential={credential}
              health={health.filter((h) => h.credentialId === credential.id)}
              quota={quota.filter((q) => q.credentialId === credential.id)}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 7: Write the screen and its route**

`apps/dashboard/src/routes/_app.credentials.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { credentialsQuery, credentialHealthQuery } from "@/api/queries.ts";
import type { ProviderId } from "@/api/types.ts";
import { PROVIDER_IDS } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { ProviderGroup } from "@/features/credentials/ProviderGroup.tsx";

export function CredentialsScreen({ now }: { now: number }) {
  const credentials = useQuery(credentialsQuery());
  const health = useQuery(credentialHealthQuery());
  const [pendingProvider, setPendingProvider] = useState<ProviderId | null>(null);

  if (credentials.isPending) return <p className="text-sm opacity-70">Loading accounts…</p>;
  if (credentials.isError) {
    return <ErrorState error={credentials.error} onRetry={() => credentials.refetch()} />;
  }

  return (
    <div className="space-y-8">
      <h1 className="text-lg font-semibold tracking-tight">Credentials</h1>

      {PROVIDER_IDS.map((provider) => (
        <ProviderGroup
          key={provider}
          provider={provider}
          credentials={credentials.data.filter((c) => c.provider === provider)}
          health={health.data?.health ?? []}
          quota={health.data?.quota ?? []}
          now={now}
          onAdd={setPendingProvider}
        />
      ))}

      {/* Task 7 replaces this with <ConnectDialog />. */}
      {pendingProvider !== null && null}
    </div>
  );
}

export const Route = createFileRoute("/_app/credentials")({
  component: () => <CredentialsScreen now={Date.now()} />,
});
```

- [ ] **Step 8: Add the health query**

Append to `apps/dashboard/src/api/queries.ts`, and add `CredentialHealthResponse` to the import list from `./types.ts`:

```ts
/**
 * Health and quota for every credential.
 *
 * Served by `GET /api/credentials/health`, which Task 12 adds to the gateway.
 * Until then this 501s against the stub and the screen renders accounts with
 * no health pill detail — deliberately degraded rather than broken.
 */
export function credentialHealthQuery() {
  return queryOptions({
    queryKey: qk.credentialHealth(),
    queryFn: () => api.get<CredentialHealthResponse>("/api/credentials/health"),
    // Health moves on every request; a long stale window makes the pill lie.
    staleTime: 2_000,
    retry: false,
  });
}
```

Add to `qk` in the same file:

```ts
  credentialHealth: () => ["credentials", "health"] as const,
```

Add to `apps/dashboard/src/api/types.ts`:

```ts
/** `GET /api/credentials/health` — added to the gateway in Task 12. */
export type CredentialHealthResponse = { health: CredentialHealth[]; quota: QuotaWindow[] };
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun test apps/dashboard`
Expected: 40 pass, 0 fail.

- [ ] **Step 10: Commit**

```bash
git add apps/dashboard
git commit -m "feat(dashboard): add the credentials screen with health, quota and inline editing"
```

---

## Task 7: The connect dialog — PKCE redirect, manual paste, and device code

**Files:**
- Create: `apps/dashboard/src/features/credentials/ConnectDialog.tsx`
- Modify: `apps/dashboard/src/routes/_app.credentials.tsx` (mount the dialog)
- Test: `apps/dashboard/test/features/connect.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 2); `ConnectStart`, `ConnectFinish`, `ConnectPoll`, `ProviderId`, `PROVIDER_LABELS` (Task 2); `qk`, `useInvalidate` (Task 3); `ErrorState` (Task 4); `CredentialsScreen` (Task 6).
- Produces: `ConnectDialog({ provider, onClose, openWindow? })` — the whole OAuth UI for all three flows.

Three flows, one dialog, driven entirely by `POST /api/connect/start`'s response:

| `kind` | `supportsManualPaste` | UI |
| --- | --- | --- |
| `pkce` | `true` | Step 1 opens `authorizeUrl`. Step 2 offers both: wait for the browser redirect to complete server-side, or paste the code into a field that POSTs `/api/connect/finish`. |
| `pkce` | `false` | Redirect only. The dialog polls the credential list until the account appears. |
| `device` | `false` | Show `userCode`, open `authorizeUrl`, and poll `/api/connect/poll` at `pollIntervalMs` until it returns `status: "complete"`. |

The redirect path completes **server-side**: `GET /oauth/callback` exchanges the code and writes the credential, then renders its own HTML page. The dialog therefore cannot observe that completion directly — it watches for the new credential to appear in the refetched list. That is why redirect mode polls the credential list rather than `/api/connect/poll`, which is device-code's endpoint and consumes the pending flow.

`window.open` is injected as `openWindow` so a test can assert the URL without a real popup.

- [ ] **Step 1: Write the failing test**

`apps/dashboard/test/features/connect.test.tsx`:

```tsx
import { afterEach, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectDialog } from "../../src/features/credentials/ConnectDialog.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PKCE_START = {
  flowId: "flow-1",
  authorizeUrl: "https://claude.ai/authorize?state=abc",
  userCode: null,
  kind: "pkce" as const,
  supportsManualPaste: true,
  pollIntervalMs: 5_000,
};

const DEVICE_START = {
  flowId: "flow-2",
  authorizeUrl: "https://www.kimi.com/device",
  userCode: "WDJB-MJHT",
  kind: "device" as const,
  supportsManualPaste: false,
  pollIntervalMs: 1_000,
};

test("starting a flow posts the provider and the operator's label", async () => {
  const stub = createFetchStub({ "POST /api/connect/start": () => PKCE_START });
  renderWithProviders(
    <ConnectDialog provider="anthropic" onClose={() => {}} openWindow={() => {}} />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  await waitFor(() => expect(stub.calls.some((c) => c.url === "/api/connect/start")).toBe(true));
  expect(stub.calls.find((c) => c.url === "/api/connect/start")?.init?.body).toBe(
    JSON.stringify({ provider: "anthropic", label: "work" }),
  );
});

test("a pkce flow opens the authorize url and offers the paste field", async () => {
  createFetchStub({ "POST /api/connect/start": () => PKCE_START });
  const opened: string[] = [];
  renderWithProviders(
    <ConnectDialog provider="anthropic" onClose={() => {}} openWindow={(url) => opened.push(url)} />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  await waitFor(() => expect(opened).toEqual(["https://claude.ai/authorize?state=abc"]));
  expect(await screen.findByLabelText(/authorization code/i)).toBeDefined();
});

test("pasting a code posts finish with the flow id and closes on success", async () => {
  const stub = createFetchStub({
    "POST /api/connect/start": () => PKCE_START,
    "POST /api/connect/finish": () => ({ id: "cred-9" }),
  });
  let closed = false;
  renderWithProviders(
    <ConnectDialog provider="anthropic" onClose={() => { closed = true; }} openWindow={() => {}} />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));
  await screen.findByLabelText(/authorization code/i);

  await user.type(screen.getByLabelText(/authorization code/i), "the-auth-code");
  await user.click(screen.getByRole("button", { name: /^connect$/i }));

  await waitFor(() => expect(closed).toBe(true));
  expect(stub.calls.find((c) => c.url === "/api/connect/finish")?.init?.body).toBe(
    JSON.stringify({ flowId: "flow-1", code: "the-auth-code" }),
  );
});

test("a rejected code keeps the dialog open and shows the gateway's message", async () => {
  createFetchStub({
    "POST /api/connect/start": () => PKCE_START,
    "POST /api/connect/finish": () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "unknown or expired authorization" } },
    }),
  });
  let closed = false;
  renderWithProviders(
    <ConnectDialog provider="anthropic" onClose={() => { closed = true; }} openWindow={() => {}} />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));
  await screen.findByLabelText(/authorization code/i);
  await user.type(screen.getByLabelText(/authorization code/i), "bad");
  await user.click(screen.getByRole("button", { name: /^connect$/i }));

  expect(await screen.findByText(/unknown or expired authorization/i)).toBeDefined();
  expect(closed).toBe(false);
});

test("a device flow shows the user code and does not offer a paste field", async () => {
  createFetchStub({
    "POST /api/connect/start": () => DEVICE_START,
    "POST /api/connect/poll": () => ({ status: 202, body: { status: "pending" } }),
  });
  renderWithProviders(<ConnectDialog provider="kimi" onClose={() => {}} openWindow={() => {}} />);

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "kimi one");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  expect(await screen.findByText("WDJB-MJHT")).toBeDefined();
  expect(screen.queryByLabelText(/authorization code/i)).toBeNull();
  expect(screen.getByText(/waiting for approval/i)).toBeDefined();
});

test("a device flow polls until it completes and then closes", async () => {
  let polls = 0;
  createFetchStub({
    "POST /api/connect/start": () => DEVICE_START,
    "POST /api/connect/poll": () => {
      polls += 1;
      return polls < 2
        ? { status: 202, body: { status: "pending" } }
        : { status: 200, body: { status: "complete", id: "cred-7" } };
    },
  });
  let closed = false;
  renderWithProviders(
    <ConnectDialog provider="kimi" onClose={() => { closed = true; }} openWindow={() => {}} />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "kimi one");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));
  await screen.findByText("WDJB-MJHT");

  await waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
  expect(polls).toBeGreaterThanOrEqual(2);
});

test("a device flow that errors stops polling and reports why", async () => {
  createFetchStub({
    "POST /api/connect/start": () => DEVICE_START,
    "POST /api/connect/poll": () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "the device code expired" } },
    }),
  });
  renderWithProviders(<ConnectDialog provider="kimi" onClose={() => {}} openWindow={() => {}} />);

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "kimi one");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  expect(await screen.findByText(/the device code expired/i)).toBeDefined();
});

test("a redirect-only pkce provider omits the paste field entirely", async () => {
  createFetchStub({
    "POST /api/connect/start": () => ({ ...PKCE_START, supportsManualPaste: false }),
    "GET /api/credentials": () => ({ credentials: [] }),
  });
  renderWithProviders(
    <ConnectDialog provider="openai" onClose={() => {}} openWindow={() => {}} />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "codex");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  expect(await screen.findByText(/finish signing in/i)).toBeDefined();
  expect(screen.queryByLabelText(/authorization code/i)).toBeNull();
});

test("a start failure surfaces before any window is opened", async () => {
  createFetchStub({
    "POST /api/connect/start": () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "provider must be one of anthropic, openai, kimi" } },
    }),
  });
  const opened: string[] = [];
  renderWithProviders(
    <ConnectDialog provider="anthropic" onClose={() => {}} openWindow={(url) => opened.push(url)} />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  expect(await screen.findByText(/provider must be one of/i)).toBeDefined();
  expect(opened).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/dashboard/test/features/connect.test.tsx`
Expected: FAIL — cannot resolve `../../src/features/credentials/ConnectDialog.tsx`.

- [ ] **Step 3: Write the dialog**

`apps/dashboard/src/features/credentials/ConnectDialog.tsx`:

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { credentialsQuery, qk, useInvalidate } from "@/api/queries.ts";
import type {
  ConnectFinish,
  ConnectPoll,
  ConnectStart,
  ProviderId,
} from "@/api/types.ts";
import { PROVIDER_LABELS } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

export function ConnectDialog({
  provider,
  onClose,
  openWindow = (url: string) => {
    globalThis.open(url, "_blank", "noopener,noreferrer");
  },
}: {
  provider: ProviderId;
  onClose: () => void;
  openWindow?: (url: string) => void;
}) {
  const invalidate = useInvalidate();
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [flow, setFlow] = useState<ConnectStart | null>(null);

  const start = useMutation({
    mutationFn: () =>
      api.post<ConnectStart>("/api/connect/start", { provider, label: label.trim() }),
    onSuccess: (started) => {
      setFlow(started);
      // Opened only after the server minted a flow: a failed start must not
      // send the operator to a provider consent screen that leads nowhere.
      openWindow(started.authorizeUrl);
    },
  });

  async function settle(): Promise<void> {
    await invalidate([qk.credentials(), qk.credentialHealth()]);
    onClose();
  }

  const finish = useMutation({
    mutationFn: () =>
      api.post<ConnectFinish>("/api/connect/finish", {
        flowId: (flow as ConnectStart).flowId,
        code: code.trim(),
      }),
    onSuccess: settle,
  });

  // Device code: the gateway answers 202 while the operator has not approved.
  const poll = useQuery({
    queryKey: ["connect", "poll", flow?.flowId ?? "none"],
    queryFn: () =>
      api.post<ConnectPoll>("/api/connect/poll", { flowId: (flow as ConnectStart).flowId }),
    enabled: flow !== null && flow.kind === "device",
    refetchInterval: flow?.pollIntervalMs ?? 5_000,
    retry: false,
    staleTime: 0,
  });

  if (poll.data?.status === "complete") {
    void settle();
  }

  // Redirect-only PKCE completes inside /oauth/callback, so the dialog cannot
  // observe it. It watches for the credential list to grow instead.
  const watching = flow !== null && flow.kind === "pkce" && !flow.supportsManualPaste;
  const credentials = useQuery({ ...credentialsQuery(), enabled: watching, refetchInterval: 2_000 });
  const [baseline, setBaseline] = useState<number | null>(null);
  if (watching && baseline === null && credentials.data !== undefined) {
    setBaseline(credentials.data.length);
  }
  if (watching && baseline !== null && (credentials.data?.length ?? 0) > baseline) {
    void settle();
  }

  return (
    <div role="dialog" aria-label={`Connect ${PROVIDER_LABELS[provider]}`} className="mt-6">
      <Card className="max-w-lg p-5">
        <h2 className="text-sm font-semibold">Connect {PROVIDER_LABELS[provider]}</h2>

        {flow === null ? (
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="connect-label">Label</Label>
              <Input
                id="connect-label"
                value={label}
                placeholder="work"
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            {start.isError && <ErrorState error={start.error} />}
            <div className="flex gap-2">
              <Button disabled={start.isPending} onClick={() => start.mutate()}>
                Start authorization
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        ) : flow.kind === "device" ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm">Enter this code at the provider:</p>
            <p className="font-mono text-2xl tracking-widest">{flow.userCode}</p>
            <p className="text-sm opacity-70">
              A browser tab was opened at <span className="break-all">{flow.authorizeUrl}</span>.
            </p>
            {poll.isError ? (
              <ErrorState error={poll.error} />
            ) : (
              <p className="text-sm opacity-70">Waiting for approval…</p>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        ) : flow.supportsManualPaste ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm">
              Approve access in the tab that opened. If the redirect back here did not work, paste
              the authorization code below.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="connect-code">Authorization code</Label>
              <Input id="connect-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            {finish.isError && <ErrorState error={finish.error} />}
            <div className="flex gap-2">
              <Button
                disabled={code.trim().length === 0 || finish.isPending}
                onClick={() => finish.mutate()}
              >
                Connect
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-sm">Finish signing in in the tab that opened.</p>
            <p className="text-sm opacity-70">
              This dialog closes on its own once the account is connected.
            </p>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Mount the dialog on the credentials screen**

In `apps/dashboard/src/routes/_app.credentials.tsx`, replace the placeholder line:

```tsx
      {/* Task 7 replaces this with <ConnectDialog />. */}
      {pendingProvider !== null && null}
```

with:

```tsx
      {pendingProvider !== null && (
        <ConnectDialog provider={pendingProvider} onClose={() => setPendingProvider(null)} />
      )}
```

and add the import:

```tsx
import { ConnectDialog } from "@/features/credentials/ConnectDialog.tsx";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test apps/dashboard`
Expected: 49 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard
git commit -m "feat(dashboard): add the oauth connect dialog for pkce, paste and device flows"
```

---
