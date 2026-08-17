import styled from "styled-components";
import { useRequestBody } from "../../api/queries.ts";
import type {
  BodyAttempt,
  BodyDetailState,
  BodyOmission,
  RequestBodyResponse,
} from "../../api/types.ts";
import { formatCount } from "../../lib/format.ts";
import { Chip } from "../../ui/Chip.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, Stack } from "../../ui/primitives.ts";
import { Failure, SkeletonRows } from "../../ui/States.tsx";

/**
 * Why there is nothing to show, in the operator's terms.
 *
 * The three absences mean genuinely different things and an operator acts on
 * each differently: `none` is a configuration answer, `missing` is a retention
 * answer, and `corrupt` is an encryption-key answer. Collapsing them into one
 * "no body" would send someone hunting for a setting they already have on.
 */
const ABSENCE: Record<Exclude<BodyDetailState, "ready">, { legend: string; message: string }> = {
  none: {
    legend: "Not captured",
    message:
      "Body capture was not running for this request. It needs OMNI_BODY_LOGGING_ALLOWED in the environment and the body logging setting turned on, and the calling key must not have opted out.",
  },
  missing: {
    legend: "Captured, then lost",
    message:
      "This request was captured, but its artifact is no longer on disk. Retention or the row cap has since pruned it, or something removed the file underneath the gateway.",
  },
  corrupt: {
    legend: "Captured, but unreadable",
    message:
      "This request was captured and the artifact is still on disk, but it failed its checksum or would not decrypt. Changing OMNI_ENCRYPTION_KEY invalidates every artifact written under the old one.",
  },
};

/**
 * Exact bytes, never a compact figure.
 *
 * `formatCount` switches to compact notation past ten thousand, so 900,000 reads
 * as "900k". A size an operator is comparing against a stated 512 KB cap is a
 * number to read, not to skim.
 */
const BYTES = new Intl.NumberFormat("en-US");

const Note = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
  max-width: 62ch;
`;

/**
 * The one sentence that stops an operator misreading the two halves.
 *
 * Bordered rather than merely dim: it is a caveat about what the panel below
 * means, and a reader who skims past it draws exactly the wrong conclusion from
 * a compressed tool result.
 */
const Caveat = styled(Note)`
  border-left: 2px solid ${({ theme }) => theme.color.ruleStrong};
  padding-left: ${({ theme }) => theme.space(2)};
`;

const Heading = styled.h4`
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: ${({ theme }) => theme.color.inkDim};
  margin: 0;
`;

const Caption = styled.figcaption`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  flex-wrap: wrap;
  margin-bottom: 4px;
`;

const Figure = styled.figure`
  margin: 0;
  min-width: 0;
`;

const Payload = styled.pre`
  margin: 0;
  padding: ${({ theme }) => theme.space(2)};
  max-height: 260px;
  overflow: auto;
  border: 1px solid ${({ theme }) => theme.color.rule};
  border-radius: ${({ theme }) => theme.radius.control};
  background: ${({ theme }) => theme.color.panelSunk};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
