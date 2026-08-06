# Provider Chooser Focus Return Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return keyboard focus to persistent header Connect provider button when page-level provider chooser closes through Cancel or Escape.

**Architecture:** `CredentialsScreen` stores header trigger through React ref. Chooser `onCloseAutoFocus` explicitly directs focus to ref when no provider is selected, while selected-provider branch keeps preventing restoration so replacement `ConnectDialog` receives focus. Provider-group Add account callbacks remain untouched.

**Tech Stack:** React, Radix Dialog, Testing Library, Vitest, TypeScript, Bun.

## Global Constraints

- Scope only page-level header chooser Cancel and Escape focus return.
- Provider-specific Add account buttons retain current direct `addProvider` flow and focus behavior.
- Preserve selected-provider transfer into `ConnectDialog`.
- Strict TypeScript; no `any`; Biome 2-space style and 100-column lines.
- Run focused tests plus `bun test`, `bun run typecheck`, and `bun run lint` before completion.

---

### Task 1: Specify header-trigger return focus

**Files:**
- Modify: `apps/dashboard/test/features/credentials.test.tsx:142-179`

**Interfaces:**
- Consumes: rendered `CredentialsScreen`, accessible header button named `Connect provider`, Radix dialog named `Connect provider`.
- Produces: behavioral coverage requiring Cancel and Escape to focus original header trigger after chooser unmounts.

- [ ] **Step 1: Strengthen failing Cancel test around explicit trigger ownership**

Keep `trigger` reference before opening chooser. After clicking chooser Cancel and waiting for chooser removal, assert exact reference owns focus:

```tsx
await waitFor(() => {
  expect(document.activeElement).toBe(trigger);
});
```

- [ ] **Step 2: Strengthen failing Escape test around explicit trigger ownership**

Keep same header `trigger` reference. After `await user.keyboard("{Escape}")` and chooser removal, assert:

```tsx
await waitFor(() => {
  expect(document.activeElement).toBe(trigger);
});
```

- [ ] **Step 3: Run focused test before source change**

Run:

```bash
bun test apps/dashboard/test/features/credentials.test.tsx
```

Expected: current behavior may pass through Radix implicit restoration; source implementation still lacks explicit header ref. Record baseline, then proceed to implementation.

- [ ] **Step 4: Commit test characterization with implementation**

Do not make isolated test-only commit. Stage with Task 2 source edit after tests pass.

### Task 2: Add explicit chooser return target

**Files:**
- Modify: `apps/dashboard/src/routes/_app.credentials.tsx:73-81,137-188`
- Test: `apps/dashboard/test/features/credentials.test.tsx:142-179`

**Interfaces:**
- Consumes: `DialogContent` `onCloseAutoFocus(event: Event)` and mutable React ref to header `HTMLButtonElement`.
- Produces: chooser close handler which calls `event.preventDefault()` and focuses header trigger on Cancel/Escape; existing `providerSelected` branch continues preventing restoration for provider selection.

- [ ] **Step 1: Add header trigger ref beside current selection ref**

In `CredentialsScreen`, add explicit button ref:

```tsx
const connectProviderTrigger = useRef<HTMLButtonElement>(null);
const providerSelected = useRef(false);
```

- [ ] **Step 2: Attach ref to persistent header trigger**

On page header action trigger, retain existing `DialogTrigger asChild` and attach ref to underlying button:

```tsx
<DialogTrigger asChild>
  <Button ref={connectProviderTrigger}>Connect provider</Button>
</DialogTrigger>
```

Do not attach this ref to provider-group Add account controls.

- [ ] **Step 3: Make chooser close autofocus explicit**

Replace handler passed to `ProviderChooser` with branch behavior:

```tsx
onCloseAutoFocus={(event) => {
  event.preventDefault();
  if (providerSelected.current) {
    providerSelected.current = false;
    return;
  }
  connectProviderTrigger.current?.focus();
}}
```

This prevents Radix implicit restoration in both cases. Selection branch leaves focus available to destination `ConnectDialog`; Cancel/Escape branch targets persistent header control.

- [ ] **Step 4: Run focused chooser tests**

Run:

```bash
bun test apps/dashboard/test/features/credentials.test.tsx
```

Expected: PASS, including selected-provider dialog focus plus Cancel and Escape header focus assertions.

- [ ] **Step 5: Format and commit focused behavior change**

Run:

```bash
bun run fmt
bun test apps/dashboard/test/features/credentials.test.tsx
git add apps/dashboard/src/routes/_app.credentials.tsx apps/dashboard/test/features/credentials.test.tsx
git commit -m "fix(dashboard): restore chooser trigger focus" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

Expected: formatter exits zero; focused tests pass; commit contains source and behavior tests only.

### Task 3: Verify full dashboard and repository checks

**Files:**
- Verify only: `apps/dashboard/src/routes/_app.credentials.tsx`
- Verify only: `apps/dashboard/test/features/credentials.test.tsx`

**Interfaces:**
- Consumes: completed explicit-focus implementation and chooser tests.
- Produces: evidence that behavior remains type-safe, lint-clean, and non-regressed across project suite.

- [ ] **Step 1: Run repository test suite**

Run:

```bash
bun test
```

Expected: PASS. Treat documented Biome deprecation notice as informational only.

- [ ] **Step 2: Run type check**

Run:

```bash
bun run typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 3: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS. Biome `linter.recommended` deprecation notice is informational unless configuration changed.

- [ ] **Step 4: Inspect final worktree**

Run:

```bash
git status --short
git log -1 --oneline
```

Expected: clean worktree and latest commit `fix(dashboard): restore chooser trigger focus`.

## Plan self-review

- Spec coverage: Task 2 explicitly isolates header chooser behavior, preserves selection handoff, and leaves Add account controls untouched. Task 1 covers Cancel and Escape. Task 3 runs required verification.
- Placeholder scan: no TBD/TODO or deferred implementation language.
- Type consistency: `connectProviderTrigger` is `MutableRefObject<HTMLButtonElement | null>` from `useRef<HTMLButtonElement>(null)` and attaches to `Button`, which forwards button ref.
