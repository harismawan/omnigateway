//! The canonical request, mirroring `packages/ir/src/request.ts`.
//!
//! Each TS discriminated union is an internally tagged enum on the same
//! discriminant (`type`, `kind` or `mode`) with the same spellings, so a
//! `ChatRequest` serialized by TS deserializes here unchanged. Fields the TS
//! types carry as `unknown` or `Record<string, unknown>` stay
//! [`serde_json::Value`] / [`serde_json::Map`]: the gateway forwards them
//! verbatim and must not narrow what a client may put there.

use serde::Deserialize;
use serde_json::{Map, Value};

/// Which provider serves a request. A string, as in TS: plugin providers have
/// ids no closed enum could contain.
pub type ProviderId = String;

/// The 1M-context beta (`packages/ir/src/betas.ts`).
pub const CONTEXT_1M_BETA: &str = "context-1m-2025-08-07";

/// A caller-placed cache breakpoint. `type` is always `ephemeral`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CacheControl {
    #[serde(rename = "type")]
    pub kind: CacheControlType,
    #[serde(default)]
    pub ttl: Option<CacheTtl>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheControlType {
    Ephemeral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum CacheTtl {
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "1h")]
    OneHour,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub text: String,
    #[serde(default)]
    pub cache_control: Option<CacheControl>,
    /// Anthropic citation payloads, preserved verbatim when present.
    #[serde(default)]
    pub citations: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBlock {
    pub media_type: String,
    pub data: String,
    #[serde(default)]
    pub cache_control: Option<CacheControl>,
}

/// A base64 file carried inside a tool result.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBlock {
    pub media_type: String,
    pub data: String,
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ThinkingBlock {
    pub text: String,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseBlock {
    pub id: String,
    pub name: String,
    pub input: Value,
    #[serde(default)]
    pub cache_control: Option<CacheControl>,
}

/// `content` is flattened text; `images`, `files` and `native` are kept apart.
///
/// The three lists are `Option` and not defaulted to empty, because encoders
/// branch on *presence*: `images: []` still records `custom:images-dropped`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultBlock {
    pub tool_use_id: String,
    pub content: String,
    #[serde(default)]
    pub images: Option<Vec<ImageBlock>>,
    #[serde(default)]
    pub files: Option<Vec<FileBlock>>,
    #[serde(default)]
    pub native: Option<Vec<ProviderNativeBlock>>,
    #[serde(default)]
    pub is_error: Option<bool>,
    #[serde(default)]
    pub cache_control: Option<CacheControl>,
}

/// A content block one provider owns end to end, carried through unread.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderNativeBlock {
    pub provider: ProviderId,
    pub block_type: String,
    pub data: Map<String, Value>,
    #[serde(default)]
    pub cache_control: Option<CacheControl>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text(TextBlock),
    Image(ImageBlock),
    Thinking(ThinkingBlock),
    ToolUse(ToolUseBlock),
    ToolResult(ToolResultBlock),
    ProviderNative(ProviderNativeBlock),
}

impl ContentBlock {
    /// The TS `type` discriminant, as degradation strings spell it.
    pub fn type_name(&self) -> &'static str {
        match self {
            ContentBlock::Text(_) => "text",
            ContentBlock::Image(_) => "image",
            ContentBlock::Thinking(_) => "thinking",
            ContentBlock::ToolUse(_) => "toolUse",
            ContentBlock::ToolResult(_) => "toolResult",
            ContentBlock::ProviderNative(_) => "providerNative",
        }
    }

    /// `cacheControlOf`: a thinking block cannot carry one.
    pub fn cache_control(&self) -> Option<&CacheControl> {
        match self {
            ContentBlock::Text(b) => b.cache_control.as_ref(),
            ContentBlock::Image(b) => b.cache_control.as_ref(),
            ContentBlock::Thinking(_) => None,
            ContentBlock::ToolUse(b) => b.cache_control.as_ref(),
            ContentBlock::ToolResult(b) => b.cache_control.as_ref(),
            ContentBlock::ProviderNative(b) => b.cache_control.as_ref(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

/// A portable tool every provider can express.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomToolDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub input_schema: Value,
    #[serde(default)]
    pub cache_control: Option<CacheControl>,
    #[serde(default)]
    pub options: Option<Map<String, Value>>,
}

/// A tool whose schema a provider owns. `family` is Anthropic's only.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToolDef {
    pub provider: ProviderId,
    #[serde(rename = "type")]
    pub tool_type: String,
    pub name: String,
    pub wire: Map<String, Value>,
    #[serde(default)]
    pub cache_control: Option<CacheControl>,
    #[serde(default)]
    pub family: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolDef {
    Portable(CustomToolDef),
    Provider(ProviderToolDef),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolChoice {
    Auto,
    Any,
    None,
    Tool { name: String },
}

/// `REASONING_EFFORTS`, the widest published ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ReasoningEffort {
    pub const ALL: [ReasoningEffort; 7] = [
        ReasoningEffort::None,
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::Xhigh,
        ReasoningEffort::Max,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ReasoningEffort::None => "none",
            ReasoningEffort::Minimal => "minimal",
            ReasoningEffort::Low => "low",
            ReasoningEffort::Medium => "medium",
            ReasoningEffort::High => "high",
            ReasoningEffort::Xhigh => "xhigh",
            ReasoningEffort::Max => "max",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningDisplay {
    Summarized,
    Omitted,
    Updates,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ReasoningConfig {
    BetweenTools,
    Adaptive {
        #[serde(default)]
        effort: Option<ReasoningEffort>,
        #[serde(default)]
        display: Option<ReasoningDisplay>,
    },
    #[serde(rename_all = "camelCase")]
    Budget {
        budget_tokens: f64,
    },
    Off,
}

/// The canonical request. Numbers are `f64` because they are JS numbers in
/// TS, and the wire encoders print them with `JSON.stringify` rules.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    #[serde(default)]
    pub system: Option<Vec<ContentBlock>>,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Option<Vec<ToolDef>>,
    #[serde(default)]
    pub tool_choice: Option<ToolChoice>,
    #[serde(default)]
    pub max_tokens: Option<f64>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub stop_sequences: Option<Vec<String>>,
    pub stream: bool,
    #[serde(default)]
    pub reasoning: Option<ReasoningConfig>,
    /// Bags keyed by surface (`openai`, `anthropic`); each value is an object.
    #[serde(default)]
    pub vendor: Option<Map<String, Value>>,
    /// Provider protocol headers only, keyed by provider id.
    #[serde(default)]
    pub provider_headers: Option<Map<String, Value>>,
    #[serde(default)]
    pub betas: Option<Vec<String>>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

impl ChatRequest {
    /// `req.vendor?.[name]`, when it is the object TS types it as.
    pub fn vendor_bag(&self, name: &str) -> Option<&Map<String, Value>> {
        self.vendor.as_ref()?.get(name)?.as_object()
    }

    /// `req.vendor?.[name]`, whatever it holds.
    pub fn vendor_value(&self, name: &str) -> Option<&Value> {
        self.vendor.as_ref()?.get(name)
    }
}
