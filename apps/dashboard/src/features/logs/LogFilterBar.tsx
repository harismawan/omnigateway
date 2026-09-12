import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { useCredentials, useKeys, useProviderCatalog } from "../../api/queries.ts";
import type { LogFilters } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Input, Select } from "../../ui/Field.tsx";
import { Row } from "../../ui/primitives.ts";
import { DateRangeField } from "./DateRangeField.tsx";

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
 * The text filters, and the word that names each in the combined box.
 *
 * A prefix rather than one box searched across all of them: "requested `fast`,
 * resolved `claude-opus-4`" is two facts about one row and an operator has to be
 * able to ask for both at once, which a single value matched against any column
 * cannot express.
 *
 * A bare word is `model`, which matches *either* name — the requested one or the
 * resolved one — and matches it as a substring, case-insensitively. Both halves
 * are there for the same reason: the two columns hold different vocabularies, and
 * neither holds the spelling an operator has. `opus` is only ever a requested
 * name, `claude-opus-5` only ever a resolved one, and `opus` is what somebody
 * types. Every narrowing that answered nothing read as "no such traffic" rather
 * than "wrong column, wrong spelling". `requested:` and `resolved:` stay for the
 * question that really is about one side.
 */
const TERMS = [
  { prefix: "model", field: "model" },
  { prefix: "resolved", field: "resolvedModel" },
  { prefix: "requested", field: "requestedModel" },
  { prefix: "error", field: "errorCode" },
] as const satisfies ReadonlyArray<{ prefix: string; field: keyof LogFilters }>;

/** What the box writes, and the only keys it may clear. */
const TERM_FIELDS = ["model", "resolvedModel", "requestedModel", "errorCode"] as const;

type TermFilters = Pick<LogFilters, (typeof TERM_FIELDS)[number]>;

/**
 * Reads the combined box into exact filters.
 *
 * Split on whitespace, so no value may contain a space — none of them can: a
 * model name or an error code with a space in it is not a thing this gateway
 * records, and quoting would be syntax to carry for a case that cannot arise.
 * Each word is a substring the gateway matches, so a fragment is a whole filter
 * and there is nothing to complete.
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
      out.model = word;
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
 * filters", or a board restoring state. The either-column term is written bare
 * so the common case round-trips as the operator typed it.
 */
export function formatTerms(filters: LogFilters): string {
  const parts: string[] = [];
  if (filters.model !== undefined) parts.push(filters.model);
  if (filters.resolvedModel !== undefined) parts.push(`resolved:${filters.resolvedModel}`);
  if (filters.requestedModel !== undefined) parts.push(`requested:${filters.requestedModel}`);
  if (filters.errorCode !== undefined) parts.push(`error:${filters.errorCode}`);
  return parts.join(" ");
}

const sameTerms = (a: TermFilters, b: TermFilters): boolean =>
  TERM_FIELDS.every((field) => a[field] === b[field]);

/**
 * Every term key cleared, which each keystroke writes before what it parsed.
 *
 * Derived from `TERM_FIELDS` rather than listed again: a term added there and
 * forgotten here would be a filter deleting its word does not remove, so it
 * would outlive the text that set it with no control left pointing at it.
 */
const CLEAR_TERMS: FilterPatch = Object.fromEntries(TERM_FIELDS.map((field) => [field, undefined]));

/**
 * How long the box waits before it asks.
 *
 * Cost, not correctness. A half-typed term is a *wider* filter now that the
 * terms match substrings, so every prefix of a name answers with rows rather
 * than blanking the board — that was the original reason for waiting and it
 * stopped being true when the filters became `LIKE`. What remains is the price:
 * a leading wildcard has no prefix to seek, so each keystroke scans
 * `request_logs` end to end, and on SQLite that scan is the event loop.
 *
 * A second was too long to leave a board unresponsive for a filter that now
 * shows partial matches as you type; 500ms still folds a typed word into one
 * scan at any human rate.
 *
 * The other controls stay immediate. They emit values that exist by
 * construction, chosen rather than typed, so there is no half-finished state to
 * wait out.
 */
export const TERM_DEBOUNCE_MS = 500;

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
 * Every control either emits an id it was given or a fragment somebody typed. The
 * typed ones share one box, read by `parseTerms`: a bare word is the model under
 * either of its names, and `requested:`, `resolved:` or `error:` name one column
 * each. One box because they are one question typed in one place, but still
 * separate parameters on the wire — the prefix decides which, so "requested
 * `opus` that resolved to `claude-opus-5`" stays askable, which one value matched
 * across every column could not express.
 *
 * This is not the box that used to be here, and the difference is *where* the
 * matching happens rather than how. That one filtered a *fetched tail* in the
 * browser, so it answered "among the newest N rows" while reading as "in the
 * log". These terms go to the gateway, which applies them before the page limit.
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
  // nothing else, in practice, since no other control touches these keys.
  const [text, setText] = useState(() => formatTerms(filters));

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The pending patch runs after the render that armed it, so it must not close
  // over that render's `filters`: another control may have changed them while
  // the operator was still typing, and a stale merge would revert it.
  const patchRef = useRef(patch);
  patchRef.current = patch;

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  // Unmount only — the board is one screen away from every other one, and a
  // timer that outlives it patches filters nothing is reading. Spelled out
  // rather than reusing `cancel`, which is a new function every render: as a
  // dependency it would re-run this on each one, and the cleanup it ran on the
  // way would clear the timer the previous render had just armed.
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  const fromFilters = formatTerms(filters);
  // Skipped while a keystroke is pending, because the disagreement is then the
  // point: the text is ahead of the filters by design and rewriting it from
  // them would delete what is being typed.
  //
  // The last condition is what bounds the rest: after the assignment `text` is
  // `fromFilters`, so the next render cannot set it again whatever the parse of
  // it says. Comparing only the parse would spin on any value the two functions
  // are not exact inverses for.
  if (timer.current === null && !sameTerms(parseTerms(text), filters) && text !== fromFilters) {
    setText(fromFilters);
  }

  return (
    <Bar>
      <Terms
        aria-label="Models and error codes"
        placeholder="Search anything"
        value={text}
        onChange={(event) => {
          const typed = event.target.value;
          setText(typed);
          cancel();
          timer.current = setTimeout(() => {
            timer.current = null;
            patchRef.current({ ...CLEAR_TERMS, ...parseTerms(typed) });
          }, TERM_DEBOUNCE_MS);
        }}
      />

      <DateRangeField
        since={filters.since}
        until={filters.until}
        onChange={(next) => patch(next)}
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

      {operator ? <OperatorFilters filters={filters} patch={patch} /> : null}

      <Button
        type="button"
        onClick={() => {
          // Both explicitly, rather than leaving the resync to notice: a pending
          // keystroke would otherwise land 300ms later and put the term back.
          cancel();
          setText("");
          onChange({});
        }}
      >
        Clear filters
      </Button>
    </Bar>
  );
}
