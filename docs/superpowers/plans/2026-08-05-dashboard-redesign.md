# OmniGateway Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign OmniGateway's complete admin dashboard as a responsive, accessible operator workspace with independent light and dark themes and task-appropriate layouts.

**Architecture:** Keep existing routes, TanStack Query ownership, API client, and feature behavior. Add a small client-only theme module and focused shared presentation components, then migrate shell and routes one vertical slice at a time. Shared components remain prop-driven; route and feature components continue owning queries and mutations.

**Tech Stack:** React 19.2, TypeScript strict, TanStack Router 1.170, TanStack Query 5.101, Tailwind CSS 4.3, shadcn/ui primitives, Lucide React 1.28, Recharts 3.10, Bun test, React Testing Library, happy-dom.

**Design spec:** `docs/superpowers/specs/2026-08-05-dashboard-redesign-design.md`

## Global Constraints

- Preserve every existing `/api/*` contract, query key, session-expiry path, and three-second log-polling semantic.
- Add no WebSocket, dashboard overview route, API field, charting library, or component framework.
- Route and feature components own TanStack Query calls; shared visual components fetch no data.
- Theme modes are exactly `system`, `light`, and `dark`; first visit follows OS and explicit choice persists in local storage.
- Optimize desktop at 1280px and above; every workflow remains usable below 768px.
- Status uses text plus icon or shape; color alone never carries meaning.
- Use monospace text and tabular numerals for model IDs, key prefixes, request IDs, timings, tokens, quotas, and costs.
- Usage charts use one axis, exact-value tooltips, a legend for two or more series, validated light/dark colors, and a semantic table equivalent.
- Never persist or log raw API keys, provider secrets, tokens, prompts, or responses.
- Strict TypeScript remains enabled with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; commit no `any`, including tests.
- Use explicit `.ts` and `.tsx` ESM import extensions matching surrounding code.
- Match Biome's two-space indentation and 100-column target.
- Run focused tests after each task. Before completion run full `bun test`, `bun run typecheck`, `bun run lint`, dashboard build, and real-app visual inspection.

---

## File Structure

### New shared units

- `apps/dashboard/src/theme/theme.ts`: pure theme parsing/resolution plus DOM application and persistence.
- `apps/dashboard/src/theme/ThemeProvider.tsx`: React context, media-query subscription, and theme mutation.
- `apps/dashboard/src/components/ThemeToggle.tsx`: accessible three-mode theme control.
- `apps/dashboard/src/components/PageHeader.tsx`: consistent title, description, and action layout.
- `apps/dashboard/src/components/StatTile.tsx`: text-led metric tile.
- `apps/dashboard/src/components/StatusBadge.tsx`: semantic status label with non-color marker.
- `apps/dashboard/src/components/EmptyState.tsx`: explanation plus optional action.
- `apps/dashboard/src/components/LoadingSkeleton.tsx`: geometry-preserving loading primitives.
- `apps/dashboard/src/components/DataTableFrame.tsx`: table overflow, border, and sticky-header wrapper.
- `apps/dashboard/src/components/NavDrawer.tsx`: mobile navigation dialog/drawer with focus restoration.

### Existing files to modify

- `apps/dashboard/index.html`: apply saved/resolved theme before application startup.
- `apps/dashboard/src/main.tsx`: install `ThemeProvider` around router.
- `apps/dashboard/src/index.css`: replace generic grayscale tokens with complete light/dark operator palette and shared utility classes.
- `apps/dashboard/src/components/AppShell.tsx`: responsive sidebar/top bar, route icons, drawer, theme toggle, and sign-out placement.
- `apps/dashboard/src/components/Health.tsx`: use shared semantic status badge.
- `apps/dashboard/src/components/QuotaBar.tsx`: semantic labels, accessible progress metadata, and refined marks.
- `apps/dashboard/src/components/ErrorState.tsx`: shared inline alert styling and retry placement.
- `apps/dashboard/src/routes/login.tsx`: split desktop authentication composition and visible setup guidance.
- `apps/dashboard/src/routes/_app.credentials.tsx`: page header, summary metrics, loading and error geometry.
- `apps/dashboard/src/features/credentials/ProviderGroup.tsx`: provider panel and compact empty state.
- `apps/dashboard/src/features/credentials/CredentialCard.tsx`: operational row hierarchy.
- `apps/dashboard/src/routes/_app.models.tsx`: searchable master-detail layout.
- `apps/dashboard/src/features/models/ModelEditor.tsx`: editor surface hierarchy.
- `apps/dashboard/src/features/models/TargetRow.tsx`: ordered route-block presentation.
- `apps/dashboard/src/features/models/DryRunPanel.tsx`: collapsible explanation region.
- `apps/dashboard/src/routes/_app.usage.tsx`: page controls, four-tile summary, chart/table structure.
- `apps/dashboard/src/features/usage/StatCards.tsx`: use shared four-tile presentation.
- `apps/dashboard/src/features/usage/UsageChart.tsx`: responsive chart, metric support, theme-safe palette and tooltip.
- `apps/dashboard/src/routes/_app.logs.tsx`: sticky live toolbar and table frame.
- `apps/dashboard/src/features/logs/LogRow.tsx`: status marker, monospace data, inline details.
- `apps/dashboard/src/routes/_app.keys.tsx`: page header, table frame, states.
- `apps/dashboard/src/features/keys/KeyRow.tsx`: management-row hierarchy.
- `apps/dashboard/src/features/keys/MintKeyDialog.tsx`: focused one-time secret reveal and copy state.

