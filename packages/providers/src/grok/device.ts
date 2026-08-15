import { randomUUID } from "node:crypto";
import type { HeaderPair } from "../types.ts";

export type GrokDevice = {
  agentId: string;
};

/**
 * Mints a synthetic-but-stable agent identity.
 *
 * xAI's client derives this from a machine hash and caches it on disk, so
 * upstream expects one value per installation rather than one per request.
 * Deliberately not read from the host, for the same reason as kimi: a hostname
 * is routinely the operator's own name or their employer's asset tag, and it
 * would go upstream on every request. The value is made up once at connect time
 * and then frozen onto the credential — upstream needs it stable, not true.
 */
export function mintGrokDevice(): GrokDevice {
  return { agentId: randomUUID() };
}

/** Reads the identity back off a credential's providerData. */
export function grokDeviceHeaders(providerData: Record<string, unknown>): HeaderPair[] {
  const agentId = providerData.agentId;
  // Credentials created before the field existed carry nothing; sending a fresh
  // id per request would be a visible behavioural difference, so send none.
  //
  // The same branch means an API-key credential never sends the header at all:
  // only the OAuth flow mints an id, and `createApiKeyCredential` stores an
  // empty providerData. That split is intended — the fingerprint identifies an
  // installation of xAI's CLI to the cli-chat-proxy host, and api.x.ai neither
  // expects it nor knows what it means.
  if (typeof agentId !== "string" || agentId.length === 0) return [];
  return [["x-grok-agent-id", agentId]];
}
