import { readPromptAssignment } from "@omni/prompts/catalog";
import { type PromptAssignments, PromptStoreError, readPromptSettings } from "./types.ts";

export function parsePromptJson(raw: string | null): unknown {
  try {
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Absence alone upgrades the legacy alias; an explicit malformed list stays empty. */
export function storedPromptIds(stored: { prompts?: unknown; ponytailMode?: unknown }): string[] {
  return readPromptSettings(stored).prompts;
}

/** Explicit stored references only; never effective inheritance or usable-key filtering. */
export function promptAssignments(
  id: string,
  settings: string | null,
  keys: readonly { id: string; prompts: string | null }[],
): PromptAssignments {
  const stored = parsePromptJson(settings);
  const ids = stored !== null && typeof stored === "object" ? storedPromptIds(stored) : [];
  return {
    global: ids.includes(id),
    keyIds: keys
      .filter((key) => readPromptAssignment(parsePromptJson(key.prompts)).ids.includes(id))
      .map((key) => key.id)
      .sort(),
  };
}

/** Caller holds the backend's management lock across this check and its write. */
export function checkPromptReferences(
  next: readonly string[],
  previous: readonly string[],
  existing: ReadonlySet<string>,
): void {
  for (const id of next) {
    if (!id.startsWith("ponytail-") && !previous.includes(id) && !existing.has(id)) {
      throw new PromptStoreError("missing");
    }
  }
}

/** Applied ids are forensic strings, not assignment ids (which omit versions). */
export function readAppliedPrompts(raw: string): string[] {
  const parsed = parsePromptJson(raw);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
}