### Tests

- Create `apps/dashboard/test/theme/theme.test.ts`.
- Create `apps/dashboard/test/components/shared.test.tsx`.
- Modify `apps/dashboard/test/smoke.test.tsx`.
- Modify `apps/dashboard/test/auth-integration.test.tsx`.
- Modify `apps/dashboard/test/routes/login.test.tsx`.
- Modify existing feature tests under `apps/dashboard/test/features/` for each migrated route.

---

### Task 1: Theme Foundation and Operator Tokens

**Files:**
- Create: `apps/dashboard/src/theme/theme.ts`
- Create: `apps/dashboard/src/theme/ThemeProvider.tsx`
- Create: `apps/dashboard/src/components/ThemeToggle.tsx`
- Create: `apps/dashboard/test/theme/theme.test.ts`
- Modify: `apps/dashboard/index.html`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/index.css`
- Modify: `apps/dashboard/test/smoke.test.tsx`

**Interfaces:**
- Produces: `type ThemeMode = "system" | "light" | "dark"`
- Produces: `parseThemeMode(value: string | null): ThemeMode`
- Produces: `resolveTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark"`
- Produces: `applyTheme(mode: ThemeMode, prefersDark: boolean, root?: HTMLElement): void`
- Produces: `ThemeProvider({ children }: { children: ReactNode }): JSX.Element`
- Produces: `useTheme(): { mode: ThemeMode; resolved: "light" | "dark"; setMode(mode: ThemeMode): void }`
- Produces: `ThemeToggle(): JSX.Element`

- [ ] **Step 1: Write pure theme tests**

Create `apps/dashboard/test/theme/theme.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { applyTheme, parseThemeMode, resolveTheme, THEME_STORAGE_KEY } from "../../src/theme/theme.ts";

afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

test("invalid or absent theme preferences use system", () => {
  expect(parseThemeMode(null)).toBe("system");
  expect(parseThemeMode("sepia")).toBe("system");
});

test("system theme resolves from media preference", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});

test("applying theme updates root without replacing unrelated classes", () => {
  document.documentElement.classList.add("test-class");
  applyTheme("dark", false);
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.classList.contains("test-class")).toBe(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test apps/dashboard/test/theme/theme.test.ts`

Expected: FAIL resolving `../../src/theme/theme.ts`.

- [ ] **Step 3: Implement pure theme functions**

Create `apps/dashboard/src/theme/theme.ts`:

```ts
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "omni-theme";

export function parseThemeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

export function applyTheme(
  mode: ThemeMode,
  prefersDark: boolean,
  root: HTMLElement = document.documentElement,
): void {
  const resolved = resolveTheme(mode, prefersDark);
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  localStorage.setItem(THEME_STORAGE_KEY, mode);
}
```

- [ ] **Step 4: Run pure theme tests**

Run: `bun test apps/dashboard/test/theme/theme.test.ts`

Expected: PASS.

- [ ] **Step 5: Write provider and toggle tests**

Extend `apps/dashboard/test/theme/theme.test.ts` with a controllable `matchMedia` stub. Render `ThemeProvider` and `ThemeToggle`, then assert:

```ts
expect(screen.getByRole("button", { name: /theme: system/i })).toBeDefined();
await user.click(screen.getByRole("button", { name: /theme: system/i }));
await user.click(screen.getByRole("menuitemradio", { name: /dark/i }));
expect(document.documentElement.classList.contains("dark")).toBe(true);
expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
```

Also test system-mode media changes update the resolved class, while explicit light mode ignores later media changes.

- [ ] **Step 6: Run provider test and verify failure**

Run: `bun test apps/dashboard/test/theme/theme.test.ts`

Expected: FAIL resolving `ThemeProvider.tsx` or `ThemeToggle.tsx`.

- [ ] **Step 7: Implement provider and accessible toggle**

Create `ThemeProvider.tsx` with one context, lazy preference initialization, one `matchMedia("(prefers-color-scheme: dark)")` subscription, and cleanup. `setMode` calls `applyTheme`; system preference changes only update resolved theme when current mode is `system`.

Create `ThemeToggle.tsx` using existing Radix/shadcn primitives if a menu primitive exists; otherwise use one labeled button that cycles `system → light → dark → system`. Preserve exact accessible name `Theme: <mode>` and show Lucide `Monitor`, `Sun`, or `Moon` plus visible desktop label.

- [ ] **Step 8: Prevent startup theme flash**

Add a short inline script in `apps/dashboard/index.html` before dashboard module script. It reads only `omni-theme`, validates values, resolves system through `matchMedia`, and toggles `dark` plus `data-theme`. It must not write storage or interpolate user content.

Wrap existing providers/router with `ThemeProvider` in `src/main.tsx`.

