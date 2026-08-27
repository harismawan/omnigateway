import { type ClientProfile, env, envOrder } from "../headers.ts";

const KIMI_CLI_VERSION = env("OMNI_KIMI_CLI_VERSION", "0.26.0");

// No traffic capture exists for kimi-code-cli. This order is constructed to be
// plausible, not verified. Treat it as a weaker guarantee than the other two.
export const kimiProfile: ClientProfile = {
  headers: [
    ["User-Agent", env("OMNI_UA_KIMI", `kimi-code-cli/${KIMI_CLI_VERSION}`)],
    ["X-Msh-Platform", "kimi_code_cli"],
    ["X-Msh-Version", KIMI_CLI_VERSION],
    ["Accept", "application/json"],
  ],
  // The operator override is applied here rather than where the table is
  // assembled. An adapter reads this value directly, so a table that applied
  // something the direct read did not would differ only on installations that
  // set the variable — which is the shape of bug this repository keeps finding.
  order: envOrder("OMNI_ORDER_KIMI", [
    "Host",
    "Content-Type",
    "Authorization",
    "X-Msh-Platform",
    "X-Msh-Version",
    "X-Msh-Device-Id",
    "X-Msh-Device-Name",
    "X-Msh-Device-Model",
    "X-Msh-Os-Version",
    "User-Agent",
    "Accept",
    "Accept-Encoding",
    "Content-Length",
  ]),
};

// Constructed, not captured. See the profile note in Task 8B.
// `stream_options` is deliberately absent: the order mirrors what each CLI's
// own serializer emits, and this gateway adds that field for usage reporting
// rather than copying it from one. Unlisted keys append in insertion order.
export const kimiBodyOrder: readonly string[] = [
  "model",
  "messages",
  "tools",
  "tool_choice",
  "max_tokens",
  "temperature",
  "stream",
];
