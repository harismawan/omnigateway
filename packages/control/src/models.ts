import { GatewayError } from "@omni/ir";
import type { Store, VirtualModel } from "@omni/store";
import { modelSchema, parseOrThrow } from "./schemas.ts";

export async function listModels(store: Store): Promise<VirtualModel[]> {
  return store.config.listModels();
}

export async function getModel(store: Store, id: string): Promise<VirtualModel> {
  const model = (await store.config.listModels()).find((m) => m.id === id);
  if (model === undefined) throw new GatewayError("MODEL_UNAVAILABLE", `no virtual model "${id}"`);
  return model;
}

/**
 * Validates and writes a virtual model.
 *
 * `id` is passed separately because the HTTP surface carries it in the path;
 * a body naming a different model is a mistake worth refusing rather than
 * silently resolving one way or the other.
 */
export async function putModel(store: Store, id: string, input: unknown): Promise<void> {
  const model: VirtualModel = parseOrThrow(modelSchema, input);
  if (model.id !== id) {
    throw new GatewayError("BAD_REQUEST", "model id in the path and body must match");
  }
  await store.config.putModel(model);
}

export async function removeModel(store: Store, id: string): Promise<void> {
  await store.config.removeModel(id);
}