- [ ] **Step 9: Replace token system**

Update `index.css` with independently chosen light/dark OKLCH tokens:

```css
:root {
  color-scheme: light;
  --background: oklch(0.975 0.004 265);
  --foreground: oklch(0.22 0.018 265);
  --card: oklch(1 0 0);
  --card-foreground: var(--foreground);
  --surface-subtle: oklch(0.955 0.007 265);
  --primary: oklch(0.51 0.19 270);
  --primary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.945 0.008 265);
  --muted-foreground: oklch(0.49 0.018 265);
  --border: oklch(0.89 0.012 265);
  --ring: oklch(0.58 0.17 270);
  --ok: oklch(0.56 0.15 150);
  --warn: oklch(0.66 0.15 80);
  --bad: oklch(0.58 0.2 27);
  --info: oklch(0.57 0.15 245);
  --radius: 0.75rem;
}

.dark {
  color-scheme: dark;
  --background: oklch(0.17 0.012 265);
  --foreground: oklch(0.94 0.008 265);
  --card: oklch(0.205 0.014 265);
  --card-foreground: var(--foreground);
  --surface-subtle: oklch(0.23 0.015 265);
  --primary: oklch(0.7 0.16 270);
  --primary-foreground: oklch(0.17 0.012 265);
  --muted: oklch(0.255 0.014 265);
  --muted-foreground: oklch(0.7 0.012 265);
  --border: oklch(0.32 0.014 265);
  --ring: oklch(0.72 0.14 270);
  --ok: oklch(0.72 0.14 150);
  --warn: oklch(0.78 0.14 80);
  --bad: oklch(0.7 0.18 27);
  --info: oklch(0.72 0.13 245);
}
```

Map all new tokens through `@theme inline`, add UI and monospace font stacks, global focus visibility, body canvas, tabular utility, reduced-motion overrides, and selected chart tokens. Adjust exact values only if later contrast/palette validation fails.

- [ ] **Step 10: Extend stylesheet smoke assertions**

Update `smoke.test.tsx` to assert `--surface-subtle`, `--info`, `color-scheme: dark`, and reduced-motion rule exist.

- [ ] **Step 11: Run task verification**

Run:

```bash
bun test apps/dashboard/test/theme/theme.test.ts apps/dashboard/test/smoke.test.tsx
bun run --cwd apps/dashboard typecheck
```

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 12: Commit**

```bash
git add apps/dashboard/index.html apps/dashboard/src/main.tsx apps/dashboard/src/index.css \
  apps/dashboard/src/theme apps/dashboard/src/components/ThemeToggle.tsx \
  apps/dashboard/test/theme apps/dashboard/test/smoke.test.tsx
git commit -m "feat(dashboard): add adaptive theme system"
```

---

### Task 2: Shared Presentation Components

**Files:**
- Create: `apps/dashboard/src/components/PageHeader.tsx`
- Create: `apps/dashboard/src/components/StatTile.tsx`
- Create: `apps/dashboard/src/components/StatusBadge.tsx`
- Create: `apps/dashboard/src/components/EmptyState.tsx`
- Create: `apps/dashboard/src/components/LoadingSkeleton.tsx`
- Create: `apps/dashboard/src/components/DataTableFrame.tsx`
- Create: `apps/dashboard/test/components/shared.test.tsx`
- Modify: `apps/dashboard/src/components/ErrorState.tsx`

**Interfaces:**
- Consumes: existing `cn(...inputs): string`, `Button`, and semantic color tokens.
- Produces: `PageHeader({ title, description, actions, eyebrow? }): JSX.Element`
- Produces: `StatTile({ label, value, detail?, tone? }): JSX.Element`
- Produces: `StatusTone = "ok" | "warn" | "bad" | "info" | "muted"`
- Produces: `StatusBadge({ label, tone }): JSX.Element`
- Produces: `EmptyState({ title, description, action? }): JSX.Element`
- Produces: `LoadingSkeleton({ className? }): JSX.Element`
- Produces: `DataTableFrame({ children, ariaLabel? }): JSX.Element`

- [ ] **Step 1: Write component contract tests**

Create `shared.test.tsx` with these assertions:

```tsx
render(<PageHeader title="Credentials" description="Manage provider accounts." actions={<button>Connect provider</button>} />);
expect(screen.getByRole("heading", { level: 1, name: "Credentials" })).toBeDefined();
expect(screen.getByRole("button", { name: "Connect provider" })).toBeDefined();

render(<StatusBadge label="Rate limited" tone="warn" />);
const status = screen.getByText("Rate limited");
expect(status.closest("span")?.querySelector("svg, [aria-hidden=true]")).not.toBeNull();

render(<StatTile label="Requests" value="1,240" detail="Last 24 hours" />);
expect(within(screen.getByRole("group", { name: "Requests" })).getByText("1,240")).toBeDefined();

render(<EmptyState title="No models" description="Create a virtual model." action={<button>Create model</button>} />);
expect(screen.getByRole("button", { name: "Create model" })).toBeDefined();
```

