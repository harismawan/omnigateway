# OmniGateway Dashboard Redesign

**Date:** 2026-08-05
**Status:** Approved

## Overview

Redesign the complete OmniGateway dashboard as a layered operator workspace. The interface combines a calm, precise control-plane shell with task-specific density: spacious credential and setup workflows, focused usage summaries, and dense model and request-log workspaces.

This redesign changes presentation and interaction structure without changing gateway API contracts, routing semantics, session behavior, or data ownership. Existing React, TanStack Router, TanStack Query, Tailwind, shadcn/ui, Recharts, and Lucide dependencies remain.

## Goals

- Establish a distinctive visual identity for a precise infrastructure tool.
- Improve hierarchy, scanning, and operational status awareness across all five screens.
- Give each workflow appropriate density instead of wrapping every section in a generic card.
- Support independently designed light and dark themes with a persisted operator override.
- Optimize for desktop widths of 1280px and above while keeping all workflows usable on mobile.
- Improve loading, empty, error, mutation, and responsive states.
- Preserve accessibility, privacy, API contracts, and existing session-expiry behavior.

## Non-Goals

- Changing `/api/*` contracts or adding control endpoints.
- Adding dashboard data not returned by current APIs.
- Replacing TanStack Query state ownership or log polling.
- Introducing WebSockets, a new charting library, or a new component framework.
- Adding decorative marketing content or an analytics overview route.
- Refactoring gateway or store internals unrelated to dashboard presentation.

## Design Direction

### Layered operator workspace

Use a persistent shell and vary content structure by task:

- Credentials and authentication use calm, spacious layouts.
- Usage leads with summary values and one focused visualization.
- Models use a master-detail editing workspace.
- Logs use a dense live data table.
- API keys use a clear management table and focused one-time secret reveal.

Cards appear only around discrete objects, metrics, or bounded tasks. Tables, toolbars, and editing workspaces should not be nested in redundant cards.

### Personality

OmniGateway should read as a precise infrastructure tool:

- Neutral slate surfaces.
- Restrained indigo action and selection accent.
- Green, amber, and red reserved for operational status.
- Sans-serif UI typography with monospace treatment for operational data.
- Low-contrast borders, minimal shadows, and restrained 10–12px radii.
- No gradients, glass effects, oversized hero typography, or decorative data graphics.

## Application Shell

### Desktop

Use a 240px fixed sidebar and a flexible content region.

Sidebar contains:

1. OmniGateway product mark and name.
2. Five icon-and-label routes: Credentials, Models, Usage, Logs, and API keys.
3. Active route treatment using a subtle indigo surface, visible leading indicator, and stronger text.
4. Gateway status summary near the bottom when current API data supports it.
5. Sign-out action in the lower operator area.

Content region contains a slim top bar with route context and theme control. Page-level content controls its own maximum width:

- Credentials and Usage use a readable constrained width.
- Models and Logs use available width.
- API Keys uses a moderate constrained width.

Avoid repeating identical title information in both top bar and page content.

### Mobile

Below 768px:

- Replace persistent sidebar with a focus-managed navigation drawer.
- Expose drawer button and page context in top bar.
- Keep primary page actions visible or place them directly beneath title.
- Give touch controls a minimum 44px target.
- Allow wide tables to scroll horizontally and keep identifying columns sticky where practical.

## Theme System

Theme modes are `system`, `light`, and `dark`.

- First visit follows operating-system preference.
- Explicit operator choice persists in local storage.
- Theme applies before or at initial React render to avoid a visible flash.
- Light and dark palettes use independently selected tokens rather than mechanically inverted values.
- Both themes expose semantic tokens for canvas, surface, raised surface, border, primary text, secondary text, muted text, action accent, focus ring, and four status levels.

Status colors must always be paired with text and, where compact enough, an icon or shape. Color alone never carries meaning.

## Typography and Data Formatting

Use a clean system-oriented sans-serif stack for interface copy. Use a monospace stack for:

- Model identifiers.
- Provider model names.
- API key prefixes.
- Request and correlation IDs.
- Durations, token counts, quotas, and costs where tabular alignment aids scanning.

