import type { FileBlock } from "@omni/ir";

/**
 * Whether a file is text a model reads best as text. Measured live: Codex and
 * Gemini both answer NONE for a `text/plain` or `text/markdown` file sent as a
 * file part, yet read the same bytes decoded into the tool output every time,
 * and a Responses backend refuses several text types outright (`text/yaml`,
 * `application/xml`). So every encoder decodes these.
 */
export function isTextual(mediaType: string): boolean {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") || type.endsWith("+json") || type.endsWith("+xml") || TEXTUAL.has(type)
  );
}

const TEXTUAL = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/sql",
  "application/x-sh",
  "message/rfc822",
]);

/** A textual file's contents, decoded from its base64. */
export function fileText(file: FileBlock): string {
  return Buffer.from(file.data, "base64").toString("utf8");
}

/**
 * Splits a tool result's files for one wire: text is decoded (`text`), what the
 * wire's own file carrier `carries` goes as a file (`carried`), and anything
 * else cannot be sent (`dropped`).
 */
export function splitFiles(
  files: readonly FileBlock[],
  carries: (mediaType: string) => boolean,
): { text: string[]; carried: FileBlock[]; dropped: boolean } {
  const text: string[] = [];
  const carried: FileBlock[] = [];
  let dropped = false;
  for (const file of files) {
    if (isTextual(file.mediaType)) text.push(fileText(file));
    else if (carries(file.mediaType)) carried.push(file);
    else dropped = true;
  }
  return { text, carried, dropped };
}

/** A tool result's text followed by its decoded text files. */
export function withFileText(content: string, text: readonly string[]): string {
  return [content, ...text].filter((t) => t.length > 0).join("\n\n");
}

/**
 * Binary types a Responses `input_file` is accepted with, each with the
 * extension of the filename it gets when none came with it — the backend
 * refuses an `input_file` whose `file_data` has no `filename` (measured: 400
 * "Missing required parameter"), and an Anthropic `document` needs no title.
 * The backend checks the exact type string and refuses the whole request on any
 * other, so an unlisted file must never reach it as a file.
 * ponytail: measured against the Codex backend 2026-09-23, not a published
 * list — re-probe and extend when a type is refused that the backend now takes.
 */
const RESPONSES_FILE_TYPES: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  "application/pdf": "pdf",
  "application/rtf": "rtf",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
});

/** A file's own name, or `file.<ext>` for its type. */
export function fileName(file: FileBlock): string {
  return file.filename ?? `file.${RESPONSES_FILE_TYPES[file.mediaType] ?? "bin"}`;
}

/** Splits a tool result's files for a Responses wire; see `splitFiles`. */
export function responsesFiles(files: readonly FileBlock[]): {
  parts: unknown[];
  text: string[];
  dropped: boolean;
} {
  const { text, carried, dropped } = splitFiles(files, (t) => t in RESPONSES_FILE_TYPES);
  const parts = carried.map((file) => ({
    type: "input_file",
    filename: fileName(file),
    file_data: `data:${file.mediaType};base64,${file.data}`,
  }));
  return { parts, text, dropped };
}
