import { Play } from "lucide-react";
import { useState } from "react";
import styled from "styled-components";
import { useDryRun, useSettings } from "../../api/queries.ts";
import type { DryRunNeed, DryRunResult, ScoreReasons, Settings } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Chip, ProviderTag } from "../../ui/Chip.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Mono, Row, Spacer, Stack, Truncate } from "../../ui/primitives.ts";
import { describeError, Empty } from "../../ui/States.tsx";
import { Toggle } from "../../ui/Toggle.tsx";

/** The order the router itself lists them in, so the two read the same way. */
const TERMS = ["tier", "health", "quota", "cost", "latency", "recency"] as const;
type Term = (typeof TERMS)[number];

const TERM_BLURB: Record<Term, string> = {
  tier: "How preferred this tier is",
  health: "Consecutive failures and breaker state",
  quota: "Headroom left in the tightest window",
  cost: "Price against the other candidates",
  latency: "Observed time to first token",
  recency: "How long this pair has been idle",
};

const Candidate = styled.li`
  padding: ${({ theme }) => theme.space(2)} 0;
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};

  &:last-child {
    border-bottom: 0;
  }
`;

const Rank = styled(Mono)`
  width: 22px;
  color: ${({ theme }) => theme.color.inkFaint};
  flex: none;
`;

const Winner = styled(Chip)`
  border-color: ${({ theme }) => theme.color.ok};
  color: ${({ theme }) => theme.color.ok};
  background: ${({ theme }) => theme.color.okWash};
`;

const Terms = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: ${({ theme }) => theme.space(2)};
  margin-top: ${({ theme }) => theme.space(2)};
  padding-left: 30px;
`;

const TermCell = styled.div`
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
`;

const TermHead = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
`;

const Excluded = styled.li`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: 5px 0;
`;

const Probe = styled(Row)`
  gap: ${({ theme }) => theme.space(3)};
  flex-wrap: wrap;
`;

const Toggled = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12.5px;
`;

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

function contribution(reasons: ScoreReasons, term: Term, weights: Settings["weights"]): number {
  return (reasons[term] ?? 0) * weights[term];
}

export type ExplainPanelProps = {
  /** The model being explained, or null when nothing is selected yet. */
  modelId: string | null;
};

/**
 * Asks the router what it would do, without sending a prompt anywhere.
 *
 * The control API takes only the capabilities a request would need, runs the
 * real ranking, and hands back both the ordered candidates and everything it
 * threw out and why. This panel is the one place the routing decision is
 * legible before it matters.
 */
export function ExplainPanel({ modelId }: ExplainPanelProps) {
  const [need, setNeed] = useState<DryRunNeed>({ tools: false, images: false, reasoning: false });
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const settings = useSettings();
  const dryRun = useDryRun();

  const weights = settings.data?.weights;

  const run = () => {
    if (modelId === null) return;
    setProblem(null);
    dryRun.mutate(
      { modelId, need },
      {
        onSuccess: (data) => setResult(data),
        onError: (error) => {
          setResult(null);
          setProblem(describeError(error));
        },
      },
    );
  };

  const maxima = new Map<Term, number>(
    TERMS.map((term) => [
      term,
      Math.max(
        0.0001,
        ...(result?.candidates ?? []).map((candidate) =>
          weights === undefined ? 0 : Math.abs(contribution(candidate.reasons, term, weights)),
        ),
      ),
    ]),
  );

  return (
    <Module
      legend="Explain"
      meta={modelId ?? "no model selected"}
      actions={
        <Button
          type="button"
          $size="sm"
          $variant="primary"
          disabled={modelId === null || dryRun.isPending}
          onClick={run}
        >
          <Play />
          {dryRun.isPending ? "Ranking…" : "Rank candidates"}
        </Button>
      }
    >
      <Stack $gap={3}>
        <Stack $gap={1}>
          <Legend>Pretend the request needs</Legend>
          <Probe>
            <Toggled>
              <Toggle
                checked={need.tools}
                label="Probe request uses tools"
                onCheckedChange={(tools) => setNeed({ ...need, tools })}
              />
              Tools
            </Toggled>
            <Toggled>
              <Toggle
                checked={need.images}
                label="Probe request includes an image"
                onCheckedChange={(images) => setNeed({ ...need, images })}
              />
              Images
            </Toggled>
            <Toggled>
              <Toggle
                checked={need.reasoning}
                label="Probe request asks for reasoning"
                onCheckedChange={(reasoning) => setNeed({ ...need, reasoning })}
              />
              Reasoning
            </Toggled>
          </Probe>
        </Stack>

        {problem === null ? null : <Problem>{problem}</Problem>}

        {result === null ? (
          <Empty
            legend="Not ranked yet"
            message={
              modelId === null
                ? "Select a model to see which account the router would pick for it."
                : "Run the ranking to see which account wins, by how much, and what was filtered out."
            }
          />
        ) : (
          <Stack $gap={3}>
            <Row $gap={2} $wrap>
              <Chip $tone="accent">{result.strategy}</Chip>
              {result.deterministic ? null : <Chip $tone="warn">order varies per request</Chip>}
              <Spacer />
              <Legend>
                {result.candidates.length} eligible · {result.excluded.length} filtered out
              </Legend>
            </Row>

            {result.candidates.length === 0 ? (
              <Empty
                legend="Nothing eligible"
                message="Every target was filtered out. The reasons below say which rule removed each one."
              />
            ) : (
              <ul>
                {result.candidates.map((candidate, index) => (
                  <Candidate key={`${candidate.credentialId}:${candidate.model}`}>
                    <Row $gap={2}>
                      <Rank>{index + 1}</Rank>
                      <ProviderTag provider={candidate.provider} />
                      <Truncate style={{ maxWidth: "22ch" }}>{candidate.credentialLabel}</Truncate>
                      <Mono $dim>{candidate.model}</Mono>
                      <Chip>tier {candidate.tier}</Chip>
                      <Spacer />
                      {index === 0 ? <Winner>would be used</Winner> : null}
                      <Mono>{candidate.score.toFixed(2)}</Mono>
                    </Row>

                    {weights === undefined ? null : (
                      <Terms>
                        {TERMS.map((term) => {
                          const value = contribution(candidate.reasons, term, weights);
                          const max = maxima.get(term) ?? 1;
                          return (
                            <TermCell key={term} title={TERM_BLURB[term]}>
                              <TermHead>
                                <Legend>{term}</Legend>
                                <Mono $dim $size="10.5px">
                                  {value.toFixed(2)}
                                </Mono>
                              </TermHead>
                              <Meter
                                fraction={Math.abs(value) / max}
                                height={4}
                                tone="var(--accent)"
                                label={`${term} contributes ${value.toFixed(2)} of ${candidate.score.toFixed(2)}`}
                              />
                            </TermCell>
                          );
                        })}
                      </Terms>
                    )}
                  </Candidate>
                ))}
              </ul>
            )}

            {result.excluded.length === 0 ? null : (
              <Stack $gap={1}>
                <Legend>Filtered out</Legend>
                <ul>
                  {result.excluded.map((row) => (
                    <Excluded key={`${row.credentialId}:${row.model}:${row.reason}`}>
                      <Mono $dim>{row.model}</Mono>
                      <Spacer />
                      <Chip $tone={row.reason.startsWith("capability") ? "warn" : "down"}>
                        {row.reason}
                      </Chip>
                    </Excluded>
                  ))}
                </ul>
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Module>
  );
}
