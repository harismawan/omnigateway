import { Plus, X } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import styled from "styled-components";
import { useCreateExportDestination, useUpdateExportDestination } from "../../api/queries.ts";
import type {
  ExportDestinationPatch,
  ExportDestinationType,
  ExportDestinationView,
  ExportFilter,
} from "../../api/types.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Field, Input, Textarea } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Legend, Row, Spacer, Stack } from "../../ui/primitives.ts";
import { Select } from "../../ui/Select.tsx";
import { describeError } from "../../ui/States.tsx";
import { Toggle } from "../../ui/Toggle.tsx";

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Note = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const Warn = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

const Lines = styled(Textarea)`
  min-height: 64px;
  font-family: ${({ theme }) => theme.font.mono};
`;

const Group = styled(Stack)`
  padding-top: ${({ theme }) => theme.space(2)};
  border-top: 1px solid ${({ theme }) => theme.color.rule};
`;

const Switch = styled.label`
  font-size: 12px;
  color: ${({ theme }) => theme.color.ink};
`;

/** The index pattern a new Elasticsearch destination starts with; the gateway's own default. */
const DEFAULT_INDEX = "omni-logs-{yyyy.MM.dd}";

const TYPE_OPTIONS = [
  { value: "webhook", label: "Webhook", detail: "POST JSON batches, optionally signed" },
  { value: "elasticsearch", label: "Elasticsearch", detail: "or OpenSearch, through _bulk" },
  { value: "otlp", label: "OTLP", detail: "logs or traces over HTTP, e.g. Langfuse" },
] as const;

const AUTH_OPTIONS = [
  { value: "apiKey", label: "API key" },
  { value: "basic", label: "Username and password" },
  { value: "none", label: "None" },
];

type Auth = "apiKey" | "basic" | "none";

/** What the save does with the stored secret. A new destination is always `replace`. */
type SecretMode = "keep" | "replace" | "clear";

/**
 * One filter dimension. Control reads an absent list as "every", an empty one
 * as "none" (match nothing) and a non-empty one as "only these" — three facts,
 * so the draft keeps three, and a blank list field is never read as "every".
 */
type Scope = "all" | "none" | "list";

/** A secret header row. The value is entered masked; rows are never prefilled. */
type HeaderRow = { key: number; name: string; value: string };

type Draft = {
  type: ExportDestinationType;
  id: string;
  startFrom: "now" | "oldest";
  url: string;
  index: string;
  auth: Auth;
  flavor: "elasticsearch" | "opensearch";
  headers: string;
  endpoint: string;
  signal: "logs" | "traces";
  keysScope: Scope;
  keys: string;
  modelsScope: Scope;
  models: string;
  failedOnly: boolean;
  maxRequestBytes: string;
  /** Secret fields: always blank to start, never prefilled. */
  apiKey: string;
  username: string;
  password: string;
  signingSecret: string;
  secretHeaders: HeaderRow[];
};

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

function headerLines(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  return Object.entries(value)
    .map(([name, v]) => `${name}: ${str(v)}`)
    .join("\n");
}

function scopeOf(list: readonly string[] | undefined): Scope {
  if (list === undefined) return "all";
  return list.length === 0 ? "none" : "list";
}

function draftOf(editing: ExportDestinationView | null): Draft {
  const c = editing?.config ?? {};
  const auth = str(c.auth, "apiKey");
  return {
    type: editing?.type ?? "webhook",
    id: editing?.id ?? "",
    startFrom: "now",
    url: str(c.url),
    index: str(c.index, DEFAULT_INDEX),
    auth: auth === "basic" || auth === "none" ? auth : "apiKey",
    flavor: c.flavor === "opensearch" ? "opensearch" : "elasticsearch",
    headers: headerLines(c.headers),
    endpoint: str(c.endpoint),
    signal: c.signal === "traces" ? "traces" : "logs",
    keysScope: scopeOf(editing?.filter.apiKeyIds),
    keys: editing?.filter.apiKeyIds?.join(", ") ?? "",
    modelsScope: scopeOf(editing?.filter.models),
    models: editing?.filter.models?.join(", ") ?? "",
    failedOnly: editing?.filter.failedOnly === true,
    maxRequestBytes: editing?.maxRequestBytes == null ? "" : String(editing.maxRequestBytes),
    apiKey: "",
    username: "",
    password: "",
    signingSecret: "",
    secretHeaders: [],
  };
}

