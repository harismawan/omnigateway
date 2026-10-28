import {
  DEFAULT_SMART_ROUTER_POLICY,
  GUARDRAIL_HISTORY_TURNS_MAX,
  GUARDRAIL_TIMEOUT_MAX_MS,
  SMART_ROUTER_POLICY_MAX_CHARS,
  SMART_ROUTER_TIMEOUT_MAX_MS,
} from "@omni/store/types";
import { type ReactNode, useEffect, useId, useState } from "react";
import styled from "styled-components";
import {
  useBodyLoggingAllowed,
  useModels,
  useSaveSettings,
  useSettings,
  useSmartRouterModels,
} from "../../api/queries.ts";
import type { PonytailMode, Settings, SmartRouterModelState } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { Button } from "../../ui/Button.tsx";
import { Field, Input, Textarea } from "../../ui/Field.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Grid, Legend, Mono, Row, Spacer, Stack } from "../../ui/primitives.ts";
import { Autocomplete } from "../../ui/Select.tsx";
import { describeError, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { AccessPanel } from "./AccessPanel.tsx";
import { AgentSetup } from "./AgentSetup.tsx";

/**
 * The ponytail levels, in the order an operator escalates through them.
 *
 * A `Record` over the union rather than a list: adding a level upstream then
 * fails this build instead of quietly offering one fewer option than exists.
 */
const PONYTAIL_LEVELS: Record<PonytailMode, string> = {
  off: "Off",
  lite: "Lite — names the lazier option",
  full: "Full — the ladder enforced",
  ultra: "Ultra — challenges the requirement",
};

type WeightKey = keyof Settings["weights"];

const WEIGHTS: ReadonlyArray<{ id: WeightKey; label: string; blurb: string }> = [
  { id: "tier", label: "Tier", blurb: "Prefers a lower tier." },
  { id: "health", label: "Health", blurb: "Penalises recent failures and an open breaker." },
  { id: "quota", label: "Quota", blurb: "Prefers accounts ahead of their window's burn rate." },
  { id: "cost", label: "Cost", blurb: "Prefers the cheaper candidate." },
  { id: "latency", label: "Latency", blurb: "Prefers the faster observed first token." },
  { id: "load", label: "Load", blurb: "Prefers accounts with fewer requests in flight." },
];

/**
 * Every setting that is a plain number typed into a box.
 *
 * Named rather than spelled out at each use because the exclusion list is now
 * long enough to drift: a boolean left out of it is parsed by `Number` and saved
 * as `NaN`, which the schema then rejects with a message about the wrong field.
 * Each entry excluded here has a control of its own further down.
 */
type LimitKey = Exclude<
  keyof Settings,
  | "weights"
  | "rtkEnabled"
  | "autoCacheEnabled"
  | "ponytailMode"
  | "bodyLoggingEnabled"
  | "bodyLoggingCaptureStreamChunks"
  | "guardrailModel"
  | "guardrailTimeoutMs"
  | "guardrailHistoryTurns"
  | "smartRouterEnabled"
  | "smartRouterClassifierModel"
  | "smartRouterLocalModel"
  | "smartRouterPolicy"
  | "smartRouterTimeoutMs"
>;

const LIMITS: ReadonlyArray<{
  id: LimitKey;
  label: string;
  hint: string;
  unit: string;
  step: number;
  min: number;
  max?: number;
}> = [
  {
    id: "maxAttempts",
    label: "Attempts per request",
    hint: "Candidates dispatch may try. 1 disables failover.",
    unit: "attempts",
    step: 1,
    min: 1,
  },
  {
    id: "requestDeadlineMs",
    label: "Request deadline",
    hint: "Across all attempts. 0 disables only OmniGateway's deadline.",
    unit: "ms",
    step: 1000,
    min: 0,
  },
  {
    id: "breakerThreshold",
    label: "Breaker threshold",
    hint: "Consecutive failures before an account and model leaves rotation.",
    unit: "failures",
    step: 1,
    min: 1,
  },
  {
    id: "breakerCooldownMs",
    label: "Breaker cooldown",
    hint: "Wait before a tripped account is probed. Doubles per extra failure.",
    unit: "ms",
    step: 1000,
    min: 1,
  },
  {
    id: "logRetentionDays",
    label: "Log retention",
    hint: "How long request rows are kept before pruning.",
    unit: "days",
    step: 1,
    min: 1,
  },
  {
    id: "bodyRetentionDays",
    label: "Body retention",
    hint: "Captured bodies only. Never longer than log retention; swept hourly.",
    unit: "days",
    step: 1,
    min: 1,
    max: 3_650,
  },
  {
    id: "quotaPollIntervalMs",
    label: "Quota poll interval",
    hint: "How often a provider is asked for remaining quota. 0 disables. Needs a restart.",
    unit: "ms",
    step: 60_000,
    min: 0,
  },
];

const Weights = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: ${({ theme }) => theme.space(3)};
`;

const Cell = styled(Stack)`
  gap: 6px;
`;

const Blurb = styled.p`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

/**
 * The switches and the one mode select, laid out as cards rather than as a
 * module apiece.
 *
 * One switch per full-width row put four unrelated booleans on four separate
 * faces, so reading what this gateway does to a request meant scrolling past
 * three paragraphs. A card holds the control, its name and its blurb together;
 * the modules holding them sit side by side, so the cards themselves stack.
 */
const Options = styled.div`
  display: grid;
  grid-template-columns: 1fr;
  gap: ${({ theme }) => theme.space(2)};
  align-items: start;
`;

const Option = styled.div`
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: ${({ theme }) => theme.space(2)};
  row-gap: 4px;
  align-items: center;
  padding: ${({ theme }) => theme.space(2)};
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.rule};
  border-radius: 3px;
`;

/** The card's own blurb sits under the name, clear of the control's column. */
const OptionBlurb = styled(Blurb)`
  grid-column: 2;
`;

const OptionName = styled.label`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.color.ink};
  cursor: pointer;
`;

function SwitchOption({
  label,
  checked,
  disabled,
  onCheckedChange,
  children,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Option>
      <Toggle
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        label={label}
        {...(disabled === undefined ? {} : { disabled })}
      />
      <OptionName htmlFor={id}>{label}</OptionName>
      <OptionBlurb>{children}</OptionBlurb>
    </Option>
  );
}

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Saved = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.ok};
`;

const PolicyCount = styled.span<{ $over: boolean }>`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ $over, theme }) => ($over ? theme.color.down : theme.color.inkDim)};
`;

/**
 * A control that is present but cannot act, and why.
 *
 * Warn rather than down: nothing is broken and nothing failed. The operator is
 * simply one restart away from the switch below doing what it says.
 */
const Blocked = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
  max-width: 72ch;

  code {
    font-family: ${({ theme }) => theme.font.mono};
  }
`;

