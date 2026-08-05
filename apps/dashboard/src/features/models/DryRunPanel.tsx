import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { dryRun } from "@/api/queries.ts";
import { type DryRunCandidate, type DryRunRequest, SCORE_TERMS } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";

const INITIAL_REQUEST: DryRunRequest = { tools: false, images: false, reasoning: false };

function ScoreBreakdown({ candidate }: { candidate: DryRunCandidate }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
      {SCORE_TERMS.map((term) => (
        <div className="flex justify-between gap-2" key={term}>
          <dt className="capitalize">{term}</dt>
          <dd>{(candidate.reasons[term] ?? 0).toFixed(2)}</dd>
        </div>
      ))}
    </dl>
  );
}

function CandidateRow({ candidate }: { candidate: DryRunCandidate }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr>
        <td>{candidate.credentialLabel}</td>
        <td>{candidate.provider}</td>
        <td>{candidate.model}</td>
        <td>{candidate.tier}</td>
        <td className="text-right">{candidate.score.toFixed(2)}</td>
        <td className="text-right">
          <Button
            aria-expanded={expanded}
            aria-label={`Score breakdown for ${candidate.credentialLabel}`}
            onClick={() => setExpanded((value) => !value)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Details
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <ScoreBreakdown candidate={candidate} />
          </td>
        </tr>
      )}
    </>
  );
}

export function DryRunPanel({ modelId }: { modelId: string }) {
  const [request, setRequest] = useState<DryRunRequest>(INITIAL_REQUEST);
  const run = useMutation({ mutationFn: () => dryRun(modelId, request) });

  return (
    <section aria-labelledby="dry-run-heading" className="space-y-4 rounded-lg border p-4">
      <div>
        <h2 id="dry-run-heading">Dry run</h2>
        <p className="text-sm text-muted-foreground">
          Preview routing without sending a prompt or contacting a provider.
        </p>
      </div>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="sr-only">Required capabilities</legend>
        {(
          [
            ["tools", "Needs tools"],
            ["images", "Needs images"],
            ["reasoning", "Needs reasoning"],
          ] as const
        ).map(([key, label]) => (
          <label className="flex items-center gap-2" key={key}>
            <input
              checked={request[key]}
              onChange={(event) =>
                setRequest((current) => ({ ...current, [key]: event.target.checked }))
              }
              type="checkbox"
            />
            {label}
          </label>
        ))}
      </fieldset>
      <Button disabled={run.isPending} onClick={() => run.mutate()} type="button">
        {run.isPending ? "Running…" : "Run dry run"}
      </Button>
      {run.isError && <ErrorState error={run.error} />}
      {run.data !== undefined && (
        <div className="space-y-4">
          {!run.data.deterministic && (
            <p className="text-sm text-muted-foreground">
              This uses a fixed weighted draw; live ordering will differ.
            </p>
          )}
          {run.data.candidates.length === 0 ? (
            <p>No candidate would be eligible for this request.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left">Credential</th>
                  <th className="text-left">Provider</th>
                  <th className="text-left">Model</th>
                  <th className="text-left">Tier</th>
                  <th className="text-right">Score</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {run.data.candidates.map((candidate) => (
                  <CandidateRow
                    candidate={candidate}
                    key={`${candidate.credentialId}:${candidate.model}`}
                  />
                ))}
              </tbody>
            </table>
          )}
          <section aria-label="Excluded candidates">
            <h3>Excluded candidates</h3>
            {run.data.excluded.length === 0 ? (
              <p>Nothing was filtered out.</p>
            ) : (
              <ul className="list-disc pl-5 text-sm">
                {run.data.excluded.map((candidate) => (
                  <li key={`${candidate.credentialId}:${candidate.model}`}>
                    {candidate.credentialId} / {candidate.model}: {candidate.reason}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