/** `name: value` per line. Malformed lines are refused here, naming the line, never echoing a value. */
function parseHeaders(text: string, label: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  const lines = text.split("\n").map((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return `${label}, line ${index + 1}: write it as name: value.`;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

const listOf = (text: string): string[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/** One dimension as the wire carries it: absent (all), `[]` (none), or the list. */
function dimensionOf(scope: Scope, text: string, label: string): string[] | undefined | string {
  if (scope === "all") return undefined;
  if (scope === "none") return [];
  const list = listOf(text);
  return list.length === 0 ? `List at least one under ${label}, or choose all or none.` : list;
}

function filterOf(draft: Draft): ExportFilter | string {
  const keys = dimensionOf(draft.keysScope, draft.keys, "Keys");
  if (typeof keys === "string") return keys;
  const models = dimensionOf(draft.modelsScope, draft.models, "Models");
  if (typeof models === "string") return models;
  return {
    ...(keys === undefined ? {} : { apiKeyIds: keys }),
    ...(models === undefined ? {} : { models }),
    ...(draft.failedOnly ? { failedOnly: true } : {}),
  };
}

/**
 * Secret header rows as a record, or a problem naming the row by number —
 * never by its value. A wholly blank row is ignored; a named row may have an
 * empty value, as control's header schema allows.
 */
function secretHeadersOf(rows: readonly HeaderRow[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const [index, row] of rows.entries()) {
    const name = row.name.trim();
    if (name.length === 0 && row.value.length === 0) continue;
    if (name.length === 0) return `Secret header ${index + 1} needs a name.`;
    // An empty value is a header the gateway accepts and sends as such.
    out[name] = row.value;
  }
  return out;
}

function configOf(draft: Draft): Record<string, unknown> | string {
  switch (draft.type) {
    case "elasticsearch":
      return {
        url: draft.url.trim(),
        index: draft.index.trim(),
        auth: draft.auth,
        flavor: draft.flavor,
      };
    case "webhook": {
      const headers = parseHeaders(draft.headers, "Headers");
      if (typeof headers === "string") return headers;
      return { url: draft.url.trim(), headers };
    }
    case "otlp":
      return { endpoint: draft.endpoint.trim(), signal: draft.signal };
  }
}

/**
 * The secret object the form describes, `null` when it describes none, or a
 * problem. Only read when the secret is being written.
 */
function secretOf(draft: Draft): Record<string, unknown> | null | string {
  switch (draft.type) {
    case "elasticsearch":
      if (draft.auth === "none") return null;
      if (draft.auth === "apiKey") {
        return draft.apiKey.length === 0 ? "Enter the API key." : { apiKey: draft.apiKey };
      }
      return draft.username.length === 0 || draft.password.length === 0
        ? "Enter the username and the password."
        : { username: draft.username, password: draft.password };
    case "webhook": {
      const headers = secretHeadersOf(draft.secretHeaders);
      if (typeof headers === "string") return headers;
      const any = Object.keys(headers).length > 0;
      if (!any && draft.signingSecret.length === 0) return null;
      return {
        ...(draft.signingSecret.length === 0 ? {} : { signingSecret: draft.signingSecret }),
        ...(any ? { headers } : {}),
      };
    }
    case "otlp": {
      const headers = secretHeadersOf(draft.secretHeaders);
      if (typeof headers === "string") return headers;
      return Object.keys(headers).length === 0 ? null : { headers };
    }
  }
}

function maxBytesOf(draft: Draft): number | null | string {
  const text = draft.maxRequestBytes.trim();
  if (text.length === 0) return null;
  const value = Number(text);
  return Number.isInteger(value) && value > 0
    ? value
    : "Max request size is a whole number of bytes, or blank for the default.";
}

export type ExportEditorProps = {
  /** `"new"` to create; otherwise the destination being edited. */
  editing: ExportDestinationView | "new";
  onOpenChange: (open: boolean) => void;
};

/**
 * Creates or edits one export destination.
 *
 * Secrets are never prefilled — the console never has them. Editing shows
 * whether one is set and offers to replace it (typed in whole) or clear it;
 * otherwise the save leaves it alone. The filter is sent only when touched, so
 * an unrelated edit cannot turn an unreadable (match-nothing) filter into
 * "every request". Errors are the gateway's own fixed messages, shown as is.
 */
export function ExportEditor({ editing, onOpenChange }: ExportEditorProps) {
  const current = editing === "new" ? null : editing;
  const create = useCreateExportDestination();
  const update = useUpdateExportDestination();
  const [draft, setDraft] = useState<Draft>(() => draftOf(current));
  const [secretMode, setSecretMode] = useState<SecretMode>(current === null ? "replace" : "keep");
  const [filterTouched, setFilterTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const failedId = useId();
  const nextRow = useRef(0);
  const bodiesId = useId();

  const busy = create.isPending || update.isPending;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const setFilter = <K extends "keysScope" | "keys" | "modelsScope" | "models" | "failedOnly">(
    key: K,
    value: Draft[K],
  ) => {
    setFilterTouched(true);
    set(key, value);
  };

  /** An Elasticsearch auth change cannot keep a credential written for another mode. */
  const chooseAuth = (auth: Auth) => {
    set("auth", auth);
    if (current === null) return;
    if (auth === "none") setSecretMode(current.hasSecret ? "clear" : "keep");
    else if (auth !== str(current.config.auth)) setSecretMode("replace");
  };

  const fail = (error: unknown) => setProblem(describeError(error));

  const submit = () => {
    setProblem(null);
    const config = configOf(draft);
    if (typeof config === "string") return setProblem(config);
    const maxRequestBytes = maxBytesOf(draft);
    if (typeof maxRequestBytes === "string") return setProblem(maxRequestBytes);
    const secret = secretMode === "replace" ? secretOf(draft) : null;
    if (typeof secret === "string") return setProblem(secret);
    const filter = filterOf(draft);
    if (typeof filter === "string") return setProblem(filter);

    if (current === null) {
      if (draft.id.trim().length === 0) return setProblem("Give the destination an ID.");
      create.mutate(
        {
          id: draft.id.trim(),
          type: draft.type,
          startFrom: draft.startFrom,
          enabled: true,
          config,
          filter,
          maxRequestBytes,
          ...(secret === null ? {} : { secret }),
        },
        { onSuccess: () => onOpenChange(false), onError: fail },
      );
      return;
    }

    if (secretMode === "replace" && secret === null) {
      return setProblem("Enter the new secret, or use Clear secret to remove it.");
    }
    const patch: ExportDestinationPatch = {
      config,
      ...(filterTouched ? { filter } : {}),
      maxRequestBytes,
      ...(secretMode === "keep" ? {} : { secret: secretMode === "clear" ? null : secret }),
    };
    update.mutate(
      { id: current.id, patch },
      { onSuccess: () => onOpenChange(false), onError: fail },
    );
  };

  const secretInput = (
    key: "apiKey" | "username" | "password" | "signingSecret",
    label: string,
  ) => (
    <Field label={label}>
      {(props) => (
        <Input
          {...props}
          // The username too: it is half of the encrypted credential.
          type="password"
          autoComplete="off"
          value={draft[key]}
          onChange={(event) => set(key, event.target.value)}
        />
      )}
    </Field>
  );

  const setHeaderRow = (key: number, patch: Partial<HeaderRow>) =>
    set(
      "secretHeaders",
      draft.secretHeaders.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );

  const secretHeadersInput = (
    <Stack $gap={1}>
      <Legend>Secret headers</Legend>
      {draft.secretHeaders.map((row, index) => (
        <Row key={row.key} $gap={1}>
          <Input
            aria-label={`Secret header ${index + 1} name`}
            placeholder="authorization"
            autoComplete="off"
            value={row.name}
            onChange={(event) => setHeaderRow(row.key, { name: event.target.value })}
          />
          <Input
            aria-label={`Secret header ${index + 1} value`}
            type="password"
            autoComplete="off"
            value={row.value}
            onChange={(event) => setHeaderRow(row.key, { value: event.target.value })}
          />
          <IconButton
            type="button"
            $variant="ghost"
            $size="sm"
            aria-label={`Remove secret header ${index + 1}`}
            title="Remove this header"
            onClick={() =>
              set(
                "secretHeaders",
                draft.secretHeaders.filter((candidate) => candidate.key !== row.key),
              )
            }
          >
            <X />
          </IconButton>
        </Row>
      ))}
      <Row>
        <Button
          type="button"
          $size="sm"
          onClick={() => {
            const key = nextRow.current++;
            set("secretHeaders", [...draft.secretHeaders, { key, name: "", value: "" }]);
          }}
        >
          <Plus />
          Add secret header
        </Button>
      </Row>
      <Note>Sent with every request and stored encrypted, e.g. authorization: Bearer …</Note>
    </Stack>
  );

  const secretFields =
    draft.type === "elasticsearch" ? (
      draft.auth === "none" ? null : draft.auth === "apiKey" ? (
        secretInput("apiKey", "API key")
      ) : (
        <>
          {secretInput("username", "Username")}
          {secretInput("password", "Password")}
        </>
      )
    ) : draft.type === "webhook" ? (
      <>
        {secretInput("signingSecret", "Signing secret")}
        {secretHeadersInput}
      </>
    ) : (
      secretHeadersInput
    );

  const takesSecret = !(draft.type === "elasticsearch" && draft.auth === "none");

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={current === null ? "Add an export destination" : `Edit ${current.id}`}
      description={
        current === null
          ? "Every completed request's log record — never its prompt or response — is sent here."
          : undefined
      }
      width="600px"
      footer={
        <>
          <Spacer />
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" $variant="primary" disabled={busy} onClick={submit}>
            {busy ? "Saving…" : current === null ? "Add destination" : "Save changes"}
          </Button>
        </>
      }
    >
      <Stack $gap={3}>
        {current === null ? (
          <>
            <Field label="Type">
              {(props) => (
                <Select
                  {...props}
                  value={draft.type}
                  options={TYPE_OPTIONS}
                  onValueChange={(type) => set("type", type as ExportDestinationType)}
                />
              )}
            </Field>
            <Field label="ID" hint="a-z, 0-9 and -, up to 40. Fixed once created.">
              {(props) => (
                <Input
                  {...props}
                  value={draft.id}
                  onChange={(event) => set("id", event.target.value)}
                />
              )}
            </Field>
            <Field label="Start from">
              {(props) => (
                <Select
                  {...props}
                  value={draft.startFrom}
                  options={[
                    { value: "now", label: "Now", detail: "what completes from here on" },
                    {
                      value: "oldest",
                      label: "Oldest retained request",
                      detail: "everything still kept",
                    },
                  ]}
                  onValueChange={(value) => set("startFrom", value === "oldest" ? "oldest" : "now")}
                />
              )}
            </Field>
          </>
        ) : null}

        {draft.type === "otlp" ? (
          <>
            <Field
              label="Endpoint"
              hint="The collector's base URL; /v1/logs or /v1/traces is appended."
            >
              {(props) => (
                <Input
                  {...props}
                  value={draft.endpoint}
                  onChange={(event) => set("endpoint", event.target.value)}
                />
              )}
            </Field>
            <Field label="Signal">
              {(props) => (
                <Select
                  {...props}
                  value={draft.signal}
                  options={[
                    { value: "logs", label: "Logs", detail: "one log record per request" },
                    { value: "traces", label: "Traces", detail: "one span per request" },
                  ]}
                  onValueChange={(value) => set("signal", value === "traces" ? "traces" : "logs")}
                />
              )}
            </Field>
          </>
        ) : (
          <Field
            label="URL"
            hint={
              draft.type === "elasticsearch"
                ? "The cluster's base URL."
                : "Posted to exactly as written. No credentials, query or fragment."
            }
          >
            {(props) => (
              <Input
                {...props}
                value={draft.url}
                onChange={(event) => set("url", event.target.value)}
              />
            )}
          </Field>
        )}

        {draft.type === "elasticsearch" ? (
          <>
            <Field label="Index" hint="{yyyy.MM.dd} is the request's day, in UTC.">
              {(props) => (
                <Input
                  {...props}
                  value={draft.index}
                  onChange={(event) => set("index", event.target.value)}
                />
              )}
            </Field>
            <Field label="Flavor">
              {(props) => (
                <Select
                  {...props}
                  value={draft.flavor}
                  options={[
                    { value: "elasticsearch", label: "Elasticsearch" },
                    { value: "opensearch", label: "OpenSearch" },
                  ]}
                  onValueChange={(value) =>
                    set("flavor", value === "opensearch" ? "opensearch" : "elasticsearch")
                  }
                />
              )}
            </Field>
            <Field label="Authentication">
              {(props) => (
                <Select
                  {...props}
                  value={draft.auth}
                  options={AUTH_OPTIONS}
                  onValueChange={(value) =>
                    chooseAuth(value === "basic" || value === "none" ? value : "apiKey")
                  }
                />
              )}
            </Field>
          </>
        ) : null}

        {draft.type === "webhook" ? (
          <Field
            label="Headers"
            hint="Sent with every batch and shown to readers. One per line, name: value."
          >
            {(props) => (
              <Lines
                {...props}
                rows={3}
                value={draft.headers}
                onChange={(event) => set("headers", event.target.value)}
              />
            )}
          </Field>
        ) : null}

        {takesSecret ? (
          <Group $gap={2}>
            {current === null ? (
              <Legend>Secret</Legend>
            ) : (
              <Row $gap={2}>
                <span>Secret: {current.hasSecret ? "set" : "not set"}</span>
                <Spacer />
                {secretMode === "keep" ? (
                  <>
                    <Button type="button" $size="sm" onClick={() => setSecretMode("replace")}>
                      {current.hasSecret ? "Replace secret" : "Set secret"}
                    </Button>
                    {current.hasSecret ? (
                      <Button
                        type="button"
                        $size="sm"
                        $variant="danger"
                        onClick={() => setSecretMode("clear")}
                      >
                        Clear secret
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Button type="button" $size="sm" onClick={() => setSecretMode("keep")}>
                    Keep the current secret
                  </Button>
                )}
              </Row>
            )}
            {secretMode === "clear" ? (
              <Warn role="status">The secret is removed when you save.</Warn>
            ) : null}
            {secretMode === "replace" ? secretFields : null}
            <Note>Stored encrypted. The console never shows it again.</Note>
          </Group>
        ) : current?.hasSecret === true ? (
          <Warn role="status">The stored credential is removed when you save.</Warn>
        ) : null}

        <Group $gap={2}>
          <Legend>Which requests</Legend>
          {current?.filterMalformed === true ? (
            <Warn role="status">
              The stored filter is unreadable, so nothing is exported. Set one below to fix it.
            </Warn>
          ) : null}
          <ScopeField
            label="Keys"
            listLabel="Only these keys"
            hint="API key IDs, comma-separated."
            scope={draft.keysScope}
            text={draft.keys}
            onScope={(scope) => setFilter("keysScope", scope)}
            onText={(text) => setFilter("keys", text)}
          />
          <ScopeField
            label="Models"
            listLabel="Only these models"
            hint="Requested or resolved model names, comma-separated."
            scope={draft.modelsScope}
            text={draft.models}
            onScope={(scope) => setFilter("modelsScope", scope)}
            onText={(text) => setFilter("models", text)}
          />
          <Row $gap={2}>
            <Toggle
              id={failedId}
              checked={draft.failedOnly}
              onCheckedChange={(checked) => setFilter("failedOnly", checked)}
              label="Failed requests only"
            />
            <Switch htmlFor={failedId}>Failed requests only</Switch>
          </Row>
        </Group>

        <Group $gap={2}>
          <Field
            label="Max request size (bytes)"
            hint="Blank for the type's default. Batches are cut to fit."
          >
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={draft.maxRequestBytes}
                onChange={(event) => set("maxRequestBytes", event.target.value)}
              />
            )}
          </Field>
          <Row $gap={2}>
            <Toggle
              id={bodiesId}
              checked={false}
              onCheckedChange={() => {}}
              label="Export bodies"
              disabled
            />
            <Switch htmlFor={bodiesId}>Export bodies</Switch>
          </Row>
          <Note>Body export is available in a later release; only metadata is sent.</Note>
        </Group>

        {problem === null ? null : <Problem role="alert">{problem}</Problem>}
      </Stack>
    </Modal>
  );
}

const Choices = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(3)};
  font-size: 12px;

  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  input {
    accent-color: ${({ theme }) => theme.color.accent};
  }
`;

const SCOPE_LABEL: Record<Scope, string> = { all: "all", none: "none", list: "only these" };

/** "All", "none" and "only these" as three visible choices, the list field only for the third. */
function ScopeField({
  label,
  listLabel,
  hint,
  scope,
  text,
  onScope,
  onText,
}: {
  label: string;
  listLabel: string;
  hint: string;
  scope: Scope;
  text: string;
  onScope: (scope: Scope) => void;
  onText: (text: string) => void;
}): ReactNode {
  const name = useId();
  return (
    <Stack $gap={1}>
      <Legend as="span" id={`${name}-legend`}>
        {label}
      </Legend>
      <Choices role="radiogroup" aria-labelledby={`${name}-legend`}>
        {(["all", "none", "list"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name={name}
              aria-label={`${label}: ${SCOPE_LABEL[value]}`}
              checked={scope === value}
              onChange={() => onScope(value)}
            />
            {SCOPE_LABEL[value]}
          </label>
        ))}
      </Choices>
      {scope === "none" ? (
        <Warn role="status">No request matches, so this destination exports nothing.</Warn>
      ) : null}
      {scope === "list" ? (
        <Field label={listLabel} hint={hint}>
          {(props) => (
            <Input {...props} value={text} onChange={(event) => onText(event.target.value)} />
          )}
        </Field>
      ) : null}
    </Stack>
  );
}