/** One board per screen, so fixed ids are unique. */
const CLASSIFIER_STATUS_ID = "smart-router-classifier-status";
const LOCAL_STATUS_ID = "smart-router-local-status";

/** What a smart-router model's state means for flagged keys, or `null` when nothing is wrong. */
const MODEL_WARNINGS: Readonly<Record<SmartRouterModelState, string | null>> = {
  ok: null,
  unset: "Not set; flagged keys' requests are refused.",
  unresolved: "This model does not resolve.",
  notLocal:
    "This model has a target that is not a custom (in-house) endpoint; flagged keys' requests are refused.",
};

/**
 * The warning under one smart-router model picker, or `null`.
 *
 * Blank is judged here, from the draft, and only while the switch is on: an
 * unset model refuses nothing while the feature is off. `unresolved` and
 * `notLocal` are the gateway's verdict on the *saved* name, so they show
 * whatever the switch — an operator should hear before turning it on — but
 * only while the picker still holds that name; a different draft has not been
 * judged yet.
 */
function modelWarning(
  draft: string | undefined,
  saved: string | null | undefined,
  state: SmartRouterModelState | undefined,
  enabled: boolean,
): string | null {
  const name = (draft ?? "").trim();
  if (name === "") return enabled ? MODEL_WARNINGS.unset : null;
  if (state === undefined || state === "unset" || name !== saved) return null;
  return MODEL_WARNINGS[state];
}

