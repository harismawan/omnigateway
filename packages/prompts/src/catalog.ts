/** Shared library cap; consumed by transactional persistence in the next task. */
export const MAX_USER_PROMPTS = 50;
/** Shared retained-history cap; consumed by transactional persistence in the next task. */
export const MAX_PROMPT_VERSIONS = 100;
export const MAX_ASSIGNED_PROMPTS = 5;
/** Shared saved-text cap; strict control validation is added in a later task. */
export const MAX_PROMPT_TEXT_CHARS = 16_000;
export const MAX_APPENDED_PROMPT_CHARS = 32_000;
export const PROMPT_MISSING_NOTE = "prompt:missing";

export type PromptAssignment = { ids: string[]; inheritGlobal: boolean };

export function isPromptId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,40}$/.test(value)) return false;
  return (
    !value.startsWith("ponytail-") ||
    value === "ponytail-lite" ||
    value === "ponytail-full" ||
    value === "ponytail-ultra"
  );
}

/** Stored values are repaired here; write APIs validate rather than silently repairing. */
export function readPromptIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  let builtinSeen = false;
  for (const id of value) {
    if (!isPromptId(id) || seen.has(id)) continue;
    const builtin = id.startsWith("ponytail-");
    if (builtin && builtinSeen) continue;
    ids.push(id);
    seen.add(id);
    builtinSeen ||= builtin;
    if (ids.length === MAX_ASSIGNED_PROMPTS) break;
  }
  return ids;
}

export function readPromptAssignment(value: unknown): PromptAssignment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ids: [], inheritGlobal: true };
  }
  return {
    ids: readPromptIds("ids" in value ? value.ids : undefined),
    inheritGlobal:
      !("inheritGlobal" in value) || typeof value.inheritGlobal !== "boolean"
        ? true
        : value.inheritGlobal,
  };
}