Also assert `DataTableFrame` exposes a named region when `ariaLabel` is provided and `LoadingSkeleton` has `aria-hidden="true"`.

- [ ] **Step 2: Run test and verify failure**

Run: `bun test apps/dashboard/test/components/shared.test.tsx`

Expected: FAIL resolving new components.

- [ ] **Step 3: Implement minimal focused components**

Use semantic HTML and narrow props. `StatusBadge` maps tones to class strings and uses Lucide `CircleCheck`, `TriangleAlert`, `CircleX`, `Info`, or `Circle` with `aria-hidden`. `StatTile` uses `role="group"` and `aria-label={label}`, not `fieldset`, because metric labels are not form controls. `DataTableFrame` wraps children in a rounded, bordered, horizontally scrollable region; tables own table semantics.

- [ ] **Step 4: Standardize error state**

Keep existing `ErrorState` API. Render `role="alert"`, `CircleAlert`, safe error text, and optional retry action in an inline bounded surface. Do not infer destructive tone from arbitrary message text.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
bun test apps/dashboard/test/components/shared.test.tsx apps/dashboard/test/api/client.test.ts
bun run --cwd apps/dashboard typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components apps/dashboard/test/components/shared.test.tsx
git commit -m "feat(dashboard): add operator UI primitives"
```

---

### Task 3: Responsive Application Shell

**Files:**
- Create: `apps/dashboard/src/components/NavDrawer.tsx`
- Modify: `apps/dashboard/src/components/AppShell.tsx`
- Modify: `apps/dashboard/test/auth-integration.test.tsx`

**Interfaces:**
- Consumes: `ThemeToggle`, existing `NAV_ITEMS`, `Button`, router `Link`, logout mutation.
- Produces: `NavItem = { to: string; label: string; icon: LucideIcon }`
- Produces: `NavDrawer({ open, onOpenChange, items }): JSX.Element`
- Preserves: `requireSession(queryClient): Promise<void>` and `STATUS_KEY` exports.

- [ ] **Step 1: Add shell behavior tests**

Extend `auth-integration.test.tsx` or create a focused shell describe block that renders `AppShell` inside a memory router. Assert:

```ts
expect(screen.getByRole("navigation", { name: /primary/i })).toBeDefined();
expect(screen.getByRole("link", { name: /credentials/i }).getAttribute("aria-current")).toBe("page");
expect(screen.getByRole("button", { name: /open navigation/i })).toBeDefined();
expect(screen.getByRole("button", { name: /theme:/i })).toBeDefined();
```

Click mobile navigation trigger, assert dialog navigation appears, choose `Logs`, and assert drawer closes. Click sign out and preserve existing logout/cache-clear/redirect expectations.

- [ ] **Step 2: Run focused test and verify failure**

Run: `bun test apps/dashboard/test/auth-integration.test.tsx`

Expected: FAIL because current shell has no named navigation trigger, icons, top bar, or drawer.

- [ ] **Step 3: Implement nav data and shared link rendering**

Add Lucide icons to `NAV_ITEMS`: `KeyRound`, `Waypoints`, `ChartNoAxesCombined`, `ScrollText`, and `ShieldCheck`. Create a private `NavLinks` component used by desktop rail and drawer so active-state, accessible naming, and route list cannot diverge.

- [ ] **Step 4: Implement desktop shell**

Refactor `AppShell` to:

- Use `min-h-screen bg-background text-foreground`.
- Render 240px `aside` hidden below `md`.
- Render branded header, named primary navigation, lower status slot only when real status data exists, theme toggle, and sign-out.
- Render content column with sticky compact top bar and responsive page padding.
- Keep logout mutation and cache clearing byte-for-byte equivalent in behavior.

- [ ] **Step 5: Implement mobile drawer**

Build `NavDrawer` from existing Radix dialog primitive. Trigger remains in `AppShell`; content contains product name, same `NavLinks`, theme control, and sign-out. On route selection call `onOpenChange(false)`. Verify dialog focus trap and trigger focus restoration through Radix behavior rather than custom document listeners.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
bun test apps/dashboard/test/auth-integration.test.tsx apps/dashboard/test/routes/guard.test.tsx
bun run --cwd apps/dashboard typecheck
```

Expected: PASS; route guard and session handling unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/AppShell.tsx apps/dashboard/src/components/NavDrawer.tsx \
  apps/dashboard/test/auth-integration.test.tsx
