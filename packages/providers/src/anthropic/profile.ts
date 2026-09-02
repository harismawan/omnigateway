import { type ClientProfile, env, envOrder, envOrNull, stainlessHost } from "../headers.ts";

const host = stainlessHost(process.platform, process.arch);

/**
 * Exported because not every Anthropic call wears the same identity: the CLI
 * reaches `/v1/messages` through its Stainless client but reads its account
 * usage with plain axios, so that request reports `claude-code/<version>`
 * rather than `claude-cli/<version> (external, cli)`.
 */
export const ANTHROPIC_CLI_VERSION = env("OMNI_ANTHROPIC_CLI_VERSION", "2.1.258");

export const anthropicProfile: ClientProfile = {
  headers: [
    ["User-Agent", env("OMNI_UA_ANTHROPIC", `claude-cli/${ANTHROPIC_CLI_VERSION} (external, cli)`)],
    ["x-app", "cli"],
    ["anthropic-dangerous-direct-browser-access", "true"],
    ["X-Stainless-Lang", "js"],
    ["X-Stainless-Package-Version", env("OMNI_ANTHROPIC_STAINLESS_PACKAGE_VERSION", "0.112.1")],
    ["X-Stainless-OS", envOrNull("OMNI_ANTHROPIC_STAINLESS_OS") ?? host.os],
    ["X-Stainless-Arch", envOrNull("OMNI_ANTHROPIC_STAINLESS_ARCH") ?? host.arch],
    // Forced to node: this is what the real CLI reports, and reporting "bun"
    // would be a one-header giveaway.
    ["X-Stainless-Runtime", "node"],
    ["X-Stainless-Runtime-Version", env("OMNI_ANTHROPIC_STAINLESS_RUNTIME_VERSION", "v26.3.0")],
    ["X-Stainless-Retry-Count", "0"],
    ["Accept", "application/json"],
  ],
  // The operator override is applied here rather than where the table is
  // assembled. An adapter reads this value directly, so a table that applied
  // something the direct read did not would differ only on installations that
  // set the variable — which is the shape of bug this repository keeps finding.
  order: envOrder("OMNI_ORDER_ANTHROPIC", [
    "Accept",
    "Authorization",
    "Content-Type",
    "User-Agent",
    "X-Stainless-Arch",
    "X-Stainless-Lang",
    "X-Stainless-OS",
    "X-Stainless-Package-Version",
    "X-Stainless-Retry-Count",
    "X-Stainless-Runtime",
    "X-Stainless-Runtime-Version",
    "X-Stainless-Timeout",
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "anthropic-version",
    "x-api-key",
    "x-app",
    "Connection",
    "Host",
    "Accept-Encoding",
    "Content-Length",
  ]),
};

export const anthropicBodyOrder: readonly string[] = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "metadata",
  "max_tokens",
  "temperature",
  "thinking",
  "context_management",
  "output_config",
  "stream",
];