Apply `font-variant-numeric: tabular-nums` to comparable metrics and table columns. Page titles, descriptions, section labels, and field labels use a consistent hierarchy shared across routes.

## Shared Components

Introduce or standardize these focused units:

- `PageHeader`: route title, description, and responsive action region.
- `StatTile`: label, headline value, optional detail, and status-safe decoration.
- `StatusBadge`: semantic status with label and icon/shape support.
- `EmptyState`: concise explanation and optional primary action.
- `LoadingSkeleton`: geometry-preserving loading state.
- `DataTableFrame`: overflow, border, sticky-header, and responsive behavior.
- `ThemeToggle`: system/light/dark control with accessible labeling.
- `NavDrawer`: mobile navigation with focus management.

Units should accept narrow, explicit props and remain independent of route query ownership. Route and feature components continue to fetch and mutate data.

## Screen Designs

### Login and first-run setup

Desktop uses a split composition:

- Left panel: restrained OmniGateway identity and one sentence explaining the gateway's purpose.
- Right panel: focused login or setup form with bounded width.

Mobile collapses to one form column. First-run setup displays password requirements before submission and retains existing minimum-length and confirmation validation. Errors stay adjacent to the form. No dashboard preview or decorative fake metrics appear.

### Credentials

Page header includes a primary `Connect provider` action. A compact summary strip reports values derivable from existing responses:

- Connected accounts.
- Healthy accounts.
- Rate-limited or breaker-open accounts.
- Quota warnings.

Each provider is a clean section with provider identity, credential count, aggregate status, and add action. Credential rows prioritize:

1. Account label and provider identity.
2. Health state and health detail.
3. Tier or routing preference.
4. Quota windows.
5. Row actions.

Providers with no credentials use a compact inline empty state rather than a large blank card. Health unavailability is shown as unknown, not healthy. Existing connect dialog behavior and OAuth flows remain unchanged.

### Models

Use a desktop master-detail workspace:

- Left column: searchable list of virtual models with alias indicators and a `New model` action.
- Right region: selected model editor.
- Lower region: collapsible dry-run explanation for the selected model.

Targets render as ordered route blocks with drag handle, provider, upstream model, weight, and controls. Selection uses route-local state as today. Creating, saving, deleting, and dry-running preserve existing API behavior.

On mobile, stack model selector/list above editor. Do not force a narrow two-column layout.

### Usage

Header contains date range and grouping controls. Summary row contains four stat tiles:

- Requests.
- Tokens.
- Estimated cost.
- Error rate.

Show one chart metric at a time, selected with metric tabs. Never use dual axes. Current metric choices remain requests, tokens, cost, or errors as supported by existing data.

Chart rules:

- Use one visual identity per grouping value in a fixed categorical order.
- Validate light and dark categorical palettes with the data-visualization palette validator.
- Use restrained axes and gridlines.
- Provide hover tooltips with exact values.
- Show a legend for two or more series.
- Preserve a detailed table below as the accessible and exact-value equivalent.
- Fold excessive low-volume series into a documented `Other` group if series count exceeds the validated palette; never cycle colors.

Stat tiles remain text-led and do not add decorative sparklines without supporting time-series data.

### Logs

Use a dense operational workspace with a sticky toolbar containing:

- Live or paused state.
- Row-count selector.
- Last refresh context when available from client state.
- Existing pause/resume action.
- Filters only where current fetched fields allow local filtering without changing API contracts.

Table uses a sticky header, aligned numeric columns, and monospace operational values. Status is encoded with both label and status marker. Expanding a row inserts an inline detail region immediately beneath it so context remains visible. Existing three-second polling and pause semantics remain unchanged.

At narrow widths, table scrolls horizontally; requested model remains identifying sticky column after row-time column where browser behavior permits.

### API Keys

Page header contains `Create key`. Management table prioritizes fields available in current API response, including label, key prefix, model scope, rate limit, and creation date. Last-used data appears only if current contract supplies it; redesign must not invent it.

Newly minted raw key appears once in a focused reveal panel with:

- Clear one-time visibility warning.
- Monospace key value.
- Copy action with confirmation feedback.
- Explicit close acknowledgement.

