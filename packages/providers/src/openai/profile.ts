import { type ClientProfile, env, envOrder } from "../headers.ts";

const OPENAI_CLI_VERSION = env("OMNI_OPENAI_CLI_VERSION", "0.159.2");
const OPENAI_UA_PLATFORM = env("OMNI_OPENAI_UA_PLATFORM", "Windows 10.0.26200");
const OPENAI_UA_ARCH = env("OMNI_OPENAI_UA_ARCH", "x86_64");
const OPENAI_UA_TERMINAL = env("OMNI_OPENAI_UA_TERMINAL", "WindowsTerminal");
const originator = env("OMNI_OPENAI_ORIGINATOR", "codex_cli_rs");

export const openaiProfile: ClientProfile = {
  headers: [
    [
      "user-agent",
      env(
        "OMNI_UA_OPENAI",
        `${originator}/${OPENAI_CLI_VERSION} (${OPENAI_UA_PLATFORM}; ${OPENAI_UA_ARCH}) ${OPENAI_UA_TERMINAL}`,
      ),
    ],
    ["originator", originator],
    ["version", OPENAI_CLI_VERSION],
    ["x-codex-beta-features", "remote_compaction_v2"],
    ["accept", "text/event-stream"],
  ],
  // The operator override is applied here rather than where the table is
  // assembled. An adapter reads this value directly, so a table that applied
  // something the direct read did not would differ only on installations that
  // set the variable — which is the shape of bug this repository keeps finding.
  order: envOrder("OMNI_ORDER_OPENAI", [
    "host",
    "version",
    "x-codex-beta-features",
    "originator",
    // Codec-supplied names stay in the CLI's order rather than appending after
    // `user-agent`, where `orderHeaders` puts names it does not know.
    "x-client-request-id",
    "session-id",
    "thread-id",
    "accept",
    "content-type",
    "authorization",
    "chatgpt-account-id",
    "user-agent",
    "accept-encoding",
    "content-length",
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
