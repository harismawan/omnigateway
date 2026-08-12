import type { AnthropicToolFamily } from "@omni/ir";

/**
 * Anthropic's tool definitions, one entry per wire `type`.
 *
 * Keyed by the exact versioned string rather than by family, because the
 * version *is* the contract: `text_editor_20250429` renamed the tool and
 * `text_editor_20250728` added a field its predecessor rejects. A prefix match
 * on `text_editor_` would let the gateway advertise support for a version whose
 * semantics it has never seen, so lookups are exact and an unknown date is a
 * client error rather than a silent forward.
 *
 * Legacy entries are here for wire compatibility with clients that still send
 * them; `README.md` does not recommend them.
 *
 * `required` and `optional` name the family-specific and common fields
 * Anthropic accepts *besides* `type` and `name`. They are transcribed from the
 * Messages API tool union, so a field absent here is one Anthropic itself
 * rejects — which is why ingress refuses unknown keys instead of forwarding
 * them and letting the upstream 400 surface as a gateway fault.
 */
export type AnthropicToolSpec = {
  family: AnthropicToolFamily;
  /**
   * The fixed `name` this version must be declared with. Absent for
   * `mcp_toolset`, the one entry Anthropic gives no name — it configures a
   * server's toolset rather than declaring a single tool.
   */
  name?: string;
  required: readonly string[];
  optional: readonly string[];
};

/** Accepted by every tool that is loadable through tool search. */
const COMMON = ["cache_control", "strict", "defer_loading", "allowed_callers"] as const;

/** The subset that also documents worked examples of its input. */
const COMMON_WITH_EXAMPLES = [...COMMON, "input_examples"] as const;

const searchDomains = ["max_uses", "allowed_domains", "blocked_domains"] as const;

export const ANTHROPIC_TOOL_SPECS: Readonly<Record<string, AnthropicToolSpec>> = {
  web_search_20250305: {
    family: "webSearch",
    name: "web_search",
    required: [],
    optional: [...COMMON, ...searchDomains, "user_location"],
  },
  web_search_20260209: {
    family: "webSearch",
    name: "web_search",
    required: [],
    optional: [...COMMON, ...searchDomains, "user_location"],
  },
  web_search_20260318: {
    family: "webSearch",
    name: "web_search",
    required: [],
    optional: [...COMMON, ...searchDomains, "user_location", "response_inclusion"],
  },

  web_fetch_20250910: {
    family: "webFetch",
    name: "web_fetch",
    required: [],
    optional: [...COMMON, ...searchDomains, "citations", "max_content_tokens"],
  },
  web_fetch_20260209: {
    family: "webFetch",
    name: "web_fetch",
    required: [],
    optional: [...COMMON, ...searchDomains, "citations", "max_content_tokens"],
  },
  web_fetch_20260309: {
    family: "webFetch",
    name: "web_fetch",
    required: [],
    optional: [...COMMON, ...searchDomains, "citations", "max_content_tokens", "use_cache"],
  },
  web_fetch_20260318: {
    family: "webFetch",
    name: "web_fetch",
    required: [],
    optional: [
      ...COMMON,
      ...searchDomains,
      "citations",
      "max_content_tokens",
      "use_cache",
      "response_inclusion",
    ],
  },

  code_execution_20250522: {
    family: "codeExecution",
    name: "code_execution",
    required: [],
    optional: [...COMMON],
  },
  code_execution_20250825: {
    family: "codeExecution",
    name: "code_execution",
    required: [],
    optional: [...COMMON],
  },
  code_execution_20260120: {
    family: "codeExecution",
    name: "code_execution",
    required: [],
    optional: [...COMMON],
  },
  code_execution_20260521: {
    family: "codeExecution",
    name: "code_execution",
    required: [],
    optional: [...COMMON],
  },

  bash_20241022: {
    family: "bash",
    name: "bash",
    required: [],
    optional: [...COMMON_WITH_EXAMPLES],
  },
  bash_20250124: {
    family: "bash",
    name: "bash",
    required: [],
    optional: [...COMMON_WITH_EXAMPLES],
  },

  text_editor_20241022: {
    family: "textEditor",
    name: "str_replace_editor",
    required: [],
    optional: [...COMMON_WITH_EXAMPLES],
  },
  text_editor_20250124: {
    family: "textEditor",
    name: "str_replace_editor",
    required: [],
    optional: [...COMMON_WITH_EXAMPLES],
  },
  text_editor_20250429: {
    family: "textEditor",
    name: "str_replace_based_edit_tool",
    required: [],
    optional: [...COMMON_WITH_EXAMPLES],
  },
  text_editor_20250728: {
    family: "textEditor",
    name: "str_replace_based_edit_tool",
    required: [],
    optional: [...COMMON_WITH_EXAMPLES, "max_characters"],
  },

  computer_20241022: {
    family: "computer",
    name: "computer",
    required: ["display_width_px", "display_height_px"],
    optional: [...COMMON_WITH_EXAMPLES, "display_number"],
  },
  computer_20250124: {
    family: "computer",
    name: "computer",
    required: ["display_width_px", "display_height_px"],
    optional: [...COMMON_WITH_EXAMPLES, "display_number"],
  },
  computer_20251124: {
    family: "computer",
    name: "computer",
    required: ["display_width_px", "display_height_px"],
    optional: [...COMMON_WITH_EXAMPLES, "display_number", "enable_zoom"],
  },

  memory_20250818: {
    family: "memory",
    name: "memory",
    required: [],
    optional: [...COMMON_WITH_EXAMPLES],
  },

  // Both families accept an undated alias as well as the dated form, so the
  // alias is a separate entry rather than a prefix rule.
  tool_search_tool_regex_20251119: {
    family: "toolSearchRegex",
    name: "tool_search_tool_regex",
    required: [],
    optional: [...COMMON],
  },
  tool_search_tool_regex: {
    family: "toolSearchRegex",
    name: "tool_search_tool_regex",
    required: [],
    optional: [...COMMON],
  },
  tool_search_tool_bm25_20251119: {
    family: "toolSearchBm25",
    name: "tool_search_tool_bm25",
    required: [],
    optional: [...COMMON],
  },
  tool_search_tool_bm25: {
    family: "toolSearchBm25",
    name: "tool_search_tool_bm25",
    required: [],
    optional: [...COMMON],
  },

  advisor_20260301: {
    family: "advisor",
    name: "advisor",
    required: ["model"],
    optional: [...COMMON, "caching", "max_uses", "max_tokens"],
  },

  mcp_toolset: {
    family: "mcpToolset",
    required: ["mcp_server_name"],
    optional: ["cache_control", "configs", "default_config"],
  },
};

