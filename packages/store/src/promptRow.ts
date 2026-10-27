import type { Prompt, PromptVersion } from "./types.ts";

export type PromptRow = {
  id: string;
  name: string;
  description: string | null;
  active_version: number | null;
  created_at: number | string;
  updated_at: number | string;
};
export type PromptVersionRow = {
  prompt_id: string;
  version: number;
  text: string;
  note: string | null;
  created_at: number | string;
};
export const toPrompt = (row: PromptRow): Prompt => ({
  id: row.id,
  name: row.name,
  description: row.description,
  activeVersion: row.active_version,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});
export const toPromptVersion = (row: PromptVersionRow): PromptVersion => ({
  promptId: row.prompt_id,
  version: row.version,
  text: row.text,
  note: row.note,
  createdAt: Number(row.created_at),
});
