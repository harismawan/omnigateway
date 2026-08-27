import { type ClientProfile, env, grokHost } from "../headers.ts";

// The version is the weakest constant in this file. xAI's source resolves it
// from a build-time env var and falls back to its crate version, so the 1.0.3 in
// the manifest is a source-tree artefact rather than what a shipped binary
// reports. 0.2.120 is the newest value observed on the wire by implementations
// that actually talk to the proxy — an observation, not a quote. The proxy gates
// on this header, and no captured rejection exists, so the env override is what
// makes a stale value an operator fix rather than a release. Treat this as a
// weaker guarantee than the Anthropic and OpenAI profiles, as with kimi above.
const GROK_CLI_VERSION = env("OMNI_GROK_CLI_VERSION", "0.2.120");
const grokUa = grokHost(process.platform, process.arch);

export const grokProfile: ClientProfile = {
  headers: [
    [
      "User-Agent",
      env("OMNI_UA_GROK", `grok-shell/${GROK_CLI_VERSION} (${grokUa.os}; ${grokUa.arch})`),
    ],
    // `grok-shell`, not `grok-cli`: no `grok-cli/<version>` identity exists
    // anywhere in xAI's own source.
    ["x-grok-client-identifier", "grok-shell"],
    ["x-grok-client-version", GROK_CLI_VERSION],
    ["x-grok-client-mode", "headless"],
    ["Accept", "text/event-stream"],
  ],
  // The OAuth-only pair sits with `Authorization` because it qualifies it, and
  // the per-request ids follow the client identity they belong to. A header the
  // adapter does not send is simply skipped, so listing all of them costs
  // nothing on the API-key route.
  order: [
    "Host",
    "Content-Type",
    "Authorization",
    "X-XAI-Token-Auth",
    "x-authenticateresponse",
    "x-grok-client-identifier",
    "x-grok-client-version",
    "x-grok-client-mode",
    "x-grok-agent-id",
    "x-grok-req-id",
    "x-grok-conv-id",
    "x-grok-session-id",
    "x-grok-model-override",
    "User-Agent",
    "Accept",
    "Accept-Encoding",
    "Content-Length",
  ],
};

// xAI's Responses surface takes the same field vocabulary as OpenAI's, so the
// order mirrors it rather than inventing a second spelling of the same body.
export const grokBodyOrder: readonly string[] = [
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
