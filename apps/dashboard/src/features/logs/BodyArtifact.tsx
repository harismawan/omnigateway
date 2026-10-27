import styled from "styled-components";
import { useRequestBody } from "../../api/queries.ts";
import type { BodyDetailState, RequestBodyResponse } from "../../api/types.ts";
import { Chip } from "../../ui/Chip.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Stack } from "../../ui/primitives.ts";
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
 * as "900k". A size an operator is comparing against a stated cap is a number to
 * read, not to skim.
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

/** Worker-supplied preview and omission metadata; never parse a partial JSON prefix. */
type BodyBlockProps = {
  title: string;
  /** Which side of RTK this payload sits on, or absent where RTK cannot apply. */
  stage?: "pre-RTK" | "post-RTK";
  value: RequestBodyResponse["parts"][number];
  requestId: string;
};

/**
 * One request or response payload, under a caption that says what it is.
 *
 * The stage chip is not decoration. `client.request` and `attempts[].request`
 * are different payloads whenever an RTK filter fired, and a reader who assumes
 * otherwise will read a compressed tool result as what their client sent.
 */
function BodyBlock({ title, stage, value, requestId }: BodyBlockProps) {
  const omitted = value.omitted;
  return (
    <Figure>
      <Caption>
        {value.part.startsWith("attempt.") ? <Chip>Attempt {value.part.split(".")[1]}</Chip> : null}
        <Heading>{title}</Heading>
        {stage === undefined ? null : <Chip>{stage}</Chip>}
        <span>{BYTES.format(value.sizeBytes)} bytes</span>
        <a
          href={`/api/requests/${encodeURIComponent(requestId)}/body/raw?part=${encodeURIComponent(value.part)}`}
          download
        >
          Download full part
        </a>
      </Caption>
      {omitted !== null ? (
        <Note>
          Not kept: {omitted.reason}.
          {omitted.serializedBytes === null
            ? ""
            : ` The artifact was ${BYTES.format(omitted.serializedBytes)} bytes.`}{" "}
          The payload was replaced by this marker rather than written oversized or dropped without a
          trace.
        </Note>
      ) : value.preview === "null" ? (
        <Note>Nothing was recorded for this half — it never happened, or never completed.</Note>
      ) : (
        <>
          <Payload>{value.preview}</Payload>
          {value.previewTruncated ? (
            <Note>Preview truncated — download the full part to read more.</Note>
          ) : null}
        </>
      )}
    </Figure>
  );
}

function Artifact({ body }: { body: RequestBodyResponse }) {
  if (body.bodyState === "pending" || body.bodyState === "failed") {
    const pending = body.bodyState === "pending";
    return (
      <Stack $gap={1}>
        <Legend>{pending ? "Capture pending" : "Capture failed"}</Legend>
        <Note>
          {pending
            ? "The body writer has not published this capture yet. This panel checks again automatically while open."
            : "Body capture was attempted, but the writer could not publish an artifact. The body is unavailable."}
        </Note>
      </Stack>
    );
  }
  if (body.parts.length === 0) {
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
      {!body.parts.some((p) => p.part.startsWith("attempt.")) ? null : (
        <Caveat>
          The client request below is what arrived at the gateway. Each attempt request is what went
          upstream after RTK filters ran, so the two are not the same payload — compare them to see
          what compression actually removed.
        </Caveat>
      )}

      {body.parts
        .filter((p) => p.part !== "error" || p.preview !== "null")
        .map((value) => (
          <BodyBlock
            key={value.part}
            requestId={body.requestId}
            value={value}
            title={
              value.part === "client.request"
                ? "Request from the client"
                : value.part === "client.response"
                  ? "Response returned to the client"
                  : value.part === "error"
                    ? "Error"
                    : value.part.endsWith("request")
                      ? "Request sent to the provider"
                      : "Response from the provider"
            }
            {...(value.part.endsWith("request")
              ? {
                  stage:
                    value.part === "client.request" ? ("pre-RTK" as const) : ("post-RTK" as const),
                }
              : {})}
          />
        ))}
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
      : // "on disk" rather than a bare size, because this is the stored envelope:
        // it is measured after masking and then after encoding and encryption
        // (hex in the legacy format), so it is neither what crossed the wire nor
        // the size of the JSON below it. Naming the thing measured is cheaper
        // than an operator reading it as a request size.
        `${BYTES.format(body.data.sizeBytes)} bytes on disk`;

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
