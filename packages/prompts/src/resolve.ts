import {
  PROMPT_MISSING_NOTE,
  type PromptAssignment,
  readPromptAssignment,
  readPromptIds,
} from "./catalog.ts";
import type { ResolvedPrompt } from "./index.ts";

export type PromptResolution = {
  prompts: readonly ResolvedPrompt[];
  notes: readonly string[];
};

export function resolvePrompts(
  globalIds: readonly string[],
  assignment: PromptAssignment,
  active: ReadonlyMap<string, ResolvedPrompt>,
): PromptResolution {
  const key = readPromptAssignment(assignment);
  const global = key.inheritGlobal ? readPromptIds(globalIds) : [];
  const keyBuiltin = key.ids.find((id) => id.startsWith("ponytail-"));
  const ids = [
    ...global.filter(
      (id) => !id.startsWith("ponytail-") || keyBuiltin === undefined || id === keyBuiltin,
    ),
    ...key.ids,
  ];
  const seen = new Set<string>();
  const prompts: ResolvedPrompt[] = [];
  let missing = false;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const prompt = active.get(id);
    if (prompt === undefined) missing = true;
    else prompts.push(prompt);
  }
  return { prompts, notes: missing ? [PROMPT_MISSING_NOTE] : [] };
}
