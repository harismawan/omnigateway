import { useState } from "react";
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

const Terms = styled(Input)`
  flex: 1;
  min-width: 260px;
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
 * The three text filters, and the word that names each in the combined box.
 *
 * A prefix rather than one box searched across all three: "requested `fast`,
 * resolved `claude-opus-4`" is two facts about one row and an operator has to be
 * able to ask for both at once, which a single value matched against any column
 * cannot express. `resolved` is an alias for `model` because the bare form
 * already means resolved, so the explicit spelling should too.
 */
const TERMS = [
  { prefix: "model", field: "resolvedModel" },
  { prefix: "resolved", field: "resolvedModel" },
  { prefix: "requested", field: "requestedModel" },
  { prefix: "error", field: "errorCode" },
] as const satisfies ReadonlyArray<{ prefix: string; field: keyof LogFilters }>;

/** What the box writes, and the only keys it may clear. */
const TERM_FIELDS = ["resolvedModel", "requestedModel", "errorCode"] as const;

type TermFilters = Pick<LogFilters, (typeof TERM_FIELDS)[number]>;

/**
 * Reads the combined box into exact filters.
 *
 * Split on whitespace, so no value may contain a space — none of the three can:
 * a model name or an error code with a space in it is not a thing this gateway
 * records, and quoting would be syntax to carry for a case that cannot arise.
 *
 * A word whose prefix is not one of the four is a bare term, not a dropped one:
 * model names carry colons — Ollama's `llama3:8b`, and whatever a custom endpoint
 * is asked for — so a colon cannot be read as "this names a field" on its own.
 * Dropping those would also make the text and the filters disagree permanently,
 * since the box is resynced from the filters it produced.
 */
export function parseTerms(text: string): TermFilters {
  const out: TermFilters = {};
  for (const word of text.trim().split(/\s+/)) {
    if (word === "") continue;
    const at = word.indexOf(":");
    const term =
      at === -1
        ? undefined
        : TERMS.find((entry) => entry.prefix === word.slice(0, at).toLowerCase());
    if (term === undefined) {
      out.resolvedModel = word;
      continue;
    }
    // `model:` with nothing after it is a filter being typed, not an empty one.
    const value = word.slice(at + 1);
    if (value !== "") out[term.field] = value;
  }
  return out;
}

/**
 * Writes exact filters back as box text.
 *
 * Only for filters that arrived from somewhere other than typing — "Clear
 * filters", or a board restoring state. A resolved model is written bare so the
 * common case round-trips as the operator typed it.
 */
export function formatTerms(filters: LogFilters): string {
  const parts: string[] = [];
  if (filters.resolvedModel !== undefined) parts.push(filters.resolvedModel);
  if (filters.requestedModel !== undefined) parts.push(`requested:${filters.requestedModel}`);
  if (filters.errorCode !== undefined) parts.push(`error:${filters.errorCode}`);
  return parts.join(" ");
}

const sameTerms = (a: TermFilters, b: TermFilters): boolean =>
  TERM_FIELDS.every((field) => a[field] === b[field]);

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
 * Every control emits an id or an exact value, never a substring. The three text
 * filters share one box, read by `parseTerms`: a bare word is the resolved model,
 * and `requested:` or `error:` name the other two. One box because they are one
 * question typed in one place, but still three parameters on the wire — the
 * prefix decides which, so "requested `fast` that resolved to `claude-opus-4`"
 * stays askable, which a single value matched against any of the three columns
 * could not express.
 *
 * This is not the box that used to be here. That one matched model, account
 * label, key label and error code by *substring*, over a *fetched tail* — so it
 * answered "among the newest N rows" while reading as "in the log". Every term
 * here is an exact value the gateway applies before the page limit.
 *
 * Labels come from the credential and key lists, but the value sent is always
 * the stored id: rows outlive the keys and accounts that made them, so a
 * renamed or deleted label must not change which rows an old filter selects.
 */
export function LogFilterBar({ filters, onChange, operator = false }: LogFilterBarProps) {
  const catalog = useProviderCatalog();

  const patch = (next: FilterPatch): void => onChange(applyPatch(filters, next));

  // The box holds its own text, because the filters cannot reconstruct it: an
  // incomplete `model:` parses to nothing, and rewriting the field from the
  // parsed filters on every keystroke would delete what is being typed. Resynced
  // only when the incoming filters stop matching the text — "Clear filters" and
  // nothing else, in practice, since no other control touches these three.
  const [text, setText] = useState(() => formatTerms(filters));
  const fromFilters = formatTerms(filters);
  // The second condition is what bounds this: after the assignment `text` is
  // `fromFilters`, so the next render cannot set it again whatever the parse of
  // it says. Comparing only the parse would spin on any value the two functions
  // are not exact inverses for.
  if (!sameTerms(parseTerms(text), filters) && text !== fromFilters) setText(fromFilters);

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

      <Terms
        aria-label="Models and error codes"
        placeholder="claude-opus-4  requested:fast  error:UPSTREAM"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          // Every term key is cleared first, so deleting a word removes its
          // filter rather than leaving the last one that was parsed.
          patch({
            resolvedModel: undefined,
            requestedModel: undefined,
            errorCode: undefined,
            ...parseTerms(event.target.value),
          });
        }}
      />

      {operator ? <OperatorFilters filters={filters} patch={patch} /> : null}

      <Button type="button" onClick={() => onChange({})}>
        Clear filters
      </Button>
    </Bar>
  );
}