/** Exact lookup; a dated prefix this gateway has not seen resolves to nothing. */
export function anthropicToolSpec(type: string): AnthropicToolSpec | undefined {
  return Object.hasOwn(ANTHROPIC_TOOL_SPECS, type) ? ANTHROPIC_TOOL_SPECS[type] : undefined;
}

/** Who a tool may be invoked by, when the caller narrows it. */
export const ANTHROPIC_TOOL_CALLERS = [
  "direct",
  "code_execution_20250825",
  "code_execution_20260120",
  "code_execution_20260521",
] as const;

/**
 * Definition options Anthropic accepts on a *custom* tool.
 *
 * These tune how Anthropic loads and validates a tool the caller still owns, so
 * carrying them costs nothing in portability: the other two encoders have no
 * such fields and drop them.
 */
export const ANTHROPIC_CUSTOM_TOOL_OPTIONS = [
  "strict",
  "defer_loading",
  "allowed_callers",
  "input_examples",
  "eager_input_streaming",
] as const;

/**
 * Content blocks Anthropic owns, as they appear at the top level of a message.
 *
 * Nested payload types — `web_search_result` inside a result's `content`, the
 * per-command code-execution results — are deliberately absent: the gateway
 * carries a native block's payload verbatim, so it never has to name what is
 * inside one.
 *
 * `redacted_thinking` is here rather than beside `thinking` because it has no
 * readable text to carry and exists only to be replayed; the canonical thinking
 * block would strip it to an empty string and fail the next turn.
 */
export const ANTHROPIC_NATIVE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "mcp_tool_use",
  "mcp_tool_result",
  "tool_search_tool_result",
  "tool_reference",
  "advisor_tool_result",
  "advisor_result",
  "advisor_redacted_result",
  "container_upload",
  "compaction",
  "search_result",
  "document",
  "mid_conv_system",
  "tool_addition",
  "tool_removal",
  "fallback",
  "redacted_thinking",
]);
