import type { FileBlock } from "@omni/ir";

/**
 * Media types a Responses `input_file` is accepted with. The backend checks the
 * exact string (`text/x-yaml` passes, `text/yaml` fails) and refuses the whole
 * request on any other, so an unlisted file must never reach it as a file.
 * ponytail: measured against the Codex backend 2026-09-23, not a published
 * list — re-probe and extend when a type is refused that the backend now takes.
 */
const ACCEPTED = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/css",
  "text/xml",
  "text/calendar",
  "text/tab-separated-values",
  "text/javascript",
  "text/x-python",
  "text/x-c",
  "text/x-java",
  "text/x-sh",
  "text/x-sql",
  "text/x-typescript",
  "text/x-yaml",
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/toml",
  "application/yaml",
  "application/x-yaml",
  "message/rfc822",
  "application/rtf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/** Refused as files, but text: decoded into the output like any `text/*`. */
const TEXTUAL = new Set(["application/xml", "application/sql", "application/x-sh"]);

/**
 * Splits a tool result's files for a Responses wire: accepted types become
 * `input_file` parts, other text is decoded into text (the backend refuses
 * the type, not the content), and the rest cannot be sent at all.
 */
export function responsesFiles(files: readonly FileBlock[]): {
  parts: unknown[];
  text: string[];
  dropped: boolean;
} {
  const parts: unknown[] = [];
  const text: string[] = [];
  let dropped = false;
  for (const file of files) {
    if (ACCEPTED.has(file.mediaType)) {
      parts.push({
        type: "input_file",
        ...(file.filename !== undefined && { filename: file.filename }),
        file_data: `data:${file.mediaType};base64,${file.data}`,
      });
    } else if (file.mediaType.startsWith("text/") || TEXTUAL.has(file.mediaType)) {
      text.push(Buffer.from(file.data, "base64").toString("utf8"));
    } else {
      dropped = true;
    }
  }
  return { parts, text, dropped };
}
