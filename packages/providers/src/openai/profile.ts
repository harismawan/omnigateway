import { type ClientProfile, env, envOrder } from "../headers.ts";

const OPENAI_CLI_VERSION = env("OMNI_OPENAI_CLI_VERSION", "0.144.1");
const OPENAI_UA_PLATFORM = env("OMNI_OPENAI_UA_PLATFORM", "Windows 10.0.26200");
const OPENAI_UA_ARCH = env("OMNI_OPENAI_UA_ARCH", "x64");

export const openaiProfile: ClientProfile = {
  headers: [
    [
      "User-Agent",
      env(
        "OMNI_UA_OPENAI",
        `codex-cli/${OPENAI_CLI_VERSION} (${OPENAI_UA_PLATFORM}; ${OPENAI_UA_ARCH})`,
      ),
    ],
    ["originator", env("OMNI_OPENAI_ORIGINATOR", "codex_cli_rs")],
    ["Version", OPENAI_CLI_VERSION],
    ["Openai-Beta", "responses=experimental"],
    ["X-Codex-Beta-Features", "responses_websockets"],
    ["Accept", "text/event-stream"],
  ],
  // The operator override is applied here rather than where the table is
  // assembled. An adapter reads this value directly, so a table that applied
  // something the direct read did not would differ only on installations that
  // set the variable — which is the shape of bug this repository keeps finding.
  order: envOrder("OMNI_ORDER_OPENAI", [
    "Host",
    "Content-Type",
    "Authorization",
    "chatgpt-account-id",
    "originator",
    "Version",
    "Openai-Beta",
    "X-Codex-Beta-Features",
    "Accept",
    "User-Agent",
    "Accept-Encoding",
    "Content-Length",
  ]),
};

export const openaiBodyOrder: readonly string[] = [
  "model",
  "stream",
  "input",
  "instructions",
  "store",
  "reasoning",
  "prompt_cache_key",
  "tools",
  "tool_choice",
  "include",
  "service_tier",
  "client_metadata",
  "parallel_tool_calls",
  "metadata",
];
