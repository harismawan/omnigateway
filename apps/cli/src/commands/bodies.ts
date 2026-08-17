import { type RequestBodyRead, readRequestBody } from "@omni/control";
import type { BodyArtifact, BodyDetailState } from "@omni/store";
import { boolFlag, requirePositional } from "../args.ts";
import { type Command, provider } from "../command.ts";
import type { Context } from "../context.ts";
import { emit, fields, formatBytes, formatTime, paint, table } from "../output.ts";

/**
 * Why there is nothing to print, in the operator's terms.
 *
 * The three absences are different answers and an operator acts on each
 * differently: `none` is a configuration answer, `missing` is a retention
 * answer, `corrupt` is an encryption-key answer. Collapsing them into one "no
 * body" would send someone hunting for a setting they already have on. None of
 * them is a failure — a file tree and a table that are not written together will
 * drift — so all three exit 0 and say what happened.
 *
 * The same three sentences the console shows, deliberately: an operator who read
 * one of them on the dashboard and then ran this command must not have to work
 * out whether the two mean the same thing.
 */
const ABSENCE: Record<Exclude<BodyDetailState, "ready">, readonly [string, string]> = {
  none: [
    "not captured",
    "Body capture was not running for this request. It needs OMNI_BODY_LOGGING_ALLOWED in the environment and bodyLoggingEnabled turned on, and the calling key must not have opted out.",
  ],
  missing: [
    "captured, then lost",
    "This request was captured, but its artifact is no longer on disk. Retention or the row cap has since pruned it, or something removed the file underneath the gateway.",
  ],
  corrupt: [
    "captured, but unreadable",
    "This request was captured and the artifact is still on disk, but it failed its checksum or would not decrypt. Changing OMNI_ENCRYPTION_KEY invalidates every artifact written under the old one.",
  ],
};

const encoder = new TextEncoder();

/**
 * How large one stored payload is as JSON.
 *
 * Not what crossed the wire. The artifact holds the masked, structurally bounded
 * copy, so every count here describes what is on disk — which is the number worth
 * printing, because it is the one an operator compares against the bounds and
 * against the other pairs in the same request.
 *
 * A half that never happened is `0 B` rather than a dash: an attempt that got no
 * response and an attempt whose response was empty are both nothing to read, and
 * inventing a distinction between them would be inventing a fact.
 */
function payloadBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return encoder.encode(JSON.stringify(value)).length;
}

/** The frame: what was captured, when, how big, and whether anything was cut. */
function frame(read: RequestBodyRead): string {
  return fields([
    ["STATE", read.detailState],
    ["CAPTURED", formatTime(read.at)],
    // Ciphertext, so this is larger than the plaintext bounds suggest — roughly
    // double, because encryption emits hex. It is the number that fills a volume.
    ["SIZE", `${formatBytes(read.sizeBytes)} on disk`],
    ["TRUNCATED", read.truncated ? "yes" : "no"],
  ]);
}

/**
 * One line per pair, with the side of RTK each request sits on.
 *
 * `REQUEST IS` is a column rather than a note under the table because the stage
 * belongs to the request half alone: the response came back from wherever the
 * request went, and labelling a whole row `post-RTK` would claim RTK touched a
 * response it never sees.
 */
function pairs(ctx: Context, artifact: BodyArtifact): string {
  const frames = artifact.attempts.some((attempt) => attempt.streamChunks !== null);

  const label = (text: string, truncated: boolean): string =>
    truncated ? `${text} (truncated)` : text;

  return table(
    [
      { header: "PAIR" },
      { header: "PROVIDER" },
      { header: "REQUEST", align: "right" },
      { header: "RESPONSE", align: "right" },
      ...(frames ? [{ header: "FRAMES", align: "right" } as const] : []),
      { header: "REQUEST IS" },
    ],
    [
      [
        label("CLIENT", artifact.client.truncated),
        "",
        formatBytes(payloadBytes(artifact.client.request)),
        formatBytes(payloadBytes(artifact.client.response)),
        ...(frames ? ["—"] : []),
        "pre-RTK",
      ],
      ...artifact.attempts.map((attempt) => [
        label(`ATTEMPT ${attempt.attempt}`, attempt.truncated),
        provider(ctx, attempt.provider),
        formatBytes(payloadBytes(attempt.request)),
        formatBytes(payloadBytes(attempt.response)),
        ...(frames
          ? [attempt.streamChunks === null ? "—" : String(attempt.streamChunks.length)]
          : []),
        "post-RTK",
      ]),
    ],
  );
}