Raw keys never persist to local storage, query cache beyond existing mutation lifetime, logs, or navigation state.

## UI States and Behavior

### Loading

Replace bare loading text with skeletons that preserve expected geometry. Route-level loading should not shift primary controls after data arrives.

### Empty

Each empty state explains why content is absent and provides the next valid action:

- No credentials: connect provider.
- No models: create model.
- No requests: send a gateway request.
- No API keys: create key.

### Errors

Render recoverable query failures as inline alerts with retry. Preserve gateway-provided safe messages through existing `ApiError`. Do not expose provider tokens, credential IDs, secrets, stack traces, prompt bodies, or response bodies.

Session expiry continues through the shared API client and existing centralized redirect behavior.

### Mutations

Keep pending actions in place and disable repeat submission. Preserve form drafts after failures. Show result feedback near the initiating control. Destructive actions retain explicit confirmation where existing behavior requires it.

### Dialogs

Dialogs share header, description, content, error, and footer structure. They trap focus, support Escape where safe, restore focus to trigger, and remain scrollable on small screens.

### Motion

Use 120–180ms color and opacity transitions for hover, focus, selection, and drawer/dialog entry. Avoid layout-heavy animation. Respect `prefers-reduced-motion`.

## Accessibility

- Meet WCAG AA contrast for text and controls in both themes.
- Use visible keyboard focus rings on every interactive element.
- Preserve semantic headings and tables.
- Label icon-only controls with accessible names.
- Pair all statuses with text; never depend on hue alone.
- Keep chart data available in a semantic table.
- Ensure drawer and dialogs manage focus correctly.
- Keep mobile touch targets at least 44px.
- Test keyboard navigation through shell, forms, dialogs, model selection, and expanded log rows.

## Data Flow and Architectural Boundaries

- Route and feature components continue to own TanStack Query calls.
- Shared visual components receive data through props and do not fetch.
- Existing query keys, API client, session invalidation, and `/api/*` paths remain authoritative.
- Logs continue polling; redesign adds no WebSocket.
- Theme preference is the only new persisted client setting.
- Existing form-local state remains local unless a shared interaction explicitly requires otherwise.
- No outbound request bypasses existing dashboard API client.

## Testing

### Behavior tests

Add or update focused tests for:

- Desktop navigation active state and sign-out.
- Mobile drawer opening, focus behavior, navigation, and closing.
- System theme resolution, explicit theme override, persistence, and dark-class application.
- Login and setup form accessibility and validation presentation.
- Shared loading, empty, error, and status rendering.
- Model master-detail selection and mobile stacking semantics where testable without viewport layout assertions.
- Log pause/resume and expanded-row accessibility.
- One-time API key reveal and copy confirmation without persistence.

Existing API and query tests remain unchanged unless markup-facing behavior requires adjustment.

### Visual and data checks

- Validate selected chart palettes programmatically for both light and dark chart surfaces.
- Inspect rendered dashboard at desktop light, desktop dark, and narrow mobile widths.
- Check overflow, sticky headers/columns, focus visibility, chart labels, tooltips, dialogs, and long identifiers.
- Confirm status distinctions remain understandable under common color-vision deficiencies.

### Repository verification

Before completion, run:

1. Focused dashboard tests covering changed behavior.
2. Full `bun test`.
3. `bun run typecheck`.
4. `bun run lint`.
5. Dashboard production build.
6. Real-app launch and visual inspection using representative stub or local data.

## Success Criteria

1. Dashboard has a consistent, recognizable operator-console identity in light and dark themes.
2. All five routes, login, setup, dialogs, and common states share coherent hierarchy and interaction patterns.
3. Credentials, Models, Usage, Logs, and API Keys each use density appropriate to their workflow.
4. Desktop layout works best at 1280px and above; every workflow remains usable below 768px.
5. Theme follows system initially and persists explicit operator choice without visible flash.
6. Usage visualization uses one axis, validated colors, tooltips, legends when needed, and a table equivalent.
7. API contracts, session handling, query ownership, polling semantics, and privacy constraints remain unchanged.
8. Automated tests and repository verification commands pass, and real-app inspection finds no blocking overflow or accessibility defects.
