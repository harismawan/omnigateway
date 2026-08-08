# Provider Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-specific curated upstream model suggestions and defaults to dashboard model editing while preserving unrestricted custom model IDs.

**Architecture:** Add one exhaustive, static catalog to provider-neutral `@omni/ir`. Dashboard reads catalog through a focused accessible combobox component, while existing editor state and control API continue storing ordinary `Target.model` strings. Provider switches and new target creation read explicit defaults from catalog; router, dispatch, adapters, API schemas, store types, and database remain unchanged.

**Tech Stack:** Bun, strict TypeScript, React 19, Testing Library, Happy DOM, Tailwind CSS, Biome.

## Global Constraints

- Catalog must be `Readonly<Record<ProviderId, ProviderModelCatalogEntry>>` in `packages/ir`.
- Anthropic default: `claude-opus-5`; curated IDs: `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`.
- OpenAI default: `gpt-5.6`; curated IDs: `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- Kimi default: `k3-256k`; curated IDs: `k3-256k`, `k3`, `kimi-for-coding`, `kimi-for-coding-highspeed`.
- Kimi labels must be `Kimi K3 — 256K`, `Kimi K3 — up to 1M`, `Kimi K2.7 Code`, and `Kimi K2.7 Code — High Speed`, respectively. Anthropic and OpenAI labels equal IDs.
- Suggestions are not an allowlist. Any non-empty custom upstream model ID remains valid and saves unchanged.
- Focusing an empty or populated model field shows all current-provider choices. Typing filters choices by case-insensitive substring against ID or label.
- Keyboard behavior must follow combobox semantics: ArrowDown/ArrowUp move active option, Enter selects it, and Escape closes suggestions.
- Changing provider atomically patches `provider` and that provider's `defaultModel`.
- New virtual models and newly added targets start as Anthropic with `claude-opus-5`.
- Existing saved targets, including custom IDs, must not change merely because editor opens.
- Existing capability flags stay operator-managed and do not reset when provider or model changes.
- Do not change `VirtualModel`, `Target`, persistence schema, router, dispatch, adapters, `/v1/models`, request-time fallback, or server validation.
- Use explicit `.ts`/`.tsx` ESM imports, strict types, no `any`, 2-space indentation, and 100-column formatting.
- Tests must use synthetic data and must not call live providers.

## File Structure

- Create `packages/ir/src/model-catalog.ts`: provider model catalog types and exhaustive static data.
- Create `packages/ir/test/model-catalog.test.ts`: catalog coverage and data-invariant tests.
- Modify `packages/ir/src/index.ts`: export catalog public API.
- Create `apps/dashboard/src/features/models/ProviderModelInput.tsx`: controlled accessible editable combobox, filtering, and suggestion selection.
- Create `apps/dashboard/test/features/provider-model-input.test.tsx`: focused combobox behavior tests.
- Modify `apps/dashboard/src/features/models/TargetRow.tsx`: render combobox and patch provider plus default model together.
- Modify `apps/dashboard/src/features/models/ModelEditor.tsx`: create targets with provider catalog defaults.
- Modify `apps/dashboard/test/features/models.test.tsx`: defaults, provider reset, custom persistence, and non-mutation integration coverage.
- `apps/dashboard/src/routes/_app.models.tsx` needs no edit: existing `blankModel()` already delegates target construction to `emptyTarget("anthropic")`.

---

### Task 1: Canonical Provider Model Catalog

**Files:**
- Create: `packages/ir/src/model-catalog.ts`
- Create: `packages/ir/test/model-catalog.test.ts`
- Modify: `packages/ir/src/index.ts:3-7`

**Interfaces:**
- Consumes: `ProviderId` from `packages/ir/src/request.ts`.
- Produces: `ProviderModelChoice`, `ProviderModelCatalogEntry`, and `PROVIDER_MODEL_CATALOG: Readonly<Record<ProviderId, ProviderModelCatalogEntry>>` exported from `@omni/ir`.

- [ ] **Step 1: Write failing catalog tests**

Create `packages/ir/test/model-catalog.test.ts`:

```ts
import { expect, test } from "bun:test";
import { PROVIDER_MODEL_CATALOG, type ProviderId } from "../src/index.ts";