git commit -m "feat(dashboard): redesign responsive app shell"
```

---

### Task 4: Authentication and Common Page States

**Files:**
- Modify: `apps/dashboard/src/routes/login.tsx`
- Modify: `apps/dashboard/test/routes/login.test.tsx`

**Interfaces:**
- Consumes: existing `LoginScreen({ onAuthenticated })`, status query, login/setup mutations, shared `LoadingSkeleton` and `ErrorState`.
- Preserves: minimum password length of 12 and redirect to `/credentials`.

- [ ] **Step 1: Add login/setup presentation tests**

Extend `login.test.tsx`:

```ts
expect(await screen.findByRole("heading", { name: /sign in/i })).toBeDefined();
expect(screen.getByText(/route requests across provider accounts/i)).toBeDefined();
expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
```

For setup state, assert visible pre-submit text says `At least 12 characters`, confirm field exists, mismatch remains an alert, and typed password remains after failed server mutation.

- [ ] **Step 2: Run login tests and verify failure**

Run: `bun test apps/dashboard/test/routes/login.test.tsx`

Expected: FAIL on new identity and password-guidance text.

- [ ] **Step 3: Implement split authentication composition**

Use a two-column desktop grid and one-column mobile layout. Left identity panel contains product mark, `OmniGateway`, and one concise purpose sentence. Right panel contains existing form logic in a focused surface. Render loading skeleton rather than bare text. Keep setup guidance visible beneath password label before submit; do not add password-strength scoring or new rules.

- [ ] **Step 4: Run authentication tests**

Run:

```bash
bun test apps/dashboard/test/routes/login.test.tsx apps/dashboard/test/auth-integration.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/routes/login.tsx apps/dashboard/test/routes/login.test.tsx
git commit -m "feat(dashboard): refine authentication workspace"
```

---

### Task 5: Credentials Operator Workspace

**Files:**
- Modify: `apps/dashboard/src/routes/_app.credentials.tsx`
- Modify: `apps/dashboard/src/features/credentials/ProviderGroup.tsx`
- Modify: `apps/dashboard/src/features/credentials/CredentialCard.tsx`
- Modify: `apps/dashboard/src/components/Health.tsx`
- Modify: `apps/dashboard/src/components/QuotaBar.tsx`
- Modify: `apps/dashboard/test/features/credentials.test.tsx`
- Modify: `apps/dashboard/test/features/connect.test.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `StatTile`, `StatusBadge`, `EmptyState`, `LoadingSkeleton`.
- Produces: pure `credentialSummary(credentials, health, quota, now)` returning `{ connected; healthy; impaired; quotaWarnings }`.
- Preserves: `summarizeHealth(rows, now): HealthSummary`, provider-specific add callbacks, OAuth connect behavior, save/delete mutations.

- [ ] **Step 1: Add summary and status tests**

In `credentials.test.tsx`, test pure summary data with healthy, rate-limited, breaker-open, and 90%-used quota fixtures:

```ts
expect(credentialSummary(credentials, health, quota, NOW)).toEqual({
  connected: 3,
  healthy: 1,
  impaired: 2,
  quotaWarnings: 1,
});
```

Render screen and assert four named stat groups, one heading per provider, status text, and `Connect provider` action. Assert a provider with no credentials says `No Anthropic accounts connected` and exposes `Add Anthropic account`.

- [ ] **Step 2: Run credential tests and verify failure**

Run: `bun test apps/dashboard/test/features/credentials.test.tsx`

Expected: FAIL because `credentialSummary` and summary UI do not exist.

- [ ] **Step 3: Implement pure summary**

Count each credential once. A credential is healthy only when health is available, no row is breaker-open, and no row has active rate limit. Count impaired credentials for active rate-limit or open breaker. Count quota warnings by unique credential with any finite quota at or above 90%. Do not count missing health as healthy.

- [ ] **Step 4: Implement page hierarchy and loading geometry**

Use `PageHeader`; primary action opens provider selection using existing connect flow without adding API behavior. Render four `StatTile`s. Replace loading text with provider-section skeletons. Keep query error retry. Provider group renders a bounded panel only because each provider is a discrete object group.

- [ ] **Step 5: Refine credential rows and status components**

Keep all fields and mutation controls. Reorder presentation to identity, `StatusBadge` health, tier/weight, quota, then actions. Convert `HealthPill` to shared `StatusBadge` plus detail. Give `QuotaBar` `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow={percent}`, and visible window label/percentage. Keep status text even when bar hue changes.

- [ ] **Step 6: Run credentials and OAuth tests**

Run:

```bash
bun test apps/dashboard/test/features/credentials.test.tsx \
  apps/dashboard/test/features/connect.test.tsx
bun run --cwd apps/dashboard typecheck
```

Expected: PASS; connect callback and mutation payload assertions unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/routes/_app.credentials.tsx \
  apps/dashboard/src/features/credentials apps/dashboard/src/components/Health.tsx \
  apps/dashboard/src/components/QuotaBar.tsx apps/dashboard/test/features/credentials.test.tsx \
  apps/dashboard/test/features/connect.test.tsx
git commit -m "feat(dashboard): redesign credential operations"
```

---

### Task 6: Models Master-Detail Workspace

**Files:**
- Modify: `apps/dashboard/src/routes/_app.models.tsx`
- Modify: `apps/dashboard/src/features/models/ModelEditor.tsx`
- Modify: `apps/dashboard/src/features/models/TargetRow.tsx`
- Modify: `apps/dashboard/src/features/models/DryRunPanel.tsx`
- Modify: `apps/dashboard/test/features/models.test.tsx`
- Modify: `apps/dashboard/test/features/dryrun.test.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `EmptyState`, `LoadingSkeleton`, existing `ModelEditor` callbacks.
- Produces: `filterModels(models: readonly VirtualModel[], query: string): VirtualModel[]` with case-insensitive ID matching.
- Preserves: `blankModel()`, `emptyTarget(provider)`, save/delete payloads, dnd-kit target ordering, dry-run query behavior.

