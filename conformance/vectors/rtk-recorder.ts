/**
 * Recording shims for `rtk-export.ts`.
 *
 * `rtk-export.ts` copies `packages/rtk/test/*.test.ts` to a scratch directory
 * and points their `../src/index.ts` and `../src/command.ts` imports here.
 * Each wrapper calls the frozen function unchanged, appends the call and its
 * result to `$RTK_RECORD` as one JSON line, and hands the real result back, so
 * the copied suite still asserts against the frozen build while it records.
 */
import { appendFileSync } from "node:fs";
import type { ChatRequest } from "../../packages/ir/src/index.ts";
import { classifyCommand as frozenClassify } from "../../packages/rtk/src/command.ts";
import {
  extractCommand as frozenExtract,
  transformRequest as frozenTransform,
  type RtkConfig,
} from "../../packages/rtk/src/index.ts";

export type { RtkFilterId } from "../../packages/rtk/src/index.ts";

const sink = process.env.RTK_RECORD;

function record(entry: unknown): void {
  if (sink !== undefined) appendFileSync(sink, `${JSON.stringify(entry)}\n`);
}

export function transformRequest(request: ChatRequest, config: RtkConfig) {
  // Serialized before the call: a test may mutate the request afterwards.
  const before = JSON.stringify(request);
  const result = frozenTransform(request, config);
  if (config.enabled) record({ kind: "transformRequest", request: JSON.parse(before) });
  return result;
}

export function extractCommand(input: unknown) {
  // Only JSON-representable inputs can reach the Rust port; an object with a
  // prototype other than Object.prototype has no JSON form, so it is skipped.
  if (
    input === null ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) === Object.prototype ||
    Array.isArray(input)
  )
    record({ kind: "extractCommand", input });
  return frozenExtract(input);
}

export function classifyCommand(command: string) {
  record({ kind: "classifyCommand", command });
  return frozenClassify(command);
}
