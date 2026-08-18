import { useState } from "react";
import styled from "styled-components";
import { useSaveRetention } from "../../api/queries.ts";
import type { RetentionPolicy } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Field, NumberInput } from "../../ui/Field.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";

/**
 * Both bounds, and what each one is for.
 *
 * A count on its own leaves a year of stale copies on a quiet installation and
 * an age on its own leaves however many an operator can click in a day, so the
 * gateway enforces both and this form edits both.
 */
const BOUNDS: ReadonlyArray<{
  id: keyof RetentionPolicy;
  label: string;
  hint: string;
  unit: string;
  max: number;
}> = [
  {
    id: "keepLatest",
    label: "Snapshots kept",
    hint: "How many survive regardless of age. The newest is always kept, whatever both numbers say.",
    unit: "files",
    max: 100,
  },
  {
    id: "maxAgeDays",
    label: "Maximum age",
    hint: "Older snapshots are pruned after every new one and on the hourly maintenance sweep.",
    unit: "days",
    max: 3_650,
  },
];

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Saved = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.ok};
`;

const Fields = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: ${({ theme }) => theme.space(3)};
`;

type Draft = Record<keyof RetentionPolicy, string>;

function parseDraft(
  draft: Draft,
): { ok: true; policy: RetentionPolicy } | { ok: false; problem: string } {
  const parsed = {} as RetentionPolicy;
  for (const bound of BOUNDS) {
    const raw = draft[bound.id].trim();
    const value = Number(raw);
    // A blank field is not zero, and zero is not a policy: it would prune the
    // only copy of a database that a restore is the way back from.
    if (raw.length === 0 || !Number.isInteger(value) || value < 1) {
      return { ok: false, problem: `${bound.label} must be a whole number of 1 or more.` };
    }
    if (value > bound.max) {
      return { ok: false, problem: `${bound.label} cannot exceed ${bound.max}.` };
    }
    parsed[bound.id] = value;
  }
  return { ok: true, policy: parsed };
}

/** The bound on how many copies of the database this installation keeps. */
export function RetentionModule({ retention }: { retention: RetentionPolicy | undefined }) {
  const save = useSaveRetention();
  // Only what the operator has typed. The saved policy shows through anywhere
  // they have not, so the form fills itself the moment the read lands without an
  // effect that copies one piece of state into another.
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const draft: Draft = {
    keepLatest: edits.keepLatest ?? (retention === undefined ? "" : String(retention.keepLatest)),
    maxAgeDays: edits.maxAgeDays ?? (retention === undefined ? "" : String(retention.maxAgeDays)),
  };

  const submit = () => {
    setSaved(false);
    const parsed = parseDraft(draft);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    save.mutate(parsed.policy, {
      onSuccess: () => {
        setSaved(true);
        // Back to showing what is stored, so a value the gateway adjusted is
        // the one on screen.
        setEdits({});
      },
      onError: (error) => setProblem(describeError(error)),
    });
  };

  return (
    <Module
      legend="Retention"
      actions={
        <Button
          type="button"
          $size="sm"
          disabled={save.isPending || retention === undefined}
          onClick={submit}
        >
          {save.isPending ? "Saving…" : "Save retention"}
        </Button>
      }
    >
      <Stack $gap={3}>
        <Fields>
          {BOUNDS.map((bound) => (
            <Field key={bound.id} label={bound.label} hint={bound.hint}>
              {(props) => (
                <Row $gap={2}>
                  <NumberInput
                    {...props}
                    min={1}
                    max={bound.max}
                    step={1}
                    value={draft[bound.id]}
                    onChange={(event) => setEdits({ ...edits, [bound.id]: event.target.value })}
                  />
                  <Legend>{bound.unit}</Legend>
                </Row>
              )}
            </Field>
          ))}
        </Fields>
        {problem === null ? null : <Problem role="alert">{problem}</Problem>}
        {saved && problem === null ? <Saved role="status">Retention saved.</Saved> : null}
      </Stack>
    </Module>
  );
}
