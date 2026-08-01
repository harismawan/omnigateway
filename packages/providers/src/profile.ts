import type { ProviderId } from "@omni/ir";
import type { HeaderPair } from "./types.ts";

export type ClientProfile = {
  /** Headers with the CLI's own name casing, in declaration order. */
  readonly headers: readonly HeaderPair[];
  /** Canonical wire order. Matched case-insensitively; unlisted names append. */
  readonly order: readonly string[];
};

/** Rejects anything that cannot go in a header value. */
const SAFE = /^[\x20-\x7E]{1,200}$/;

function env(name: string, fallback: string): string {
  const raw = Bun.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  return SAFE.test(raw) ? raw : fallback;
}

/** Blank means "derive from host", so this distinguishes unset from set. */
function envOrNull(name: string): string | null {
  const raw = Bun.env[name];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return SAFE.test(raw) ? raw : null;
}

function envOrder(name: string, fallback: readonly string[]): readonly string[] {
  const raw = Bun.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && SAFE.test(s));
  return parts.length > 0 ? parts : fallback;
}

/** Stainless spells the platform differently from node:process. */
export function stainlessHost(platform: string, arch: string): { os: string; arch: string } {
  const os =
    platform === "darwin"
      ? "MacOS"
      : platform === "linux"
        ? "Linux"
        : platform === "win32"
          ? "Windows"
          : "Unknown";
  return { os, arch };
}

/**
 * Reorders headers to a canonical wire order.
 *
 * Names are matched case-insensitively but emitted with the casing they were
 * given, because the casing is itself part of the fingerprint. Names not in
 * `order` are appended in their original relative order.
 */
export function orderHeaders(pairs: readonly HeaderPair[], order: readonly string[]): HeaderPair[] {
  const remaining = [...pairs];
  const out: HeaderPair[] = [];
  for (const name of order) {
    const lower = name.toLowerCase();
    const at = remaining.findIndex(([n]) => n.toLowerCase() === lower);
    if (at !== -1) out.push(...remaining.splice(at, 1));
  }
  out.push(...remaining);
  return out;
}

/**
 * Overlays headers onto a base set.
 *
 * A replaced header keeps the base's position but takes the override's value
 * and casing. New headers append. Position is preserved because reordering
 * happens later, against the profile's `order`, and a header that arrived
 * out of band should not jump the queue on its own.
 */
export function mergeHeaders(
  base: readonly HeaderPair[],
  overrides: readonly HeaderPair[],
): HeaderPair[] {
  const out: HeaderPair[] = [...base];
  for (const [name, value] of overrides) {
    const lower = name.toLowerCase();
    const at = out.findIndex(([n]) => n.toLowerCase() === lower);
    if (at === -1) out.push([name, value]);
    else out[at] = [name, value];
  }
  return out;
}

const host = stainlessHost(process.platform, process.arch);

const ANTHROPIC_CLI_VERSION = env("OMNI_ANTHROPIC_CLI_VERSION", "2.1.219");

const anthropic: ClientProfile = {
  headers: [
    ["User-Agent", env("OMNI_UA_ANTHROPIC", `claude-cli/${ANTHROPIC_CLI_VERSION} (external, cli)`)],
    ["x-app", "cli"],
    ["anthropic-dangerous-direct-browser-access", "true"],
    ["X-Stainless-Lang", "js"],
    ["X-Stainless-Package-Version", env("OMNI_ANTHROPIC_STAINLESS_PACKAGE_VERSION", "0.94.0")],
    ["X-Stainless-OS", envOrNull("OMNI_ANTHROPIC_STAINLESS_OS") ?? host.os],
    ["X-Stainless-Arch", envOrNull("OMNI_ANTHROPIC_STAINLESS_ARCH") ?? host.arch],
    // Forced to node: this is what the real CLI reports, and reporting "bun"
    // would be a one-header giveaway.
    ["X-Stainless-Runtime", "node"],
    ["X-Stainless-Runtime-Version", env("OMNI_ANTHROPIC_STAINLESS_RUNTIME_VERSION", "v26.3.0")],
    ["X-Stainless-Retry-Count", "0"],
    ["Accept", "application/json"],
  ],
  order: [
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
  ],
};

const OPENAI_CLI_VERSION = env("OMNI_OPENAI_CLI_VERSION", "0.144.1");
const OPENAI_UA_PLATFORM = env("OMNI_OPENAI_UA_PLATFORM", "Windows 10.0.26200");
const OPENAI_UA_ARCH = env("OMNI_OPENAI_UA_ARCH", "x64");

const openai: ClientProfile = {
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
  order: [
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
  ],
};

const KIMI_CLI_VERSION = env("OMNI_KIMI_CLI_VERSION", "0.26.0");

// No traffic capture exists for kimi-code-cli. This order is constructed to be
// plausible, not verified. Treat it as a weaker guarantee than the other two.
const kimi: ClientProfile = {
  headers: [
    ["User-Agent", env("OMNI_UA_KIMI", `kimi-code-cli/${KIMI_CLI_VERSION}`)],
    ["X-Msh-Platform", "kimi_code_cli"],
    ["X-Msh-Version", KIMI_CLI_VERSION],
    ["Accept", "application/json"],
  ],
  order: [
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
  ],
};

export const PROFILES: Readonly<Record<ProviderId, ClientProfile>> = {
  anthropic: { ...anthropic, order: envOrder("OMNI_ORDER_ANTHROPIC", anthropic.order) },
  openai: { ...openai, order: envOrder("OMNI_ORDER_OPENAI", openai.order) },
  kimi: { ...kimi, order: envOrder("OMNI_ORDER_KIMI", kimi.order) },
};