const PROVIDERS: readonly ProviderId[] = ["anthropic", "openai", "kimi"];

const EXPECTED = {
  anthropic: {
    defaultModel: "claude-opus-5",
    ids: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  openai: {
    defaultModel: "gpt-5.6",
    ids: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  },
  kimi: {
    defaultModel: "k3-256k",
    ids: ["k3-256k", "k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
  },
} as const;

test("catalog covers every provider with ordered curated IDs", () => {
  expect(Object.keys(PROVIDER_MODEL_CATALOG).sort()).toEqual([...PROVIDERS].sort());

  for (const provider of PROVIDERS) {
    const entry = PROVIDER_MODEL_CATALOG[provider];
    expect(entry.defaultModel).toBe(EXPECTED[provider].defaultModel);
    expect(entry.models.map((model) => model.id)).toEqual([...EXPECTED[provider].ids]);
  }
});

test("catalog entries have non-empty unique values and exactly one default", () => {
  for (const provider of PROVIDERS) {
    const entry = PROVIDER_MODEL_CATALOG[provider];
    const ids = entry.models.map((model) => model.id);

    expect(entry.defaultModel.length).toBeGreaterThan(0);
    expect(entry.models.every((model) => model.id.length > 0 && model.label.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === entry.defaultModel)).toHaveLength(1);
  }
});

test("Kimi labels describe coding endpoint aliases", () => {
  expect(PROVIDER_MODEL_CATALOG.kimi.models).toEqual([
    { id: "k3-256k", label: "Kimi K3 — 256K" },
    { id: "k3", label: "Kimi K3 — up to 1M" },
    { id: "kimi-for-coding", label: "Kimi K2.7 Code" },
    { id: "kimi-for-coding-highspeed", label: "Kimi K2.7 Code — High Speed" },
  ]);
});
```

- [ ] **Step 2: Run catalog tests and verify expected failure**

Run:

```bash
bun test packages/ir/test/model-catalog.test.ts
```

Expected: FAIL because `PROVIDER_MODEL_CATALOG` is not exported from `packages/ir/src/index.ts`.

- [ ] **Step 3: Add typed static catalog**

Create `packages/ir/src/model-catalog.ts`:

```ts
import type { ProviderId } from "./request.ts";

export type ProviderModelChoice = {
  id: string;
  label: string;
};

export type ProviderModelCatalogEntry = {
  defaultModel: string;
  models: readonly ProviderModelChoice[];
};

export const PROVIDER_MODEL_CATALOG: Readonly<
  Record<ProviderId, ProviderModelCatalogEntry>
> = {
  anthropic: {
    defaultModel: "claude-opus-5",
    models: [
      { id: "claude-fable-5", label: "claude-fable-5" },
      { id: "claude-opus-5", label: "claude-opus-5" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
      { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    ],
  },
  openai: {
    defaultModel: "gpt-5.6",
    models: [
      { id: "gpt-5.6", label: "gpt-5.6" },
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
      { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
      { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    ],
  },
  kimi: {
    defaultModel: "k3-256k",
    models: [
      { id: "k3-256k", label: "Kimi K3 — 256K" },
      { id: "k3", label: "Kimi K3 — up to 1M" },
      { id: "kimi-for-coding", label: "Kimi K2.7 Code" },
      {
        id: "kimi-for-coding-highspeed",
        label: "Kimi K2.7 Code — High Speed",
      },
    ],
  },
};
```

Add public export to `packages/ir/src/index.ts`:

```ts
export * from "./model-catalog.ts";
```

Keep existing exports unchanged.

- [ ] **Step 4: Run catalog tests and IR typecheck**

Run:

```bash
bun test packages/ir/test/model-catalog.test.ts
bunx tsc --noEmit --pretty false -p packages/ir/tsconfig.json
```

Expected: both commands PASS. TypeScript must also prove catalog has one entry for every `ProviderId`.

- [ ] **Step 5: Commit catalog**

```bash
git add packages/ir/src/model-catalog.ts packages/ir/src/index.ts packages/ir/test/model-catalog.test.ts
git commit -m "feat(ir): add provider model catalog"
```

---

### Task 2: Accessible Editable Provider Model Input

**Files:**
- Create: `apps/dashboard/src/features/models/ProviderModelInput.tsx`
- Create: `apps/dashboard/test/features/provider-model-input.test.tsx`

**Interfaces:**
- Consumes: `ProviderId`, `ProviderModelChoice`, and `PROVIDER_MODEL_CATALOG` from `@omni/ir`.
- Produces: `ProviderModelInput({ provider, value, targetNumber, onChange }): JSX.Element`, a controlled input whose `onChange` receives exact custom text or selected curated ID.

- [ ] **Step 1: Write failing combobox behavior tests**

Create `apps/dashboard/test/features/provider-model-input.test.tsx`:

```tsx
import { expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ProviderModelInput } from "../../src/features/models/ProviderModelInput.tsx";

function renderInput(
  provider: "anthropic" | "openai" | "kimi" = "anthropic",
  initialValue = "",
) {
  const onChange = mock((model: string) => model);
  function ControlledInput() {
    const [value, setValue] = useState(initialValue);
    return (
      <ProviderModelInput
        onChange={(model) => {
          onChange(model);
          setValue(model);
        }}
        provider={provider}
        targetNumber={1}
        value={value}
      />
    );
  }
  render(<ControlledInput />);
  return { onChange, user: userEvent.setup() };
}

test("focus shows only current-provider curated choices", async () => {
  const { user } = renderInput("openai");
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  await user.click(input);

  expect(screen.getByRole("option", { name: "gpt-5.6" })).toBeDefined();
  expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeDefined();
  expect(screen.queryByRole("option", { name: "claude-opus-5" })).toBeNull();
  expect(screen.queryByRole("option", { name: /Kimi K3/ })).toBeNull();
});

test("typing filters IDs and labels case-insensitively while allowing custom text", async () => {
  const { onChange, user } = renderInput("kimi");
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  await user.type(input, "HIGH SPEED");

  expect(onChange).toHaveBeenCalled();
  expect(onChange.mock.calls.at(-1)?.[0]).toBe("HIGH SPEED");
  expect(
    screen.getByRole("option", {
      name: "Kimi K2.7 Code — High Speed (kimi-for-coding-highspeed)",
    }),
  ).toBeDefined();
  expect(screen.queryByRole("option", { name: /Kimi K3 — 256K/ })).toBeNull();
});

test("clicking a suggestion emits its exact upstream ID", async () => {
  const { onChange, user } = renderInput("kimi");
  await user.click(screen.getByRole("combobox", { name: "Target 1 model" }));
  await user.click(
    screen.getByRole("option", { name: "Kimi K3 — up to 1M (k3)" }),
  );

  expect(onChange).toHaveBeenLastCalledWith("k3");
});

test("keyboard navigation selects the active suggestion and Escape closes the list", async () => {
  const { onChange, user } = renderInput("anthropic");
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  await user.click(input);
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("claude-opus-5");
  expect(input.getAttribute("aria-expanded")).toBe("false");

  await user.click(input);
  await user.keyboard("{Escape}");
  expect(input.getAttribute("aria-expanded")).toBe("false");
});

test("existing custom values render unchanged", () => {
  renderInput("anthropic", "vendor-private-model");
  expect(screen.getByRole("combobox", { name: "Target 1 model" })).toHaveProperty(
    "value",
    "vendor-private-model",
  );
});
```

- [ ] **Step 2: Run focused component tests and verify expected failure**

Run:

```bash
bun run --cwd apps/dashboard test test/features/provider-model-input.test.tsx
```

Expected: FAIL because `ProviderModelInput.tsx` does not exist.

- [ ] **Step 3: Implement controlled combobox**

Create `apps/dashboard/src/features/models/ProviderModelInput.tsx` with this structure and behavior:

```tsx
import { type KeyboardEvent, useId, useState } from "react";
import {
  PROVIDER_MODEL_CATALOG,
  type ProviderId,
  type ProviderModelChoice,
} from "@omni/ir";
import { Input } from "@/components/ui/input.tsx";

function matches(choice: ProviderModelChoice, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    normalized === "" ||
    choice.id.toLowerCase().includes(normalized) ||
    choice.label.toLowerCase().includes(normalized)
  );
}

type Props = {
  provider: ProviderId;
  value: string;
  targetNumber: number;
  onChange: (model: string) => void;
};

export function ProviderModelInput({ provider, value, targetNumber, onChange }: Props) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const choices = PROVIDER_MODEL_CATALOG[provider].models.filter((choice) =>
    matches(choice, value),
  );
  const activeChoice = activeIndex >= 0 ? choices[activeIndex] : undefined;
  const optionName = (choice: ProviderModelChoice) =>
    choice.label === choice.id ? choice.label : `${choice.label} (${choice.id})`;
  const select = (choice: ProviderModelChoice) => {
    onChange(choice.id);
    setOpen(false);
    setActiveIndex(-1);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (choices.length === 0) return;
      setActiveIndex((current) => {
        if (event.key === "ArrowDown") return current >= choices.length - 1 ? 0 : current + 1;
        return current <= 0 ? choices.length - 1 : current - 1;
      });
      return;
    }
    if (event.key === "Enter" && open && activeChoice !== undefined) {
      event.preventDefault();
      select(activeChoice);
    }
  };

  return (
    <div className="relative">
      <Input
        aria-activedescendant={
          activeChoice === undefined ? undefined : `${listboxId}-option-${activeIndex}`
        }
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-label={`Target ${targetNumber} model`}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setOpen(false);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        value={value}
      />
      {open && choices.length > 0 && (
        <div
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md"
          id={listboxId}
          role="listbox"
        >
          {choices.map((choice, index) => (
            <button
              aria-label={optionName(choice)}
              aria-selected={index === activeIndex}
              className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent aria-selected:bg-accent"
              id={`${listboxId}-option-${index}`}
              key={choice.id}
              onClick={() => select(choice)}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
              type="button"
            >
              <span>{choice.label}</span>
              {choice.label !== choice.id && (
                <span className="ml-2 text-muted-foreground">{choice.id}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

Implementation detail: if Happy DOM reports that `relatedTarget` is absent during option clicks, retain `onMouseDown(event.preventDefault())`; this keeps input focused until option `onClick` calls `select`. Do not add a timeout or document-level listener.

- [ ] **Step 4: Run component tests and dashboard typecheck**

Run:

```bash
bun run --cwd apps/dashboard test test/features/provider-model-input.test.tsx
bun run typecheck:dashboard
```

Expected: both commands PASS. If JSX typing rejects `role="option"` on `button`, keep semantic role and adjust only element type or event typing; do not remove listbox semantics.

- [ ] **Step 5: Commit combobox**

```bash
git add apps/dashboard/src/features/models/ProviderModelInput.tsx apps/dashboard/test/features/provider-model-input.test.tsx
git commit -m "feat(dashboard): add provider model combobox"
```

---

### Task 3: Wire Catalog Defaults into Model Editing

**Files:**
- Modify: `apps/dashboard/src/features/models/ModelEditor.tsx:1-20,130-138`
- Modify: `apps/dashboard/src/features/models/TargetRow.tsx:1-68`
- Modify: `apps/dashboard/test/features/models.test.tsx:53-66,105-114,193-206`

**Interfaces:**
- Consumes: `PROVIDER_MODEL_CATALOG` from `@omni/ir` and `ProviderModelInput` from Task 2.
- Produces: `emptyTarget(provider: ProviderId): Target` using provider default; provider changes emit one `Partial<Target>` containing provider and default model; save payloads preserve custom model strings.

- [ ] **Step 1: Change default-target unit test to require catalog default**

Replace current `empty targets contain complete store defaults` expectation in `apps/dashboard/test/features/models.test.tsx`:

```ts
test("empty targets use the selected provider default model", () => {
  expect(emptyTarget("kimi")).toEqual({
    provider: "kimi",
    model: "k3-256k",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 0, output: 0 },
    capabilities: { tools: true, images: false, reasoning: false },
  });
});
```

- [ ] **Step 2: Add failing model-editor integration tests**

Append these tests to `apps/dashboard/test/features/models.test.tsx`:

```tsx
test("new and added targets start with the Anthropic default", async () => {
  createFetchStub({ "GET /api/models": () => ({ models: [] }) });
  renderWithProviders(<ModelsScreen />);
  const user = userEvent.setup();
  const [newModel] = await screen.findAllByRole("button", { name: "New model" });
  if (newModel === undefined) throw new Error("New model action did not render");

  await user.click(newModel);
  expect(screen.getByRole("combobox", { name: "Target 1 model" })).toHaveProperty(
    "value",
    "claude-opus-5",
  );

  await user.click(screen.getByRole("button", { name: "Add target" }));
  expect(screen.getByRole("combobox", { name: "Target 2 model" })).toHaveProperty(
    "value",
    "claude-opus-5",
  );
});

test("changing provider resets model but preserves operator-managed capabilities", async () => {
  stubModels([
    modelFixture({
      targets: [
        targetFixture({
          model: "vendor-private-model",
          capabilities: { tools: false, images: true, reasoning: false },
        }),
      ],
    }),
  ]);
  renderWithProviders(<ModelsScreen />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "fast" }));

  await user.selectOptions(screen.getByLabelText("Target 1 provider"), "kimi");

  expect(screen.getByRole("combobox", { name: "Target 1 model" })).toHaveProperty(
    "value",
    "k3-256k",
  );
  expect(screen.getByLabelText("Target 1 supports tools")).toHaveProperty("checked", false);
  expect(screen.getByLabelText("Target 1 supports images")).toHaveProperty("checked", true);
  expect(screen.getByLabelText("Target 1 supports reasoning")).toHaveProperty("checked", false);
});

test("custom model IDs render and save unchanged", async () => {
  const stub = stubModels([
    modelFixture({ targets: [targetFixture({ model: "vendor-private-model" })] }),
  ]);
  renderWithProviders(<ModelsScreen />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "fast" }));
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  expect(input).toHaveProperty("value", "vendor-private-model");
  await user.clear(input);
  await user.type(input, "org/custom-v2");
  await user.click(screen.getByRole("button", { name: "Save model" }));

  await waitFor(() =>
    expect(stub.calls.some((call) => call.url === "/api/models/fast")).toBe(true),
  );
  const put = stub.calls.find((call) => call.url === "/api/models/fast");
  const body = JSON.parse(String(put?.init?.body)) as { targets: { model: string }[] };
  expect(body.targets[0]?.model).toBe("org/custom-v2");
});

test("opening and saving an existing custom target does not rewrite it", async () => {
  const stub = stubModels([
    modelFixture({
      targets: [targetFixture({ provider: "openai", model: "account-deployment-name" })],
    }),
  ]);
  renderWithProviders(<ModelsScreen />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "fast" }));
  await user.click(screen.getByRole("button", { name: "Save model" }));

  await waitFor(() =>
    expect(stub.calls.some((call) => call.url === "/api/models/fast")).toBe(true),
  );
  const put = stub.calls.find((call) => call.url === "/api/models/fast");
  const body = JSON.parse(String(put?.init?.body)) as {
    targets: { provider: string; model: string }[];
  };
  expect(body.targets[0]).toMatchObject({
    provider: "openai",
    model: "account-deployment-name",
  });
});
```

Also strengthen existing `new model saves a complete virtual model` test after parsing its PUT body:

```ts
const put = stub.calls.find((call) => call.url === "/api/models/new");
const body = JSON.parse(String(put?.init?.body)) as {
  targets: { provider: string; model: string }[];
};
expect(body.targets[0]).toMatchObject({ provider: "anthropic", model: "claude-opus-5" });
```

- [ ] **Step 3: Run model tests and verify expected failures**

Run:

```bash
bun run --cwd apps/dashboard test test/features/models.test.tsx
```

Expected failures:

- `emptyTarget("kimi").model` is still empty.
- target fields are plain textboxes, not comboboxes.
- provider change retains old model.

- [ ] **Step 4: Make target creation read catalog defaults**

In `apps/dashboard/src/features/models/ModelEditor.tsx`, add:

```ts
import { PROVIDER_MODEL_CATALOG } from "@omni/ir";
```

Change `emptyTarget` model field only:

```ts
export function emptyTarget(provider: ProviderId): Target {
  return {
    provider,
    model: PROVIDER_MODEL_CATALOG[provider].defaultModel,
    tier: 1,
    weight: 1,
    costPerMTok: { input: 0, output: 0 },
    capabilities: { tools: true, images: false, reasoning: false },
  };
}
```

Keep Add target code calling `emptyTarget("anthropic")`. Existing `blankModel()` in `_app.models.tsx` then inherits same default without duplication.

- [ ] **Step 5: Replace target model input and atomically reset provider/model**

In `apps/dashboard/src/features/models/TargetRow.tsx`, add:

```ts
import { PROVIDER_MODEL_CATALOG } from "@omni/ir";
import { ProviderModelInput } from "./ProviderModelInput.tsx";
```

Replace provider `onChange` with:

```tsx
onChange={(event) => {
  const provider = event.target.value as ProviderId;
  onChange({ provider, model: PROVIDER_MODEL_CATALOG[provider].defaultModel });
}}
```

Replace plain model `<input>` with:

```tsx
<ProviderModelInput
  onChange={(model) => onChange({ model })}
  provider={target.provider}
  targetNumber={index + 1}
  value={target.model}
/>
```

Keep surrounding `Model` label. Do not patch `capabilities`, cost, tier, or weight during provider or model changes.

- [ ] **Step 6: Run focused dashboard tests**

Run:

```bash
bun run --cwd apps/dashboard test test/features/provider-model-input.test.tsx test/features/models.test.tsx
```

Expected: PASS. Confirm existing tests finding model by display value still pass because combobox remains a native input.

- [ ] **Step 7: Run complete required verification**

Run from repository root, in order:

```bash
bun test
bun run typecheck
bun run lint
```

Expected:

- `bun test`: PASS with no live network calls.
- `bun run typecheck`: core and dashboard typechecks PASS.
- `bun run lint`: PASS. Existing informational `linter.recommended` deprecation notice is not a task failure.

If Biome reports only formatting in touched files, run:

```bash
bunx biome format --write \
  packages/ir/src/model-catalog.ts \
  packages/ir/src/index.ts \
  packages/ir/test/model-catalog.test.ts \
  apps/dashboard/src/features/models/ProviderModelInput.tsx \
  apps/dashboard/src/features/models/ModelEditor.tsx \
  apps/dashboard/src/features/models/TargetRow.tsx \
  apps/dashboard/test/features/provider-model-input.test.tsx \
  apps/dashboard/test/features/models.test.tsx
```

Then rerun focused tests, `bun test`, `bun run typecheck`, and `bun run lint` before claiming completion.

- [ ] **Step 8: Commit editor integration**

```bash
git add \
  apps/dashboard/src/features/models/ModelEditor.tsx \
  apps/dashboard/src/features/models/TargetRow.tsx \
  apps/dashboard/test/features/models.test.tsx
git commit -m "feat(dashboard): apply provider model defaults"
```

- [ ] **Step 9: Inspect final branch state**

Run:

```bash
git status --short --branch
git log --oneline -5
```

Expected: clean `feat/provider-model-catalog` working tree containing spec and plan commits plus three implementation commits. Do not push or open a PR unless user explicitly requests it.