/**
 * A model picker's standing warning. Warn, not down, like `Blocked`: nothing
 * has failed until a flagged key sends a request.
 */
const ModelWarning = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

/** Every field is held as the string the input carries, booleans included. */
type Draft = Record<string, string> & {
  rtkEnabled?: string;
  autoCacheEnabled?: string;
  ponytailMode?: string;
  bodyLoggingEnabled?: string;
  bodyLoggingCaptureStreamChunks?: string;
  guardrailModel?: string;
  guardrailTimeoutMs?: string;
  guardrailHistoryTurns?: string;
  smartRouterEnabled?: string;
  smartRouterClassifierModel?: string;
  smartRouterLocalModel?: string;
  smartRouterPolicy?: string;
  smartRouterTimeoutMs?: string;
};

function toDraft(settings: Settings): Draft {
  const draft: Draft = {};
  for (const weight of WEIGHTS) draft[`w.${weight.id}`] = String(settings.weights[weight.id]);
  for (const limit of LIMITS) draft[limit.id] = String(settings[limit.id]);
  draft.rtkEnabled = String(settings.rtkEnabled);
  draft.autoCacheEnabled = String(settings.autoCacheEnabled);
  draft.ponytailMode = settings.ponytailMode;
  draft.bodyLoggingEnabled = String(settings.bodyLoggingEnabled);
  draft.bodyLoggingCaptureStreamChunks = String(settings.bodyLoggingCaptureStreamChunks);
  // Blank is how "no classifier" is typed, and how it reads back.
  draft.guardrailModel = settings.guardrailModel ?? "";
  draft.guardrailTimeoutMs = String(settings.guardrailTimeoutMs);
  draft.guardrailHistoryTurns = String(settings.guardrailHistoryTurns);
  draft.smartRouterEnabled = String(settings.smartRouterEnabled);
  draft.smartRouterClassifierModel = settings.smartRouterClassifierModel ?? "";
  draft.smartRouterLocalModel = settings.smartRouterLocalModel ?? "";
  draft.smartRouterPolicy = settings.smartRouterPolicy;
  draft.smartRouterTimeoutMs = String(settings.smartRouterTimeoutMs);
  return draft;
}