/** One payload under a heading that says exactly which payload it is. */
function block(ctx: Context, heading: string, value: unknown): string {
  const body =
    value === null || value === undefined
      ? "(nothing recorded for this half — it never happened, or never completed)"
      : JSON.stringify(value, null, 2);
  return `${paint(ctx, "dim", heading)}\n${body}`;
}

/** Every payload in the artifact, in the order the request lived through them. */
function full(ctx: Context, artifact: BodyArtifact): string {
  const sections = [
    block(ctx, "CLIENT REQUEST (pre-RTK)", artifact.client.request),
    block(ctx, "CLIENT RESPONSE", artifact.client.response),
  ];

  for (const attempt of artifact.attempts) {
    const name = `ATTEMPT ${attempt.attempt} ${provider(ctx, attempt.provider)}`;
    sections.push(block(ctx, `${name} REQUEST (post-RTK)`, attempt.request));
    sections.push(block(ctx, `${name} RESPONSE`, attempt.response));
    if (attempt.streamChunks !== null) {
      sections.push(
        block(ctx, `${name} STREAM FRAMES (${attempt.streamChunks.length})`, attempt.streamChunks),
      );
    }
  }

  if (artifact.error !== null && artifact.error !== undefined) {
    sections.push(block(ctx, "ERROR", artifact.error));
  }

  return sections.join("\n\n");
}

export const bodies: Command = {
  usage: "bodies <request-id> [--full]",
  summary: "Show captured bodies for one request; withheld unless --full",
  options: { full: { type: "boolean" } },

  /**
   * Prints the frame and withholds the bodies unless asked.
   *
   * Every other read in this CLI prints everything it has, and this one does not,
   * because this one prints conversations. `omni logs` and `omni usage` print
   * metrics an operator can leave on screen; an artifact is the prompt itself.
   * A terminal keeps scrollback, a multiplexer keeps a logged pane, and an
   * operator who runs this mid-incident is usually sharing that screen. Asking
   * for the bodies costs one flag; printing them by default costs a prompt corpus
   * in someone's session log, and costs it silently.
   */
  async run(args, { ctx, writer }) {
    const requestId = requirePositional(args, 0, "request id");
    const read = await readRequestBody(await ctx.store(), requestId);

    // The whole read rather than the bare artifact: `detailState` is the answer
    // whenever the artifact is null, and a script handed only the artifact could
    // not tell "capture was off" from "pruned" from "will not decrypt".
    emit(ctx, writer, read, () => {
      const artifact = read.artifact;
      if (artifact === null) {
        const [legend, message] =
          ABSENCE[read.detailState === "ready" ? "corrupt" : read.detailState];
        return [frame(read), "", legend, message].join("\n");
      }

      const lines = [frame(read), "", pairs(ctx, artifact)];

      // The one sentence that stops a reader misreading the two halves. The
      // client request is what arrived; each attempt request is what went
      // upstream after RTK ran, so a compressed tool result in the second is not
      // evidence the client sent it.
      if (artifact.attempts.length > 0) {
        lines.push(
          "",
          paint(
            ctx,
            "dim",
            "the client request is pre-RTK and every attempt request is post-RTK; they are not the same payload",
          ),
        );
      }

      if (artifact.error !== null && artifact.error !== undefined) {
        // Named, not printed: a provider error frequently quotes the payload
        // back, which puts it under the same withholding rule as a body.
        lines.push("", "an error was recorded for this request");
      }

      if (boolFlag(args.values, "full")) {
        lines.push("", full(ctx, artifact));
      } else {
        lines.push("", "bodies withheld; pass --full to print them, --json for the artifact");
      }

      return lines.join("\n");
    });
  },
};
