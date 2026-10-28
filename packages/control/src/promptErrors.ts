import { GatewayError, safeToken } from "@omni/ir";
import { PromptStoreError } from "@omni/store";

/** Only repository-owned failure kinds cross the control boundary, never raw error text. */
export async function promptOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof PromptStoreError)) throw error;
    switch (error.kind) {
      case "missing":
        throw new GatewayError("BAD_REQUEST", "no such prompt");
      case "version-missing":
        throw new GatewayError("BAD_REQUEST", "no such prompt version");
      case "exists":
        throw new GatewayError("CONFLICT", "prompt id already exists");
      case "limit":
        throw new GatewayError("CONFLICT", "prompt limit reached");
      case "assigned": {
        const refs = error.assignments;
        const locations = [
          ...(refs?.global ? ["global settings"] : []),
          ...(refs?.keyIds ?? []).map((id) => `key ${safeToken(id)}`),
        ];
        throw new GatewayError(
          "CONFLICT",
          `prompt is assigned${locations.length ? `: ${locations.join(", ")}` : ""}`,
        );
      }
    }
  }
}