function parseDraft(
  draft: Draft,
): { ok: true; settings: Omit<Settings, "prompts"> } | { ok: false; problem: string } {
  const weights = {} as Settings["weights"];
  for (const weight of WEIGHTS) {
    // A blank field is not zero. Reading it as zero would silently retune the
    // router, so it is reported instead.
    const raw = (draft[`w.${weight.id}`] ?? "").trim();
    const value = Number(raw);
    if (raw.length === 0 || !Number.isFinite(value)) {
      return { ok: false, problem: `${weight.label} must be a number.` };
    }
    weights[weight.id] = value;
  }

  const limits = {} as Record<LimitKey, number>;
  for (const limit of LIMITS) {
    const raw = (draft[limit.id] ?? "").trim();
    const value = Number(raw);
    if (raw.length === 0 || !Number.isInteger(value) || value < limit.min) {
      return {
        ok: false,
        problem: `${limit.label} must be a whole number of ${limit.min} or more.`,
      };
    }
    if (limit.max !== undefined && value > limit.max) {
      return { ok: false, problem: `${limit.label} cannot exceed ${limit.max}.` };
    }
    limits[limit.id] = value;
  }
  if (limits.maxAttempts > 10) {
    return { ok: false, problem: "Attempts per request cannot exceed 10." };
  }

  const timeoutRaw = (draft.guardrailTimeoutMs ?? "").trim();
  const guardrailTimeoutMs = Number(timeoutRaw);
  if (
    timeoutRaw.length === 0 ||
    !Number.isInteger(guardrailTimeoutMs) ||
    guardrailTimeoutMs < 1 ||
    guardrailTimeoutMs > GUARDRAIL_TIMEOUT_MAX_MS
  ) {
    return {
      ok: false,
      problem: `Usage policy check timeout must be a whole number from 1 to ${GUARDRAIL_TIMEOUT_MAX_MS}.`,
    };
  }
  const turnsRaw = (draft.guardrailHistoryTurns ?? "").trim();
  const guardrailHistoryTurns = Number(turnsRaw);
  if (
    turnsRaw.length === 0 ||
    !Number.isInteger(guardrailHistoryTurns) ||
    guardrailHistoryTurns < 1 ||
    guardrailHistoryTurns > GUARDRAIL_HISTORY_TURNS_MAX
  ) {
    return {
      ok: false,
      problem: `Messages judged must be a whole number from 1 to ${GUARDRAIL_HISTORY_TURNS_MAX}.`,
    };
  }
  const guardrailModel = (draft.guardrailModel ?? "").trim();

  const smartTimeoutRaw = (draft.smartRouterTimeoutMs ?? "").trim();
  const smartRouterTimeoutMs = Number(smartTimeoutRaw);
  if (
    smartTimeoutRaw.length === 0 ||
    !Number.isInteger(smartRouterTimeoutMs) ||
    smartRouterTimeoutMs < 1 ||
    smartRouterTimeoutMs > SMART_ROUTER_TIMEOUT_MAX_MS
  ) {
    return {
      ok: false,
      problem: `Confidential routing timeout must be a whole number from 1 to ${SMART_ROUTER_TIMEOUT_MAX_MS}.`,
    };
  }
  // Counted as the gateway counts it: trimmed. An empty policy is not "use the
  // default", it is refused, because the route refuses it and the button beside
  // the field is the way back.
  const smartRouterPolicy = (draft.smartRouterPolicy ?? "").trim();
  if (smartRouterPolicy.length === 0) {
    return {
      ok: false,
      problem: "Write what counts as confidential, or use Reset to default.",
    };
  }
  if (smartRouterPolicy.length > SMART_ROUTER_POLICY_MAX_CHARS) {
    return {
      ok: false,
      problem: `The confidential policy is at most ${SMART_ROUTER_POLICY_MAX_CHARS} characters.`,
    };
  }
  const smartRouterClassifierModel = (draft.smartRouterClassifierModel ?? "").trim();
  const smartRouterLocalModel = (draft.smartRouterLocalModel ?? "").trim();

  return {
    ok: true,
    settings: {
      weights,
      ...limits,
      rtkEnabled: draft.rtkEnabled === "true",
      autoCacheEnabled: draft.autoCacheEnabled === "true",
      // The control offers the four names and nothing else, so the draft can
      // only hold one of them; `off` is what an absent draft field means, the
      // same answer the store gives a value it does not recognise.
      // `hasOwn`, not `in`: `in` walks the prototype chain, so "toString" would
      // pass the guard and then be cast to a mode nothing can render. The
      // console cannot import `isPonytailMode` — rule 12 permits it
      // `@omni/store/types` and not the catalog subpath — so this is the local
      // answer, and the `Record` below is what keeps the option list honest.
      ponytailMode:
        draft.ponytailMode !== undefined && Object.hasOwn(PONYTAIL_LEVELS, draft.ponytailMode)
          ? (draft.ponytailMode as PonytailMode)
          : "off",
      bodyLoggingEnabled: draft.bodyLoggingEnabled === "true",
      bodyLoggingCaptureStreamChunks: draft.bodyLoggingCaptureStreamChunks === "true",
      // Sent as `null` rather than omitted when blank: omitting it would keep
      // the stored classifier, and clearing the field is how it is unset.
      guardrailModel: guardrailModel.length === 0 ? null : guardrailModel,
      guardrailTimeoutMs,
      guardrailHistoryTurns,
      smartRouterEnabled: draft.smartRouterEnabled === "true",
      // Null when blank, for the reason `guardrailModel` is.
      smartRouterClassifierModel:
        smartRouterClassifierModel.length === 0 ? null : smartRouterClassifierModel,
      smartRouterLocalModel: smartRouterLocalModel.length === 0 ? null : smartRouterLocalModel,
      smartRouterPolicy,
      smartRouterTimeoutMs,
    },
  };
}

