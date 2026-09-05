import { type ClientProfile, env, envOrder } from "../headers.ts";

/**
 * Muse's version string, which rides the User-Agent.
 *
 * Behind `env()` because upstream may one day gate on it, and a stale value
 * should then be an operator fix rather than a release. 1.0.3 is what the
 * `muse-stable` channel served on 2026-09-05.
 */
const MUSE_CLI_VERSION = env("OMNI_MUSE_CLI_VERSION", "1.0.3");

/**
 * **Constructed, not captured.** The launcher shell script sends
 * `muse-code/launcher-<n>` and the agent binary builds its own from a version
 * constant that does not survive as a readable string, so the shape here is
 * modelled on the launcher's rather than quoted from a live request. Nothing
 * upstream is known to gate on it today.
 *
 * `x-api-version` is quoted: the binary sends `1.0.0` on the auth calls, and it
 * is sent on every request here for the same reason a version header exists at
 * all — one value per client, not one per endpoint.
 *
 * Import from `headers.ts`, never from `profile.ts`. Taking `env` and
 * `envOrder` from the assembling module closes a module-initialisation cycle
 * whose only symptom is a gateway that will not boot, and only on installations
 * that set an `OMNI_ORDER_*` variable.
 */
export const museProfile: ClientProfile = {
  headers: [
    ["User-Agent", env("OMNI_UA_MUSE", `muse-code/${MUSE_CLI_VERSION}`)],
    ["x-api-version", env("OMNI_MUSE_API_VERSION", "1.0.0")],
    ["Accept", "text/event-stream"],
  ],
  order: envOrder("OMNI_ORDER_MUSE", [
    "Host",
    "Content-Type",
    "Authorization",
    // Not a profile header: the codec supplies it per request. Listed so it
    // keeps its place in the order rather than being appended after
    // `User-Agent`, which is where `orderHeaders` puts a name it does not know.
    "x-meta-ai-gateway-session-id",
    "x-api-version",
    "Accept",
    "User-Agent",
    "Accept-Encoding",
    "Content-Length",
  ]),
};

export const museBodyOrder: readonly string[] = [
  "model",
  "stream",
  "input",
  "instructions",
  "store",
  "reasoning",
  "prompt_cache_key",
  "max_output_tokens",
  "temperature",
  "tools",
  "tool_choice",
  "include",
  "parallel_tool_calls",
  "metadata",
];
