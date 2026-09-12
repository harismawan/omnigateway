import styled from "styled-components";
import { useCredentials, useKeys, useProviderCatalog } from "../../api/queries.ts";
import type { LogFilters } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Input, Select } from "../../ui/Field.tsx";
import { Row } from "../../ui/primitives.ts";

const Bar = styled(Row)`
  gap: ${({ theme }) => theme.space(2)};
  flex-wrap: wrap;
`;

const Narrow = styled(Select)`
  width: auto;
`;

const Exact = styled(Input)`
  width: 170px;
`;

const When = styled(Input)`
  width: 200px;
`;

/**
 * The state control's four positions, folded from two wire filters.
 *
 * `failed` is not a third value of `state` on the wire — it is a completed row
 * with an error status, so it implies `state=done` and carries its own
 * predicate. It is one control here because "pending, done, or failed" is one
 * question an operator asks, and offering `state` and `failed` as independent
 * controls would let them ask for a pending row that failed, which is nothing.
 */
const STATES = [
  { id: "all", label: "All requests", filters: {} },
  { id: "failed", label: "Failed only", filters: { failed: "true" } },
  { id: "pending", label: "Still running", filters: { state: "pending" } },
  { id: "done", label: "Completed", filters: { state: "done" } },
] as const satisfies ReadonlyArray<{ id: string; label: string; filters: Partial<LogFilters> }>;

type StateId = (typeof STATES)[number]["id"];

const stateIdOf = (filters: LogFilters): StateId =>
  filters.failed === "true" ? "failed" : (filters.state ?? "all");

/**
 * `datetime-local` renders in the browser's zone and yields a naive string, so
 * the two conversions are not symmetric: reading subtracts the offset the
 * browser applied, writing adds it back. Empty means the bound is absent, which
 * is a different fact from the epoch.
 */
const toLocalInput = (at: number | undefined): string =>
  at === undefined
    ? ""
    : new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const fromLocalInput = (text: string): number | undefined => {
  if (text === "") return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * The two controls that name operator infrastructure.
 *
 * Its own component so the `operator` gate is a mount, not a branch inside a
 * render: the credential and key queries live here, and a client session — which
 * may reach neither route — never runs them.
 */
function OperatorFilters({
  filters,
  patch,
}: {
  filters: LogFilters;
  patch: (next: FilterPatch) => void;
}) {
  const credentials = useCredentials();
  const keys = useKeys();
  return (
    <>
      <Narrow
        aria-label="Account"
        value={filters.credentialId ?? ""}
        onChange={(event) => patch({ credentialId: event.target.value || undefined })}
      >
        <option value="">Any account</option>
        {(credentials.data ?? []).map((credential) => (
          <option key={credential.id} value={credential.id}>
            {credential.label}
          </option>
        ))}
      </Narrow>
      <Narrow
        aria-label="Gateway key"
        value={filters.apiKeyId ?? ""}
        onChange={(event) => patch({ apiKeyId: event.target.value || undefined })}
      >
        <option value="">Any key</option>
        {(keys.data ?? []).map((key) => (
          <option key={key.id} value={key.id}>
            {key.label}
          </option>
        ))}
      </Narrow>
    </>
  );
}

/**
 * A change to some of the filters, where `undefined` means "clear this one".
 *
 * Distinct from `Partial<LogFilters>`, which under `exactOptionalPropertyTypes`
 * means the key may be absent but never explicitly `undefined` — and a control
 * clearing itself has to say which key it is clearing.
 */
type FilterPatch = { [K in keyof LogFilters]?: LogFilters[K] | undefined };

/**
 * Applies a patch and drops every cleared key.
 *
 * The keys are removed rather than left holding `undefined` because the query
 * key is built from this object: `{provider: undefined}` and `{}` are the same
 * question, and leaving the difference in would give them two cache entries and
 * two fetches for one filter state.
 */
function applyPatch(filters: LogFilters, next: FilterPatch): LogFilters {
  const merged: FilterPatch = { ...filters, ...next };
  for (const key of Object.keys(merged) as Array<keyof LogFilters>) {
    if (merged[key] === undefined) delete merged[key];
  }
  // Every field is optional, so a patch with its cleared keys removed is a
  // `LogFilters`; the assertion is only because the mapped type above widened
  // each of them by `undefined` on the way through.
  return merged as LogFilters;
}

export type LogFilterBarProps = {
  filters: LogFilters;
  onChange: (next: LogFilters) => void;
  /**
   * Whether to offer the two controls that name operator infrastructure.
   *
   * The client surface passes `false`, and that is the console half of a rule
   * the route enforces independently: `/api/client/logs` accepts neither
   * parameter. Two gates, because a control that is merely hidden is a control
   * somebody re-enables while believing the server still refuses it.
   */
  operator?: boolean;
};

/**
 * The exact filters both log boards send to the gateway.
 *
 * Every control emits an id or an exact value, never a substring. The board
 * previously carried a free-text box that matched model, account label, key
 * label and error code by substring over a *fetched tail* — a question no
 * server-side `=` can answer, and one that silently meant "among the newest N
 * rows" rather than "in the log". It is gone rather than reimplemented, because
 * a search box that quietly matches a different set than it used to is worse
 * than one that is not there.
 *
 * Labels come from the credential and key lists, but the value sent is always
 * the stored id: rows outlive the keys and accounts that made them, so a
 * renamed or deleted label must not change which rows an old filter selects.
 */
export function LogFilterBar({ filters, onChange, operator = false }: LogFilterBarProps) {
  const catalog = useProviderCatalog();

  const patch = (next: FilterPatch): void => onChange(applyPatch(filters, next));

  return (
    <Bar>
      <When
        type="datetime-local"
        aria-label="From"
        value={toLocalInput(filters.since)}
        onChange={(event) => patch({ since: fromLocalInput(event.target.value) })}
      />
      <When
        type="datetime-local"
        aria-label="To"
        value={toLocalInput(filters.until)}
        onChange={(event) => patch({ until: fromLocalInput(event.target.value) })}
      />

      <Narrow
        aria-label="Show which requests"
        value={stateIdOf(filters)}
        onChange={(event) => {
          const chosen = STATES.find((entry) => entry.id === event.target.value) ?? STATES[0];
          // Both keys are cleared first: the four positions are exclusive, and
          // a patch that only sets the new one would leave `failed=true` on a
          // switch to "Still running".
          patch({ state: undefined, failed: undefined, ...chosen.filters });
        }}
      >
        {STATES.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </Narrow>

      <Narrow
        aria-label="Provider"
        value={filters.provider ?? ""}
        onChange={(event) => patch({ provider: event.target.value || undefined })}
      >
        <option value="">Any provider</option>
        {(catalog.data ?? []).map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.label}
          </option>
        ))}
      </Narrow>

      <Exact
        aria-label="Requested model"
        placeholder="Requested model"
        value={filters.requestedModel ?? ""}
        onChange={(event) => patch({ requestedModel: event.target.value || undefined })}
      />
      <Exact
        aria-label="Resolved model"
        placeholder="Resolved model"
        value={filters.resolvedModel ?? ""}
        onChange={(event) => patch({ resolvedModel: event.target.value || undefined })}
      />

      {operator ? <OperatorFilters filters={filters} patch={patch} /> : null}

      <Exact
        aria-label="Error code"
        placeholder="Error code"
        value={filters.errorCode ?? ""}
        onChange={(event) => patch({ errorCode: event.target.value || undefined })}
      />

      <Button type="button" onClick={() => onChange({})}>
        Clear filters
      </Button>
    </Bar>
  );
}
