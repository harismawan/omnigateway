import { type ClientProfile, env, envOrder } from "../headers.ts";

/**
 * Codex `rust-v0.163.0`, interactive TUI. Every value below was read off a
 * capture of the real client (`scripts/codex-capture/`), not off source alone;
 * the bump procedure is in that directory's README.
 */
const OPENAI_CLI_VERSION = env("OMNI_OPENAI_CLI_VERSION", "0.163.0");
const OPENAI_UA_PLATFORM = env("OMNI_OPENAI_UA_PLATFORM", "Windows 10.0.26200");
const OPENAI_UA_ARCH = env("OMNI_OPENAI_UA_ARCH", "x86_64");
const OPENAI_UA_TERMINAL = env("OMNI_OPENAI_UA_TERMINAL", "WindowsTerminal");

/**
 * The TUI runs through Codex's in-process app-server, whose `initialize` sets
 * the process originator to the client's name. `codex_cli_rs` is only the
 * library default now, and `codex_exec` is the non-interactive binary.
 *
 * Exported because the OAuth authorize URL names it too: the TUI's login runs
 * in the same process, after `initialize`, so it reads the same value.
 */
export const OPENAI_ORIGINATOR = env("OMNI_OPENAI_ORIGINATOR", "codex-tui");

/**
 * The `sandbox` label Codex's turn metadata carries for this profile's
 * platform (`codex-rs/core/src/sandbox_tags.rs`).
 *
 * Derived from the platform rather than fixed, so an operator who moves the UA
 * to Linux or macOS does not send a Windows sandbox beside it. On Windows it is
 * the elevated sandbox, which is what the TUI's first-run setup recommends and
 * what managed requirements prefer; `none` would mean a user who declined it.
 */
export const OPENAI_SANDBOX = OPENAI_UA_PLATFORM.startsWith("Windows")
  ? "windows_elevated"
  : /^(Mac OS|macOS)/.test(OPENAI_UA_PLATFORM)
    ? "seatbelt"
    : "seccomp";

export const openaiProfile: ClientProfile = {
  headers: [
    [
      "user-agent",
      // The trailing `(codex-tui; 0.163.0)` is the app-server's client suffix:
      // `clientInfo.name; clientInfo.version`, which for the TUI is the
      // originator and the release.
      env(
        "OMNI_UA_OPENAI",
        `${OPENAI_ORIGINATOR}/${OPENAI_CLI_VERSION} (${OPENAI_UA_PLATFORM}; ${OPENAI_UA_ARCH}) ` +
          `${OPENAI_UA_TERMINAL} (${OPENAI_ORIGINATOR}; ${OPENAI_CLI_VERSION})`,
      ),
    ],
    ["originator", OPENAI_ORIGINATOR],
    ["version", OPENAI_CLI_VERSION],
    ["x-codex-beta-features", "remote_compaction_v2"],
    ["accept", "text/event-stream"],
  ],
  // The operator override is applied here rather than where the table is
  // assembled. An adapter reads this value directly, so a table that applied
  // something the direct read did not would differ only on installations that
  // set the variable — which is the shape of bug this repository keeps finding.
  order: envOrder("OMNI_ORDER_OPENAI", [
    "version",
    "x-codex-beta-features",
    // Codec-supplied names stay in the CLI's order rather than appending after
    // `user-agent`, where `orderHeaders` puts names it does not know. The first
    // four are the OAuth leg's alone.
    "x-codex-window-id",
    "x-codex-turn-metadata",
    "x-openai-internal-codex-responses-lite",
    "x-codex-routing-hint",
    "x-client-request-id",
    "session-id",
    "thread-id",
    "accept",
    "content-encoding",
    "content-type",
    "authorization",
    "chatgpt-account-id",
    "originator",
    "user-agent",
    // Last, as hyper writes them on HTTP/1.1. `content-length` is the
    // transport's and always lands after everything a codec sets.
    "host",
    "content-length",
  ]),
};

/**
 * `ResponsesApiRequest`'s declaration order (`codex-rs/codex-api/src/common.rs`),
 * which serde follows. `instructions` is gone from that struct; it stays here,
 * after `input` where 0.159.2 had it, because the API-key leg still sends one.
 */
export const openaiBodyOrder: readonly string[] = [
  "model",
  "stream",
  "service_tier",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream_options",
  "include",
  "prompt_cache_key",
  "text",
  "client_metadata",
  "access_programs",
  "metadata",
];
