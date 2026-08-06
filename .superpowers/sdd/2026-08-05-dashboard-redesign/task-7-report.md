# Task 7 Report: Accessible Usage Analytics

## Delivered

- Replaced five KPI cards with four shared `StatTile` metrics: Requests, Tokens, Estimated cost, Error rate.
- Moved sampled rate-limit value into secondary operational text near page header, shown only when log sample exists.
- Added `errors` chart metric and exported `chartRows(rows, metric)`.
- Switched chart to `ResponsiveContainer` at 280px height, retaining single Y axis, rounded 4px bar ends, exact-value tooltip formatting, and no unnecessary legend for single series.
- Added selected light/dark single-series chart marks, grid, and tooltip CSS tokens.
- Replaced metric select with accessible Tabs; controls remain wrapping row and usage query/range/group semantics remain unchanged.
- Wrapped breakdown table in `DataTableFrame`; added `Usage breakdown` caption/name, sticky header, monospace keys, and tabular figures.
- Added tests for exactly four stat tiles, Errors chart selection, persistent table equivalent, and secondary rate-limit context.

## Palette validation

Final light chart mark: `#2a78d6` on `#ffffff`.

```bash
node /tmp/claude-1000/bundled-skills/2.1.222/3e3d3b22917de0103ac8181b5d3e8837/dataviz/scripts/validate_palette.js "#2a78d6" --mode light --surface "#ffffff" --ordinal
```

Result: `ALL CHECKS PASS`.

Final dark chart mark: `#3987e5` on `#34363d`.

```bash
node /tmp/claude-1000/bundled-skills/2.1.222/3e3d3b22917de0103ac8181b5d3e8837/dataviz/scripts/validate_palette.js "#3987e5" --mode dark --surface "#34363d" --ordinal
```

Result: `ALL CHECKS PASS`.

## Validation

Passed:

```bash
bun test
bun run typecheck
bun test --cwd apps/dashboard --preload ./test/setup/happydom.ts --preload ./test/setup/cleanup.ts ./test/features/usage.test.tsx
bun run --cwd apps/dashboard typecheck
bunx biome check apps/dashboard/src/features/usage/StatCards.tsx apps/dashboard/src/features/usage/UsageChart.tsx apps/dashboard/src/routes/_app.usage.tsx apps/dashboard/src/index.css apps/dashboard/test/features/usage.test.tsx
```

`bun run lint` remains failing with three repository-wide errors and one warning. Changed Task 7 files pass direct Biome check. Dashboard route generator emits existing circular-dependency warning during typecheck.

## Self-review

- Chart remains single-series and single-axis; legend intentionally omitted because title identifies series.
- Tooltip values preserve exact request/error/token counts; only Y-axis token tick compaction uses existing display formatter.
- Empty state has no chart/table, preserving existing behavior.
- No query parameters, ranges, grouping, sort order, or API calls changed.
- Replaced grouping `<select>` with native `<fieldset>`/`<legend>` radio inputs. Added regression coverage for named group and native radios; grouping refetch behavior remains covered.

## Follow-up validation

Passed:

```bash
bun run --cwd apps/dashboard test -- --filter 'grouping uses native radio inputs|switching the grouping|switching the range|stat cards show exactly'
bun run typecheck
bunx biome check apps/dashboard/src/routes/_app.usage.tsx apps/dashboard/test/features/usage.test.tsx
```

`bun run lint` still reports four repository-wide errors and one warning. Changed files pass direct Biome check.

## Fix round 2

- Root cause: chart metric selector, not group-by selector, used Radix `TabsTrigger` without matching `TabsContent`/`tabpanel`, leaving generated `aria-controls` IDs dangling.
- Replaced only chart metric controls with native `fieldset`/`legend` radio inputs named `usage-chart-metric`; chart state and group-by controls remain unchanged.
- Regression test targets Requests, Tokens, Estimated cost, and Errors. For each metric it verifies radio role, checked state after selection, matching chart accessible name, and absent `aria-controls`; it also verifies `Usage breakdown` remains present.

### Evidence

Passed:

```bash
bun test --cwd apps/dashboard --preload ./test/setup/happydom.ts --preload ./test/setup/cleanup.ts ./test/features/usage.test.tsx
# 13 pass, 0 fail, 40 expect() calls

bun run --cwd apps/dashboard typecheck
# exit 0

bun test
# 466 pass, 0 fail, 1095 expect() calls

bun run typecheck
# exit 0

bunx biome check apps/dashboard/src/routes/_app.usage.tsx apps/dashboard/test/features/usage.test.tsx
# Checked 2 files. No fixes applied.

git diff --check
# exit 0
```

Focused usage test prints existing React `act(...)` warning from a `ForwardRef`; it exits 0. Dashboard and repository typechecks print existing route-generator circular-dependency warning; both exit 0.

`bun run lint` exits 1 on pre-existing repository-wide issues outside this fix: `NavDrawer.tsx` useless fragment, `ThemeToggle.tsx` import/format findings, `ThemeProvider.tsx` format finding, and `postman/OmniGateway.postman_collection.json` format findings. Changed Task 7 files pass direct Biome check.