/**
 * The routing weights and the limits around them.
 *
 * Weights are relative, not absolute, so each one is shown against the largest
 * of the set — that ratio is what the router actually acts on.
 */
export function SettingsBoard() {
  const settings = useSettings();
  // The environment half of the capture contract, read at boot and not settable
  // from here. Without it the toggle below saves fine and records nothing, which
  // is the one outcome this screen must never let an operator walk into quietly.
  const bodyLoggingAllowed = useBodyLoggingAllowed();
  // The classifier picker's suggestions: the same source the allowlist editor
  // reads. Free text is still accepted, for `provider/model`.
  const models = useModels();
  // The gateway's verdict on each saved smart-router model, for the warnings
  // under the pickers; `omni doctor` was the only other place that said.
  const smartRouterModels = useSmartRouterModels();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<Draft>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data === undefined) return;
    setDraft(toDraft(settings.data));
  }, [settings.data]);

  const largest = Math.max(
    0.0001,
    ...WEIGHTS.map((weight) => Math.abs(Number(draft[`w.${weight.id}`]) || 0)),
  );

  const smartPolicyLength = (draft.smartRouterPolicy ?? "").trim().length;
  const smartEnabled = draft.smartRouterEnabled === "true";
  const classifierWarning = modelWarning(
    draft.smartRouterClassifierModel,
    settings.data?.smartRouterClassifierModel,
    smartRouterModels.data?.classifier,
    smartEnabled,
  );
  const localWarning = modelWarning(
    draft.smartRouterLocalModel,
    settings.data?.smartRouterLocalModel,
    smartRouterModels.data?.local,
    smartEnabled,
  );
  /** Adds a picker's warning to what its input is described by. */
  const describedWith = (base: string | undefined, warning: string | null, id: string) =>
    warning === null ? base : [base, id].filter((part) => part !== undefined).join(" ");

  const submit = () => {
    setSaved(false);
    if (settings.data === undefined) return;
    const parsed = parseDraft(draft);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    save.mutate(
      { ...parsed.settings, prompts: settings.data?.prompts ?? [] },
      {
        onSuccess: () => setSaved(true),
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  return (
    <>
      <PageHead
        legend="Settings"
        title="Routing and retention"
        summary="Applied to every request the gateway routes. Changes take effect on the next request; nothing restarts."
        actions={
          <Button
            type="button"
            $variant="primary"
            disabled={save.isPending || settings.isLoading}
            onClick={submit}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        }
      />

      {settings.isError ? (
        <Module legend="Settings">
          <Failure error={settings.error} onRetry={() => void settings.refetch()} />
        </Module>
      ) : settings.isLoading ? (
        <Module legend="Settings">
          <SkeletonRows rows={6} />
        </Module>
      ) : (
        <Stack $gap={4}>
          <Module
            legend="Scoring weights"
            meta="relative to each other"
            footer={
              <Row>
                <Legend>
                  Score is the sum of each term times its weight, then multiplied by the account and
                  target weights.
                </Legend>
                <Spacer />
              </Row>
            }
          >
            <Weights>
              {WEIGHTS.map((weight) => {
                const value = Number(draft[`w.${weight.id}`]) || 0;
                return (
                  <Cell key={weight.id}>
                    <Field label={weight.label}>
                      {(props) => (
                        <Input
                          {...props}
                          type="number"
                          step={0.5}
                          value={draft[`w.${weight.id}`] ?? ""}
                          onChange={(event) =>
                            setDraft({ ...draft, [`w.${weight.id}`]: event.target.value })
                          }
                        />
                      )}
                    </Field>
                    <Meter
                      fraction={Math.abs(value) / largest}
                      height={4}
                      tone="var(--accent)"
                      label={`${weight.label} weight ${value}`}
                    />
                    <Blurb>{weight.blurb}</Blurb>
                  </Cell>
                );
              })}
            </Weights>
          </Module>

          <Module legend="Limits">
            <Weights>
              {LIMITS.map((limit) => (
                <Cell key={limit.id}>
                  <Field label={limit.label} hint={limit.hint}>
                    {(props) => (
                      <Row $gap={2}>
                        <Input
                          {...props}
                          type="number"
                          min={limit.min}
                          max={limit.max}
                          step={limit.step}
                          value={draft[limit.id] ?? ""}
                          onChange={(event) =>
                            setDraft({ ...draft, [limit.id]: event.target.value })
                          }
                        />
                        <Legend>{limit.unit}</Legend>
                      </Row>
                    )}
                  </Field>
                </Cell>
              ))}
            </Weights>
          </Module>

          {/* Paired: what the gateway does to a request, and what it keeps of
              one. Both are short lists of switches, so side by side they read as
              one decision rather than two screens apart. Stretched, because a
              pair of faces of different heights reads as one panel cropped
              rather than two panels of different lengths. */}
          <Grid $min="380px" $stretch>
            <Module legend="Request handling" meta="applied before dispatch">
              <Options>
                <SwitchOption
                  label="Enable RTK compression"
                  checked={draft.rtkEnabled === "true"}
                  onCheckedChange={(checked) => setDraft({ ...draft, rtkEnabled: String(checked) })}
                >
                  Compresses recognized historical tool results. Confirmed non-shell tools are
                  excluded; unknown-origin results may be compressed only when a detector recognizes
                  shell output. Lossy.
                </SwitchOption>

                <SwitchOption
                  label="Add a cache breakpoint when a client sends none"
                  checked={draft.autoCacheEnabled === "true"}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, autoCacheEnabled: String(checked) })
                  }
                >
                  Marks the end of the system prompt on Anthropic requests carrying no breakpoint of
                  their own. Requests that mark one are untouched.
                </SwitchOption>

                <a href="/prompts">
                  Prompt injection, including ponytail, moved to Prompt Management
                </a>
              </Options>
            </Module>

            <Module
              legend="Request and response bodies"
              meta={
                bodyLoggingAllowed.data === true ? "permitted by the environment" : "not permitted"
              }
            >
              <Stack $gap={2}>
                {/* Deliberately not a live region: this is the standing state of
                    the installation, present from first paint, not an outcome
                    announced after an action. */}
                {bodyLoggingAllowed.data === true ? null : (
                  <Blocked>
                    This gateway started without <code>OMNI_BODY_LOGGING_ALLOWED</code>, so nothing
                    below can record anything. Set it in the installation's <code>.env</code> and
                    restart first.
                  </Blocked>
                )}

                <Options>
                  <SwitchOption
                    label="Capture request and response bodies"
                    checked={draft.bodyLoggingEnabled === "true"}
                    disabled={bodyLoggingAllowed.data !== true}
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, bodyLoggingEnabled: String(checked) })
                    }
                  >
                    Stores what each client sent and each provider returned, encrypted beside the
                    database. Tokens and keys are masked; headers are never captured. Expires on the
                    body retention window above, never later than the request log.
                  </SwitchOption>

                  <SwitchOption
                    label="Also keep raw stream frames"
                    checked={draft.bodyLoggingCaptureStreamChunks === "true"}
                    disabled={
                      bodyLoggingAllowed.data !== true || draft.bodyLoggingEnabled !== "true"
                    }
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, bodyLoggingCaptureStreamChunks: String(checked) })
                    }
                  >
                    Also keeps the raw SSE frames of each attempt. The most expensive thing capture
                    stores.
                  </SwitchOption>
                </Options>
              </Stack>
            </Module>
          </Grid>

          <Module legend="Usage policies" meta="per-key guardrails">
            <Stack $gap={2}>
              <Blurb>
                Keys carrying a usage policy have each request judged by this model first. While it
                is blank, every request from such a key is refused. A guardrail against ordinary
                misuse, not a security boundary.
              </Blurb>
              <Weights>
                <Cell>
                  <Field
                    label="Classifier model"
                    hint="A configured model, or provider/model. Blank means none."
                  >
                    {(props) => (
                      <Autocomplete
                        {...props}
                        placeholder="none"
                        value={draft.guardrailModel ?? ""}
                        suggestions={(models.data ?? []).map((model) => ({
                          value: model.id,
                          label: model.id,
                        }))}
                        onValueChange={(next) => setDraft({ ...draft, guardrailModel: next })}
                      />
                    )}
                  </Field>
                </Cell>
                <Cell>
                  <Field
                    label="Check timeout"
                    hint="A slower check refuses the request it was judging."
                  >
                    {(props) => (
                      <Row $gap={2}>
                        <Input
                          {...props}
                          type="number"
                          min={1}
                          max={GUARDRAIL_TIMEOUT_MAX_MS}
                          step={1}
                          value={draft.guardrailTimeoutMs ?? ""}
                          onChange={(event) =>
                            setDraft({ ...draft, guardrailTimeoutMs: event.target.value })
                          }
                        />
                        <Legend>ms</Legend>
                      </Row>
                    )}
                  </Field>
                </Cell>
                <Cell>
                  <Field
                    label="Messages judged"
                    hint="How many of the latest human messages are judged together. 1 is the last alone."
                  >
                    {(props) => (
                      <Row $gap={2}>
                        <Input
                          {...props}
                          type="number"
                          min={1}
                          max={GUARDRAIL_HISTORY_TURNS_MAX}
                          step={1}
                          value={draft.guardrailHistoryTurns ?? ""}
                          onChange={(event) =>
                            setDraft({ ...draft, guardrailHistoryTurns: event.target.value })
                          }
                        />
                        <Legend>messages</Legend>
                      </Row>
                    )}
                  </Field>
                </Cell>
              </Weights>
            </Stack>
          </Module>

          <Module legend="Confidential routing" meta="per-key, local model">
            <Stack $gap={3}>
              <Blurb>
                Keys with confidential routing on have each request screened by the classifier
                model. Requests it judges confidential are answered by the local model instead of
                the model asked for. Reduces leaks of ordinary confidential content; it is not a
                security boundary.
              </Blurb>
              <Options>
                <SwitchOption
                  label="Enable confidential routing"
                  checked={draft.smartRouterEnabled === "true"}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, smartRouterEnabled: String(checked) })
                  }
                >
                  Applies only to keys that have it switched on in Keys. While off, no request is
                  screened or rerouted.
                </SwitchOption>
              </Options>
              <Weights>
                <Cell>
                  <Field
                    label="Confidential classifier model"
                    hint="Judges each request. Blank means none."
                  >
                    {(props) => (
                      <Autocomplete
                        {...props}
                        aria-describedby={describedWith(
                          props["aria-describedby"],
                          classifierWarning,
                          CLASSIFIER_STATUS_ID,
                        )}
                        placeholder="none"
                        value={draft.smartRouterClassifierModel ?? ""}
                        suggestions={(models.data ?? []).map((model) => ({
                          value: model.id,
                          label: model.id,
                        }))}
                        onValueChange={(next) =>
                          setDraft({ ...draft, smartRouterClassifierModel: next })
                        }
                      />
                    )}
                  </Field>
                  {classifierWarning === null ? null : (
                    <ModelWarning id={CLASSIFIER_STATUS_ID}>{classifierWarning}</ModelWarning>
                  )}
                </Cell>
                <Cell>
                  <Field
                    label="Local model"
                    hint="Answers requests judged confidential. Blank means none."
                  >
                    {(props) => (
                      <Autocomplete
                        {...props}
                        aria-describedby={describedWith(
                          props["aria-describedby"],
                          localWarning,
                          LOCAL_STATUS_ID,
                        )}
                        placeholder="none"
                        value={draft.smartRouterLocalModel ?? ""}
                        suggestions={(models.data ?? []).map((model) => ({
                          value: model.id,
                          label: model.id,
                        }))}
                        onValueChange={(next) =>
                          setDraft({ ...draft, smartRouterLocalModel: next })
                        }
                      />
                    )}
                  </Field>
                  {localWarning === null ? null : (
                    <ModelWarning id={LOCAL_STATUS_ID}>{localWarning}</ModelWarning>
                  )}
                </Cell>
                <Cell>
                  <Field
                    label="Confidential check timeout"
                    hint="A slower check refuses the request it was screening."
                  >
                    {(props) => (
                      <Row $gap={2}>
                        <Input
                          {...props}
                          type="number"
                          min={1}
                          max={SMART_ROUTER_TIMEOUT_MAX_MS}
                          step={1}
                          value={draft.smartRouterTimeoutMs ?? ""}
                          onChange={(event) =>
                            setDraft({ ...draft, smartRouterTimeoutMs: event.target.value })
                          }
                        />
                        <Legend>ms</Legend>
                      </Row>
                    )}
                  </Field>
                </Cell>
              </Weights>
              <Blurb>
                Must be a virtual model whose targets are all custom (in-house) endpoints. Requests
                are refused otherwise.
              </Blurb>
              <Field
                label="What counts as confidential"
                hint="Plain language. The classifier reads this to decide which requests stay on local hardware."
              >
                {(props) => (
                  <Textarea
                    {...props}
                    rows={6}
                    value={draft.smartRouterPolicy ?? ""}
                    onChange={(event) =>
                      setDraft({ ...draft, smartRouterPolicy: event.target.value })
                    }
                  />
                )}
              </Field>
              <Row $gap={2}>
                <Button
                  type="button"
                  $size="sm"
                  onClick={() =>
                    setDraft({ ...draft, smartRouterPolicy: DEFAULT_SMART_ROUTER_POLICY })
                  }
                >
                  Reset to default
                </Button>
                <Spacer />
                <PolicyCount $over={smartPolicyLength > SMART_ROUTER_POLICY_MAX_CHARS}>
                  {smartPolicyLength} / {SMART_ROUTER_POLICY_MAX_CHARS}
                </PolicyCount>
              </Row>
            </Stack>
          </Module>

          {problem === null ? null : <Problem role="alert">{problem}</Problem>}
          {saved && problem === null ? <Saved role="status">Settings saved.</Saved> : null}

          {/* The two panels an operator uses when handing this gateway to
              someone else: what to paste into their agent, and what password
              opens the console. */}
          <Grid $min="380px" $stretch>
            <AgentSetup />
            <AccessPanel />
          </Grid>

          <Module legend="Known limits">
            <Stack $gap={2}>
              <Row $gap={2} $align="start">
                <Mono $dim>rate limits</Mono>
                <Blurb>
                  Counted per gateway process and reset when it restarts. Not shared across
                  instances.
                </Blurb>
              </Row>
              <Row $gap={2} $align="start">
                <Mono $dim>logs</Mono>
                <Blurb>
                  Request rows record routing and token counts only. Prompts and responses only when
                  body capture is on, to a separate encrypted store. Credentials to neither.
                </Blurb>
              </Row>
            </Stack>
          </Module>
        </Stack>
      )}
    </>
  );
}
