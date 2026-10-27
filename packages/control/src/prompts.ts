import { estimateInputTokens, GatewayError } from "@omni/ir";
import { builtinPrompts, type ResolvedPrompt } from "@omni/prompts";
import { isPromptId } from "@omni/prompts/catalog";
import type { PromptAssignments, PromptDetail, PromptVersion, Store } from "@omni/store";
import { promptOperation } from "./promptErrors.ts";
import {
  parseOrThrow,
  promptActivateSchema,
  promptCreateSchema,
  promptDuplicateSchema,
  promptMetadataSchema,
  promptSaveSchema,
} from "./schemas.ts";

export type PromptLibraryEntry = {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
  activeVersion: number | string | null;
  estimatedTokens: number;
  assignments: PromptAssignments;
};
export type PromptView = PromptLibraryEntry & {
  versions: Array<{
    version: number | string;
    text: string;
    note: string | null;
    createdAt: number | null;
  }>;
};

function validateId(id: string, writable = false): void {
  if (!isPromptId(id)) throw new GatewayError("BAD_REQUEST", "invalid prompt id");
  if (writable && id.startsWith("ponytail-"))
    throw new GatewayError("BAD_REQUEST", "built-in prompts are read-only");
}

function estimate(text: string | undefined): number {
  return text === undefined
    ? 0
    : estimateInputTokens({
        model: "",
        stream: false,
        messages: [],
        system: [{ type: "text", text }],
      });
}

async function userView(store: Store, detail: PromptDetail): Promise<PromptView> {
  const selected =
    detail.activeVersion === null
      ? detail.versions[0]
      : detail.versions.find((v) => v.version === detail.activeVersion);
  return {
    id: detail.id,
    name: detail.name,
    description: detail.description,
    builtin: false,
    activeVersion: detail.activeVersion,
    estimatedTokens: estimate(selected?.text),
    assignments: await store.prompts.assignments(detail.id),
    versions: detail.versions.map(({ version, text, note, createdAt }) => ({
      version,
      text,
      note,
      createdAt,
    })),
  };
}

async function builtinView(store: Store, prompt: ResolvedPrompt): Promise<PromptView> {
  const labels: Record<string, string> = {
    "ponytail-lite": "Ponytail Lite",
    "ponytail-full": "Ponytail Full",
    "ponytail-ultra": "Ponytail Ultra",
  };
  return {
    id: prompt.id,
    name: labels[prompt.id] ?? prompt.id,
    description: "Pinned Ponytail ruleset v4.9.0",
    builtin: true,
    activeVersion: prompt.version,
    estimatedTokens: estimate(prompt.text),
    assignments: await store.prompts.assignments(prompt.id),
    versions: [{ version: prompt.version, text: prompt.text, note: null, createdAt: null }],
  };
}

export async function listPrompts(store: Store): Promise<PromptLibraryEntry[]> {
  return promptOperation(async () => {
    const ids = [
      ...builtinPrompts().map((p) => p.id),
      ...(await store.prompts.list()).map((p) => p.id),
    ];
    return Promise.all(
      ids.map(async (id) => {
        const { versions: _versions, ...entry } = await readPrompt(store, id);
        return entry;
      }),
    );
  });
}

export async function readPrompt(store: Store, id: string): Promise<PromptView> {
  validateId(id);
  const builtin = builtinPrompts().find((p) => p.id === id);
  return promptOperation(async () => {
    if (builtin) return builtinView(store, builtin);
    const detail = await store.prompts.get(id);
    if (!detail) throw new GatewayError("BAD_REQUEST", "no such prompt");
    return userView(store, detail);
  });
}

export async function createPrompt(store: Store, input: unknown): Promise<PromptView> {
  const body = parseOrThrow(promptCreateSchema, input);
  return promptOperation(async () => userView(store, await store.prompts.create(body)));
}

export async function updatePrompt(store: Store, id: string, input: unknown): Promise<PromptView> {
  validateId(id, true);
  const body = parseOrThrow(promptMetadataSchema, input);
  return promptOperation(async () => {
    await store.prompts.update(id, body);
    return readPrompt(store, id);
  });
}

export async function savePromptVersion(
  store: Store,
  id: string,
  input: unknown,
): Promise<PromptVersion> {
  validateId(id, true);
  const body = parseOrThrow(promptSaveSchema, input);
  return promptOperation(() => store.prompts.saveVersion(id, body));
}

export async function activatePromptVersion(
  store: Store,
  id: string,
  input: unknown,
): Promise<PromptView> {
  validateId(id, true);
  const body = parseOrThrow(promptActivateSchema, input);
  return promptOperation(async () => {
    await store.prompts.activate(id, body.version);
    return readPrompt(store, id);
  });
}

export async function duplicatePrompt(
  store: Store,
  sourceId: string,
  input: unknown,
): Promise<PromptView> {
  const body = parseOrThrow(promptDuplicateSchema, input);
  const source = await readPrompt(store, sourceId);
  const selected =
    source.activeVersion === null
      ? source.versions[0]
      : source.versions.find((v) => v.version === source.activeVersion);
  if (!selected) throw new GatewayError("BAD_REQUEST", "no such prompt version");
  return createPrompt(store, { ...body, text: selected.text });
}

export async function removePrompt(store: Store, id: string): Promise<void> {
  validateId(id, true);
  return promptOperation(() => store.prompts.remove(id));
}