`;

/**
 * Recognises the marker the store writes in place of a body it would not keep.
 *
 * Structural rather than typed: both halves of a pair are `unknown` by design,
 * because a body is whatever the client or the provider sent. This is the one
 * shape the gateway itself puts there, and telling it apart from a payload that
 * merely happens to have an `omitted` field is not worth more than checking
 * that the reason came with it.
 */
function asOmission(value: unknown): BodyOmission | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.omitted !== true || typeof record.reason !== "string") return null;
  const bytes = record.serializedBytes;
  return {
    omitted: true,
    reason: record.reason,
    serializedBytes: typeof bytes === "number" ? bytes : 0,
  };
}

type BodyBlockProps = {
  title: string;
  /** Which side of RTK this payload sits on, or absent where RTK cannot apply. */
  stage?: "pre-RTK" | "post-RTK";
  value: unknown;
};

/**
 * One request or response payload, under a caption that says what it is.
 *
 * The stage chip is not decoration. `client.request` and `attempts[].request`
 * are different payloads whenever an RTK filter fired, and a reader who assumes
 * otherwise will read a compressed tool result as what their client sent.
 */
function BodyBlock({ title, stage, value }: BodyBlockProps) {
  const omitted = asOmission(value);
  return (
    <Figure>
      <Caption>
        <Heading>{title}</Heading>
        {stage === undefined ? null : <Chip>{stage}</Chip>}
      </Caption>
      {omitted !== null ? (
        <Note>
          Too large to keep: {omitted.reason}. The payload was{" "}
          {BYTES.format(omitted.serializedBytes)} bytes after structural bounding, so it was
          replaced by this marker rather than written oversized or dropped without a trace.
        </Note>
      ) : value === null || value === undefined ? (
        <Note>Nothing was recorded for this half — it never happened, or never completed.</Note>
      ) : (
        <Payload>{JSON.stringify(value, null, 2)}</Payload>
      )}
    </Figure>
  );
}

function AttemptSection({ attempt }: { attempt: BodyAttempt }) {
  return (
    <Stack $gap={2}>
      <Row $gap={2} $wrap>
        <Legend as="h3">
          Attempt {attempt.attempt} · {attempt.provider}
        </Legend>
        {attempt.truncated ? <Chip $tone="warn">truncated</Chip> : null}
      </Row>
      <BodyBlock title="Request sent to the provider" stage="post-RTK" value={attempt.request} />
      <BodyBlock title="Response from the provider" value={attempt.response} />
      {attempt.streamChunks === null ? null : (
        <BodyBlock
          title={`Raw stream frames (${formatCount(attempt.streamChunks.length)})`}
          value={attempt.streamChunks}
        />
      )}
    </Stack>
  );
}

function Artifact({ body }: { body: RequestBodyResponse }) {
  const artifact = body.artifact;
  if (artifact === null) {
    const absence = ABSENCE[body.detailState === "ready" ? "corrupt" : body.detailState];
    return (
      <Stack $gap={1}>
        <Legend>{absence.legend}</Legend>
        <Note>{absence.message}</Note>
      </Stack>
    );
  }

  return (
    <Stack $gap={3}>
      {/* One paragraph, no inline markup: it is read as a sentence and the
          border already carries the emphasis. */}
      {artifact.attempts.length === 0 ? null : (
        <Caveat>
          The client request below is what arrived at the gateway. Each attempt request is what went
          upstream after RTK filters ran, so the two are not the same payload — compare them to see
          what compression actually removed.
        </Caveat>
      )}

      <Stack $gap={2}>
        <Row $gap={2} $wrap>
          <Legend as="h3">Client</Legend>
          {artifact.client.truncated ? <Chip $tone="warn">truncated</Chip> : null}
        </Row>
        <BodyBlock
          title="Request from the client"
          stage="pre-RTK"
          value={artifact.client.request}
        />
        <BodyBlock title="Response returned to the client" value={artifact.client.response} />
      </Stack>

      {artifact.attempts.map((attempt) => (
        <AttemptSection key={`${attempt.attempt}-${attempt.provider}`} attempt={attempt} />
      ))}

      {artifact.error === null || artifact.error === undefined ? null : (
        <BodyBlock title="Error" value={artifact.error} />
      )}
    </Stack>
  );
}

/**
 * The captured bodies for one request, shown when its log row is expanded.
 *
 * Everything this renders is either a payload or a reason there is not one; it
 * never fails closed to a blank panel, because an operator who opened this
 * during an incident needs to be told which of "off", "pruned", and "unreadable"
 * they are looking at.
 */
export function BodyArtifact({ requestId }: { requestId: string }) {
  const body = useRequestBody(requestId);

  const meta =
    body.data === undefined || body.data.detailState !== "ready"
      ? undefined
      : `${BYTES.format(body.data.sizeBytes)} bytes stored`;

  return (
    <Module
      legend="Captured bodies"
      {...(meta === undefined ? {} : { meta })}
      {...(body.data?.truncated === true ? { actions: <Chip $tone="warn">truncated</Chip> } : {})}
    >
      {body.isError ? (
        <Failure error={body.error} onRetry={() => void body.refetch()} />
      ) : body.isPending ? (
        <SkeletonRows rows={3} />
      ) : (
        <Artifact body={body.data} />
      )}
    </Module>
  );
}
