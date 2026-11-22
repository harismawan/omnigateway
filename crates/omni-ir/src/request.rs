//! The canonical request.
//!
//! Each tagged union is an internally tagged enum on its discriminant
//! (`type`, `kind` or `mode`) with fixed wire spellings; the shape is
//! byte-stable. Fields the wire contract leaves open stay
//! [`serde_json::Value`] / [`serde_json::Map`]: the gateway forwards them
//! verbatim and must not narrow what a client may put there.
//!
//! `Serialize` writes the wire shape with absent fields omitted. Struct
//! keys come out in declaration order; values held as `Value`/`Map` keep
//! their own key order.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Which provider serves a request. A string: plugin providers have
/// ids no closed enum could contain.
pub type ProviderId = String;

/// The 1M-context beta.
pub const CONTEXT_1M_BETA: &str = "context-1m-2025-08-07";

/// A caller-placed cache breakpoint. `type` is always `ephemeral`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct CacheControl {
    #[serde(rename = "type")]
    pub kind: CacheControlType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<CacheTtl>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheControlType {
    Ephemeral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum CacheTtl {
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "1h")]
    OneHour,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
    /// Anthropic citation payloads, preserved verbatim when present.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "deep::ser::opt"
    )]
    pub citations: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBlock {
    pub media_type: String,
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
}

/// A base64 file carried inside a tool result.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBlock {
    pub media_type: String,
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ThinkingBlock {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseBlock {
    pub id: String,
    pub name: String,
    #[serde(serialize_with = "deep::ser::value")]
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
}

/// `content` is flattened text; `images`, `files` and `native` are kept apart.
///
/// The three lists are `Option` and not defaulted to empty, because encoders
/// branch on *presence*: `images: []` still records `custom:images-dropped`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultBlock {
    pub tool_use_id: String,
    pub content: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "tagged::images"
    )]
    pub images: Option<Vec<ImageBlock>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "tagged::files"
    )]
    pub files: Option<Vec<FileBlock>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "tagged::native"
    )]
    pub native: Option<Vec<ProviderNativeBlock>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
}

/// A tool result's `images` / `files` / `native` entries are typed blocks on
/// the wire (`{type: "image", ...}`), so they serialize with that discriminant
/// first. Deserialization ignores the tag, which the list position fixes.
mod tagged {
    use serde::Serialize;
    use serde::ser::{SerializeSeq, Serializer};

    #[derive(Serialize)]
    struct Tagged<'a, T> {
        #[serde(rename = "type")]
        tag: &'static str,
        #[serde(flatten)]
        inner: &'a T,
    }

    fn list<S: Serializer, T: Serialize>(
        tag: &'static str,
        items: &Option<Vec<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        let items = items.as_deref().unwrap_or_default();
        let mut seq = s.serialize_seq(Some(items.len()))?;
        for inner in items {
            seq.serialize_element(&Tagged { tag, inner })?;
        }
        seq.end()
    }

    pub fn images<S: Serializer>(
        v: &Option<Vec<super::ImageBlock>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        list("image", v, s)
    }
    pub fn files<S: Serializer>(
        v: &Option<Vec<super::FileBlock>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        list("file", v, s)
    }
    pub fn native<S: Serializer>(
        v: &Option<Vec<super::ProviderNativeBlock>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        list("providerNative", v, s)
    }
}

/// A content block one provider owns end to end, carried through unread.
#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderNativeBlock {
    pub provider: ProviderId,
    pub block_type: String,
    #[serde(serialize_with = "deep::ser::value")]
    pub data: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
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
    /// The `type` discriminant, as degradation strings spell it.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

/// A portable tool every provider can express.
#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomToolDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(serialize_with = "deep::ser::value")]
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "deep::ser::opt"
    )]
    pub options: Option<Map<String, Value>>,
}

/// A tool whose schema a provider owns. `family` is Anthropic's only.
#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToolDef {
    pub provider: ProviderId,
    #[serde(rename = "type")]
    pub tool_type: String,
    pub name: String,
    #[serde(serialize_with = "deep::ser::value")]
    pub wire: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolDef {
    Portable(CustomToolDef),
    Provider(ProviderToolDef),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolChoice {
    Auto,
    Any,
    None,
    Tool { name: String },
}

/// `REASONING_EFFORTS`, the widest published ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningDisplay {
    Summarized,
    Omitted,
    Updates,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ReasoningConfig {
    BetweenTools,
    Adaptive {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<ReasoningEffort>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display: Option<ReasoningDisplay>,
    },
    #[serde(rename_all = "camelCase")]
    Budget {
        budget_tokens: f64,
    },
    Off,
}

/// The canonical request. Numbers are `f64` because they are JS numbers on
/// the wire, and the wire encoders print them with `JSON.stringify` rules.
#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<Vec<ContentBlock>>,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<ToolChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    pub stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningConfig>,
    /// Bags keyed by surface (`openai`, `anthropic`); each value is an object.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "deep::ser::opt"
    )]
    pub vendor: Option<Map<String, Value>>,
    /// Provider protocol headers only, keyed by provider id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "deep::ser::opt"
    )]
    pub provider_headers: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub betas: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

