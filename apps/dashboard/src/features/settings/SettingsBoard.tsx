import { useEffect, useState } from "react";
import styled from "styled-components";
import { useSaveSettings, useSettings } from "../../api/queries.ts";
import type { Settings } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { Button } from "../../ui/Button.tsx";
import { Field, Input } from "../../ui/Field.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Mono, Row, Spacer, Stack } from "../../ui/primitives.ts";
import { describeError, Failure, SkeletonRows } from "../../ui/States.tsx";
import { AgentSetup } from "./AgentSetup.tsx";

type WeightKey = keyof Settings["weights"];

const WEIGHTS: ReadonlyArray<{ id: WeightKey; label: string; blurb: string }> = [
  { id: "tier", label: "Tier", blurb: "How strongly a lower tier is preferred." },
  { id: "health", label: "Health", blurb: "Penalty for recent failures and an open breaker." },
  {
    id: "quota",
    label: "Quota",
    blurb: "Preference for accounts keeping ahead of their window's burn rate.",
  },
  { id: "cost", label: "Cost", blurb: "Preference for the cheaper target of the candidates." },
  { id: "latency", label: "Latency", blurb: "Preference for the faster observed first token." },
  { id: "recency", label: "Recency", blurb: "Preference for accounts that have been idle." },
];

const LIMITS: ReadonlyArray<{
  id: Exclude<keyof Settings, "weights">;
  label: string;
  hint: string;
  unit: string;
  step: number;
  min: number;
}> = [
  {
    id: "maxAttempts",
    label: "Attempts per request",
    hint: "How many candidates dispatch may try before giving up. 1 disables failover.",
    unit: "attempts",
    step: 1,
    min: 1,
  },
  {
    id: "requestDeadlineMs",
    label: "Request deadline",
    hint: "How long a single client request may take across all attempts.",
    unit: "ms",
    step: 1000,
    min: 1,
  },
  {
    id: "breakerThreshold",
    label: "Breaker threshold",
    hint: "Consecutive failures on one account and model before it is taken out of rotation.",
    unit: "failures",
    step: 1,
    min: 1,
  },
  {
    id: "breakerCooldownMs",
    label: "Breaker cooldown",
    hint: "Base wait before a tripped account is probed again. Doubles per extra failure.",
    unit: "ms",
    step: 1000,
    min: 1,
  },
  {
    id: "logRetentionDays",
    label: "Log retention",
    hint: "How long request rows are kept before maintenance prunes them.",
    unit: "days",
    step: 1,
    min: 1,
  },
  {
    id: "quotaPollIntervalMs",
    label: "Quota poll interval",
    hint: "How often each account's provider is asked for its remaining quota. 0 disables polling. Takes effect on restart.",
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

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Saved = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.ok};
`;

type Draft = Record<string, string>;

function toDraft(settings: Settings): Draft {
  const draft: Draft = {};
  for (const weight of WEIGHTS) draft[`w.${weight.id}`] = String(settings.weights[weight.id]);
  for (const limit of LIMITS) draft[limit.id] = String(settings[limit.id]);
  return draft;
}

function parseDraft(
  draft: Draft,
): { ok: true; settings: Settings } | { ok: false; problem: string } {
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

  const limits = {} as Record<Exclude<keyof Settings, "weights">, number>;
  for (const limit of LIMITS) {
    const raw = (draft[limit.id] ?? "").trim();
    const value = Number(raw);
    if (raw.length === 0 || !Number.isInteger(value) || value < limit.min) {
      return {
        ok: false,
        problem: `${limit.label} must be a whole number of ${limit.min} or more.`,
      };
    }
    limits[limit.id] = value;
  }
  if (limits.maxAttempts > 10) {
    return { ok: false, problem: "Attempts per request cannot exceed 10." };
  }

  return { ok: true, settings: { weights, ...limits } };
}

/**
 * The routing weights and the limits around them.
 *
 * Weights are relative, not absolute, so each one is shown against the largest
 * of the set — that ratio is what the router actually acts on.
 */
export function SettingsBoard() {
  const settings = useSettings();
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

  const submit = () => {
    setSaved(false);
    const parsed = parseDraft(draft);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    save.mutate(parsed.settings, {
      onSuccess: () => setSaved(true),
      onError: (error) => setProblem(describeError(error)),
    });
  };

  return (
    <>
      <PageHead
        legend="Settings"
        title="Routing and retention"
        summary="These apply to every request the gateway routes. Changes take effect on the next request; nothing is restarted."
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
                  A candidate's score is the sum of each term times its weight, then multiplied by
                  the account and target weights.
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

          {problem === null ? null : <Problem role="alert">{problem}</Problem>}
          {saved && problem === null ? <Saved role="status">Settings saved.</Saved> : null}

          <AgentSetup />

          <Module legend="Known limits">
            <Stack $gap={2}>
              <Row $gap={2}>
                <Mono $dim>rate limits</Mono>
                <Blurb>
                  Per-key rate limits are counted inside one gateway process and reset when it
                  restarts. They are not shared across instances.
                </Blurb>
              </Row>
              <Row $gap={2}>
                <Mono $dim>logs</Mono>
                <Blurb>
                  Request rows record routing and token counts only. Prompts, responses, and
                  credentials are never written.
                </Blurb>
              </Row>
            </Stack>
          </Module>
        </Stack>
      )}
    </>
  );
}