- [ ] **Step 1: Add filter and master-detail tests**

Extend `models.test.tsx`:

```ts
expect(filterModels(models, "SMART").map((model) => model.id)).toEqual(["smart"]);
```

Render two models and assert a search input named `Search models`, navigation/list region named `Virtual models`, editor region named for selected model, and visible alias badge. Type search text and assert nonmatching model disappears. Preserve new-model save, delete, and validation tests.

Add dry-run test asserting details region can collapse and expand without refetching solely because of visual toggle.

- [ ] **Step 2: Run model tests and verify failure**

Run:

```bash
bun test apps/dashboard/test/features/models.test.tsx \
  apps/dashboard/test/features/dryrun.test.tsx
```

Expected: FAIL on `filterModels`, search input, and workspace regions.

- [ ] **Step 3: Implement master list**

Use `PageHeader` with `New model`. Add local search string and pure `filterModels`. Render desktop grid `md:grid-cols-[17rem_minmax(0,1fr)]`; left panel contains search and model buttons with full ID, alias badge, and selected state. Empty filtered state says `No models match` without suggesting creation; truly empty state offers create action.

- [ ] **Step 4: Implement detail workspace**

Render editor in labeled main region. Keep creation and selection state transitions unchanged. Stack list and editor naturally below `md`. Add no viewport JavaScript.

- [ ] **Step 5: Refine target and dry-run presentation**

Style each target as an ordered route block with visible drag handle accessible label, provider, upstream model, weight, and remove controls. Preserve dnd-kit keyboard behavior. Wrap dry run in native `<details>` or existing collapsible primitive, default open after user requests a dry run; visual collapse must not clear query data.

- [ ] **Step 6: Run model suite and typecheck**

Run:

```bash
bun test apps/dashboard/test/features/models.test.tsx \
  apps/dashboard/test/features/dryrun.test.tsx
bun run --cwd apps/dashboard typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/routes/_app.models.tsx apps/dashboard/src/features/models \
  apps/dashboard/test/features/models.test.tsx apps/dashboard/test/features/dryrun.test.tsx
git commit -m "feat(dashboard): add model master detail workspace"
```

---

### Task 7: Accessible Usage Analytics

**Files:**
- Modify: `apps/dashboard/src/routes/_app.usage.tsx`
- Modify: `apps/dashboard/src/features/usage/StatCards.tsx`
- Modify: `apps/dashboard/src/features/usage/UsageChart.tsx`
- Modify: `apps/dashboard/test/features/usage.test.tsx`
- Optionally create only if needed by validator integration: `apps/dashboard/scripts/validate-chart-palette.mjs`

**Interfaces:**
- Consumes: `PageHeader`, `StatTile`, `DataTableFrame`, semantic chart tokens.
- Produces: `UsageMetric = "requests" | "tokens" | "cost" | "errors"`.
- Produces: `chartRows(rows, metric): Array<{ key: string; value: number }>`.
- Preserves: `totals(rows): UsageTotals`, range/group controls, `/api/usage` query params, detailed table.

- [ ] **Step 1: Update analytics tests**

Modify `usage.test.tsx` to expect exactly four metric groups: Requests, Tokens, Estimated cost, Error rate. Keep rate-limit sample context outside the KPI row as secondary operational text if retained. Add test selecting `Errors` metric and assert chart accessible name becomes `Errors chart`. Assert detailed table remains present after metric changes and has a caption or accessible label `Usage breakdown`.

- [ ] **Step 2: Run usage tests and verify failure**

Run: `bun test apps/dashboard/test/features/usage.test.tsx`

Expected: FAIL because current screen has five cards and chart lacks errors metric.

- [ ] **Step 3: Refactor stat tiles**

Keep `totals` unchanged. Replace private fieldset `Stat` with shared `StatTile`; labels exactly `Requests`, `Tokens`, `Estimated cost`, and `Error rate`. Present sampled rate-limit percentage as compact secondary status near page description only when log sample size is nonzero.

- [ ] **Step 4: Refactor chart contract**

Export `chartRows`. Add `errors` case. Use Recharts `ResponsiveContainer` so width follows content while preserving 280px height. Keep one Y axis. Use CSS variables for selected light/dark chart marks and tooltip surface. Ensure exact-value tooltip formatting and rounded 4px data ends. For current single-series bar chart, title supplies series identity and no legend box is needed. If implementation introduces multiple series by grouping, add Recharts `Legend` and cap/fold categories before assigning fixed colors.

- [ ] **Step 5: Refine page and table**

Use `PageHeader`; controls form one wrapping row above chart. Use Tabs for metric choice with accessible labels. Wrap breakdown table in `DataTableFrame`, add caption/accessibility label, sticky header, monospace keys, and tabular numeric cells. Keep sort and query semantics unchanged.

- [ ] **Step 6: Validate chart palette**

From dataviz skill base, validate actual hex equivalents chosen for light and dark categorical/chart marks:

```bash
node /tmp/claude-1000/bundled-skills/2.1.222/5a5940012f558a962c262097c3624363/dataviz/scripts/validate_palette.js \
  "<light-chart-hex-list>" --mode light
node /tmp/claude-1000/bundled-skills/2.1.222/5a5940012f558a962c262097c3624363/dataviz/scripts/validate_palette.js \
  "<dark-chart-hex-list>" --mode dark
```

Before executing this step, replace each angle-bracket argument in these commands with the exact hex values converted from final chart tokens. This is an execution parameter derived from Task 1 output, not production code. Expected: PASS on lightness, chroma, adjacent CVD separation, normal-vision floor, and contrast. If any check fails, adjust chart tokens in `index.css`, rerun both validators, and record final commands and outputs in implementation notes or commit body.

- [ ] **Step 7: Run usage tests and typecheck**

Run:

```bash
bun test apps/dashboard/test/features/usage.test.tsx
bun run --cwd apps/dashboard typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/routes/_app.usage.tsx apps/dashboard/src/features/usage \
  apps/dashboard/src/index.css apps/dashboard/test/features/usage.test.tsx
git commit -m "feat(dashboard): refine usage analytics"
```

---

### Task 8: Live Logs Workspace

**Files:**
- Modify: `apps/dashboard/src/routes/_app.logs.tsx`
- Modify: `apps/dashboard/src/features/logs/LogRow.tsx`
- Modify: `apps/dashboard/test/features/logs.test.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `StatusBadge`, `DataTableFrame`, existing `logsQuery(limit, pollMs)`.
- Produces: `requestStatus(status: number): { label: string; tone: StatusTone }`.
- Preserves: `POLL_MS = 3_000`, limits `[100, 200, 500]`, pause behavior, one expanded row.

- [ ] **Step 1: Add operational toolbar and status tests**

Extend `logs.test.tsx` to assert:

```ts
expect(screen.getByText("Live")).toBeDefined();
await user.click(screen.getByRole("button", { name: /pause/i }));
expect(screen.getByText("Paused")).toBeDefined();
expect(screen.getByRole("table", { name: /request logs/i })).toBeDefined();
```

For fixture statuses 200, 429, and 500, assert visible labels `Success`, `Client error`, and `Server error` or equally precise agreed labels, each retaining numeric status. Expand a row and assert details are in the next table row and toggle has `aria-expanded="true"`.

- [ ] **Step 2: Run logs tests and verify failure**

Run: `bun test apps/dashboard/test/features/logs.test.tsx`

Expected: FAIL on live status label and named table.

- [ ] **Step 3: Implement pure status mapping**

Map 200–399 to `{ label: "Success", tone: "ok" }`, 400–499 to `{ label: "Client error", tone: "warn" }`, and 500+ to `{ label: "Server error", tone: "bad" }`. Keep error code separately visible.

- [ ] **Step 4: Implement sticky toolbar and table frame**

Use `PageHeader` and a sticky toolbar beneath it. Show `StatusBadge` Live/Paused, exact refresh interval while live, row selector, and pause/resume. Do not claim a server refresh timestamp; if showing `Updated just now`, derive it from successful query fetch state and use nonessential client text. Wrap table in `DataTableFrame`, give table `aria-label="Request logs"`, sticky header, and horizontal overflow.

- [ ] **Step 5: Refine rows**

Keep request-time and requested-model columns sticky only after testing actual background layering in both themes. Use monospace for IDs/models and tabular numerals for status, duration, and cost. Combine numeric code with visible `StatusBadge`. Keep details inline and all existing data/privacy boundaries unchanged.

- [ ] **Step 6: Run logs tests and typecheck**

Run:

```bash
bun test apps/dashboard/test/features/logs.test.tsx
bun run --cwd apps/dashboard typecheck
```

Expected: PASS and polling fake-timer tests remain deterministic.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/routes/_app.logs.tsx apps/dashboard/src/features/logs/LogRow.tsx \
  apps/dashboard/test/features/logs.test.tsx
git commit -m "feat(dashboard): redesign live request logs"
```

---

### Task 9: API Key Management and One-Time Reveal