/// A canonical request imported from JS JSON. The validated projection is
/// suitable for ordinary request policy; wire code can read the original
/// value where a UTF-8-only string or serde number cannot represent it.
pub struct CanonicalRequest {
    pub validated: ChatRequest,
    pub source: crate::jsjson::JsValue,
}

impl CanonicalRequest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let source = crate::jsjson::parse_bounded(text, crate::deep::depth_of(text))
            .map_err(|e| format!("canonical request JSON: {e:?}"))?;
        Self::from_source(source)
    }

    pub fn from_source(source: crate::jsjson::JsValue) -> Result<Self, String> {
        // Deserialize via the usual deep request boundary, not from_value,
        // which cannot safely release nested values after a failed visit.
        let utf8 = crate::deep::Owned(crate::jsjson::to_serde_lossy(&source));
        let json = crate::jsjson::to_string(&utf8);
        let validated = crate::deep::scope_for(&json, || {
            let mut de = serde_json::Deserializer::from_str(&json);
            de.disable_recursion_limit();
            <ChatRequest as serde::Deserialize>::deserialize(serde_stacker::Deserializer::new(
                &mut de,
            ))
        })
        .map_err(|e| e.to_string())?;
        Ok(Self { validated, source })
    }
}

impl ChatRequest {
    /// `req.vendor?.[name]`, when it holds an object.
    pub fn vendor_bag(&self, name: &str) -> Option<&Map<String, Value>> {
        self.vendor.as_ref()?.get(name)?.as_object()
    }

    /// `req.vendor?.[name]`, whatever it holds.
    pub fn vendor_value(&self, name: &str) -> Option<&Value> {
        self.vendor.as_ref()?.get(name)
    }
}

// ------------------------------------------------------------------ deep values
//
// These structs hold client JSON verbatim, which may be nested up to
// `deep::MAX_DEPTH` levels. Their `Clone` and `Drop` go through `deep`, and
// their client-JSON fields serialize through `deep::ser`, so none of the three
// recurses once per level on the caller's stack. `PartialEq` stays derived and
// recursive: it is for tests, and production never compares requests.

use crate::deep;

impl Clone for TextBlock {
    fn clone(&self) -> Self {
        TextBlock {
            text: self.text.clone(),
            cache_control: self.cache_control.clone(),
            citations: self
                .citations
                .as_ref()
                .map(|c| c.iter().map(deep::clone).collect()),
        }
    }
}

impl Drop for TextBlock {
    fn drop(&mut self) {
        if let Some(c) = self.citations.take() {
            deep::drop(Value::Array(c));
        }
    }
}

impl Clone for ToolUseBlock {
    fn clone(&self) -> Self {
        ToolUseBlock {
            id: self.id.clone(),
            name: self.name.clone(),
            input: deep::clone(&self.input),
            cache_control: self.cache_control.clone(),
        }
    }
}

impl Drop for ToolUseBlock {
    fn drop(&mut self) {
        deep::drop_in_place(&mut self.input);
    }
}

impl Clone for ProviderNativeBlock {
    fn clone(&self) -> Self {
        ProviderNativeBlock {
            provider: self.provider.clone(),
            block_type: self.block_type.clone(),
            data: deep::clone_map(&self.data),
            cache_control: self.cache_control.clone(),
        }
    }
}

impl Drop for ProviderNativeBlock {
    fn drop(&mut self) {
        deep::drop_map_in_place(&mut self.data);
    }
}

impl Clone for CustomToolDef {
    fn clone(&self) -> Self {
        CustomToolDef {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: deep::clone(&self.input_schema),
            cache_control: self.cache_control.clone(),
            options: self.options.as_ref().map(deep::clone_map),
        }
    }
}

impl Drop for CustomToolDef {
    fn drop(&mut self) {
        deep::drop_in_place(&mut self.input_schema);
        if let Some(o) = self.options.take() {
            deep::drop_map(o);
        }
    }
}

impl Clone for ProviderToolDef {
    fn clone(&self) -> Self {
        ProviderToolDef {
            provider: self.provider.clone(),
            tool_type: self.tool_type.clone(),
            name: self.name.clone(),
            wire: deep::clone_map(&self.wire),
            cache_control: self.cache_control.clone(),
            family: self.family.clone(),
        }
    }
}

impl Drop for ProviderToolDef {
    fn drop(&mut self) {
        deep::drop_map_in_place(&mut self.wire);
    }
}

impl Clone for ChatRequest {
    fn clone(&self) -> Self {
        ChatRequest {
            model: self.model.clone(),
            system: self.system.clone(),
            messages: self.messages.clone(),
            tools: self.tools.clone(),
            tool_choice: self.tool_choice.clone(),
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            stop_sequences: self.stop_sequences.clone(),
            stream: self.stream,
            reasoning: self.reasoning.clone(),
            vendor: self.vendor.as_ref().map(deep::clone_map),
            provider_headers: self.provider_headers.as_ref().map(deep::clone_map),
            betas: self.betas.clone(),
            conversation_id: self.conversation_id.clone(),
        }
    }
}

impl Drop for ChatRequest {
    fn drop(&mut self) {
        if let Some(v) = self.vendor.take() {
            deep::drop_map(v);
        }
        if let Some(v) = self.provider_headers.take() {
            deep::drop_map(v);
        }
    }
}