**Files:**
- Modify: `apps/dashboard/src/routes/_app.keys.tsx`
- Modify: `apps/dashboard/src/features/keys/KeyRow.tsx`
- Modify: `apps/dashboard/src/features/keys/MintKeyDialog.tsx`
- Modify: `apps/dashboard/test/features/keys.test.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `EmptyState`, `LoadingSkeleton`, `DataTableFrame`, existing mutation APIs.
- Preserves: `parseAllowlist(raw, known)`, one-time `MintedKey`, copy fallback, revoke confirmation.
- Must not add last-used column because current `WireApiKey` has no last-used field.

- [ ] **Step 1: Add table and reveal tests**

Extend `keys.test.tsx`:

```ts
expect(await screen.findByRole("table", { name: /api keys/i })).toBeDefined();
expect(screen.queryByText(/last used/i)).toBeNull();
```

After minting, assert dialog changes to a region/step headed `Copy your API key`, warning says it cannot be shown again, raw key appears in a read-only monospace control, copy action changes feedback to `Copied`, and close button uses explicit text `I saved this key`. Close and reopen mint dialog; assert raw key is absent. Assert `localStorage` contains no raw key substring.

- [ ] **Step 2: Run key tests and verify failure**

Run: `bun test apps/dashboard/test/features/keys.test.tsx`

Expected: FAIL on named table, reveal heading, or acknowledgement text.

- [ ] **Step 3: Refine keys page**

Use `PageHeader` with `Create key`, geometry-preserving loading state, action-oriented empty state, and `DataTableFrame`. Columns remain only label, prefix, model scope, rate limit, created, and actions because these are current wire fields. Use monospace for prefix and tabular numerals for limits/date where useful.

- [ ] **Step 4: Refine one-time reveal**

Keep minted key only in component state. After successful mutation, replace form body with focused warning/reveal step. Copy button sets explicit `copied` state; on clipboard failure retain existing fallback selection path and visible error. `close()` resets mutation and all raw-key/copy state before closing. Do not write key to query cache, storage, URL, console, or analytics.

- [ ] **Step 5: Run key tests and typecheck**

Run:

```bash
bun test apps/dashboard/test/features/keys.test.tsx
bun run --cwd apps/dashboard typecheck
```

Expected: PASS, including validation and revoke failure tests.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/_app.keys.tsx apps/dashboard/src/features/keys \
  apps/dashboard/test/features/keys.test.tsx
git commit -m "feat(dashboard): refine API key management"
```

---

### Task 10: Integrated Accessibility, Responsive, and Visual Verification

**Files:**
- Modify only when verification exposes a concrete defect: dashboard files changed in Tasks 1–9.
- Test modifications must remain in nearest existing focused test file.

**Interfaces:**
- Consumes: complete dashboard redesign.
- Produces: verified production bundle and documented manual inspection result.

- [ ] **Step 1: Run dashboard test suite**

Run: `bun test apps/dashboard`

Expected: all dashboard tests PASS. If failure occurs, fix smallest owning component and add or tighten regression assertion in nearest focused test before rerunning.

- [ ] **Step 2: Run full repository verification**

Run:

```bash
bun test
bun run typecheck
bun run lint
bun run --cwd apps/dashboard build
```

Expected: all commands exit 0. Biome's existing `linter.recommended` deprecation notice remains informational.

- [ ] **Step 3: Launch real application**

Invoke `/run` skill. Start gateway/dashboard through repository-supported command with synthetic local configuration and no live provider calls. Use existing local database only if it contains no sensitive data; otherwise use temporary synthetic state through supported test/dev seams.

- [ ] **Step 4: Inspect required view matrix**

Inspect these viewports and states:

| View | Width | Theme | Required checks |
|---|---:|---|---|
| Desktop | 1440px | light | shell hierarchy, page widths, table alignment |
| Desktop | 1440px | dark | contrast, borders, statuses, chart tooltip |
| Tablet | 900px | system | model master-detail, usage controls wrapping |
| Mobile | 390px | light | drawer, login/setup, dialogs, actions, overflow |
| Mobile | 390px | dark | drawer focus, key reveal, log horizontal scroll |

Visit Login/Setup, Credentials, Models, Usage, Logs, and API Keys. Check long model IDs, empty states, loading states if throttle/stub supports them, errors, dialogs, keyboard focus, drawer focus restoration, sticky headers/columns, chart labels/tooltips, and reduced motion.

- [ ] **Step 5: Fix concrete inspection defects with regression coverage**

For each defect, first add a focused failing behavior test when DOM-observable. For purely visual overflow/contrast defects, record exact viewport and selector in implementation notes, make smallest CSS/class change, rerun nearest tests, then repeat affected view inspection. Do not add unrelated visual polish.

- [ ] **Step 6: Re-run final verification after inspection fixes**

Run:

```bash
bun test apps/dashboard
bun test
bun run typecheck
bun run lint
bun run --cwd apps/dashboard build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit final inspection fixes if any**

If working tree changed:

```bash
git add apps/dashboard
git commit -m "fix(dashboard): resolve responsive UI defects"
```

If no files changed, do not create an empty commit.

- [ ] **Step 8: Request code review**

Invoke `superpowers:requesting-code-review`. Review complete branch against `docs/superpowers/specs/2026-08-05-dashboard-redesign-design.md`. Resolve confirmed findings with focused regression tests and rerun Step 6.

---

## Plan Self-Review

- **Spec coverage:** Theme, shell, responsive drawer, login/setup, all five routes, shared states, chart constraints, accessibility, privacy, verification, and real-app inspection each map to Tasks 1–10.
- **Scope:** One dashboard subsystem; tasks are independently reviewable vertical slices. No gateway/store changes required.
- **API consistency:** Plan uses only current fields visible in route/types usage. API keys deliberately omit unsupported last-used data. Logs retain polling; credentials derive summaries client-side.
- **Type consistency:** Shared component and theme signatures are defined before consumers. `StatusTone` comes from Task 2 and is consumed by Task 8. `UsageMetric` adds `errors` consistently in Task 7.
- **Security:** Raw key remains mutation-local; startup theme script reads validated fixed strings only; no production direct network call added.
