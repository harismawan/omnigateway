//! Canonical stream events and `collect()`, ported from `packages/ir/src/stream.ts`.
//!
//! [`StreamEvent::to_json`] renders the TS object shape with `JSON.stringify`
//! rules, which is what the conformance vectors record and what tests compare.
//!

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::error::ErrorCode;
use crate::jsjson::{self, JsValue};
use crate::request::ProviderId;
use crate::text::Text;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    ToolUse,
    StopSequence,
    ContentFilter,
    PauseTurn,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StopReason::EndTurn => "endTurn",
            StopReason::MaxTokens => "maxTokens",
            StopReason::ToolUse => "toolUse",
            StopReason::StopSequence => "stopSequence",
            StopReason::ContentFilter => "contentFilter",
            StopReason::PauseTurn => "pauseTurn",
        }
    }
}

/// `input_tokens` is the uncached remainder, never the whole prompt.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Usage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    pub cache_write_5m_tokens: Option<f64>,
    pub cache_write_1h_tokens: Option<f64>,
    /// Non-numeric upstream counts: their numeric projection is kept above
    /// for accounting, but only the original value goes on the client wire.
    pub raw_output_tokens: Option<Box<JsValue>>,
    pub raw_cache_read_tokens: Option<Box<JsValue>>,
}

/// `usageFromPromptTotal`: subtracts the cached overlap, clamped at zero.
pub fn usage_from_prompt_total(
    prompt_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
) -> Usage {
    Usage {
        input_tokens: crate::js::max0(prompt_tokens - cache_read_tokens - cache_write_tokens),
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        ..Usage::default()
    }
}

/// `promptTokens`: the whole prompt.
pub fn prompt_tokens(usage: &Usage) -> f64 {
    usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens
}

impl Usage {
    pub fn client_output(&self) -> JsValue {
        self.raw_output_tokens
            .as_deref()
            .cloned()
            .unwrap_or_else(|| self.output_tokens.into())
    }

    pub fn client_cache_read(&self) -> JsValue {
        self.raw_cache_read_tokens
            .as_deref()
            .cloned()
            .unwrap_or_else(|| self.cache_read_tokens.into())
    }

    pub fn client_prompt(&self) -> JsValue {
        if self.raw_cache_read_tokens.is_none() {
            return prompt_tokens(self).into();
        }
        jsjson::add(&self.input_tokens.into(), &self.client_cache_read())
            .and_then(|subtotal| jsjson::add(&subtotal, &self.cache_write_tokens.into()))
            .unwrap_or(JsValue::Null)
    }

    pub fn client_total(&self, prompt: &JsValue) -> JsValue {
        jsjson::add(prompt, &self.client_output()).unwrap_or(JsValue::Null)
    }
}

#[derive(Debug, PartialEq)]
pub enum ContentBlockStart {
    Text,
    /// `signed: None` is TS's absent field.
    Thinking {
        signed: Option<bool>,
    },
    ToolUse {
        id: Text,
        name: Text,
    },
    ProviderNative {
        provider: ProviderId,
        block_type: String,
        data: JsValue,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeFold {
    Merge,
    Citation,
}

#[derive(Debug, PartialEq)]
pub enum Delta {
    Text {
        text: Text,
    },
    Thinking {
        text: Text,
    },
    ThinkingSignature {
        signature: Text,
    },
    ToolJson {
        partial: Text,
    },
    ProviderNativeJson {
        provider: ProviderId,
        partial: Text,
    },
    ProviderNative {
        provider: ProviderId,
        delta_type: String,
        fold: Option<NativeFold>,
        data: JsValue,
    },
}

#[derive(Debug, PartialEq)]
pub enum StreamEvent {
    Start {
        id: Text,
        model: Text,
    },
    BlockStart {
        index: u32,
        block: ContentBlockStart,
    },
    BlockDelta {
        index: u32,
        delta: Delta,
    },
    BlockEnd {
        index: u32,
    },
    End {
        stop_reason: StopReason,
        usage: Usage,
        vendor: Option<Map<String, Value>>,
    },
    Error {
        code: ErrorCode,
        message: Text,
        retryable: bool,
    },
}

impl StreamEvent {
    /// Arbitrary upstream JSON needs protected intermediate rendering ownership.
    pub fn has_json_payload(&self) -> bool {
        matches!(
            self,
            Self::BlockStart {
                block: ContentBlockStart::ProviderNative { .. },
                ..
            } | Self::BlockDelta {
                delta: Delta::ProviderNative { .. },
                ..
            } | Self::End {
                vendor: Some(_),
                ..
            }
        )
    }
    /// The TS object, as `JSON.stringify` would write it.
    pub fn to_json(&self) -> String {
        jsjson::render(&self.to_value())
    }

    /// The TS object as a JSON value, keys in TS insertion order.
    pub fn to_value(&self) -> JsValue {
        match self {
            StreamEvent::Start { id, model } => JsValue::object([
                ("type", "start".into()),
                ("id", id.into()),
                ("model", model.into()),
            ]),
            StreamEvent::BlockStart { index, block } => JsValue::object([
                ("type", "blockStart".into()),
                ("index", f64::from(*index).into()),
                ("block", block_start_value(block)),
            ]),
            StreamEvent::BlockDelta { index, delta } => JsValue::object([
                ("type", "blockDelta".into()),
                ("index", f64::from(*index).into()),
                ("delta", delta_value(delta)),
            ]),
            StreamEvent::BlockEnd { index } => JsValue::object([
                ("type", "blockEnd".into()),
                ("index", f64::from(*index).into()),
            ]),
            StreamEvent::End {
                stop_reason,
                usage,
                vendor,
            } => JsValue::object([
                ("type", "end".into()),
                ("stopReason", stop_reason.as_str().into()),
                ("usage", usage_value(usage)),
                (
                    "vendor",
                    vendor
                        .as_ref()
                        .map_or(JsValue::Undefined, jsjson::object_from_serde),
                ),
            ]),
            StreamEvent::Error {
                code,
                message,
                retryable,
            } => JsValue::object([
                ("type", "error".into()),
                ("code", code.as_str().into()),
                ("message", message.into()),
                ("retryable", JsValue::Bool(*retryable)),
            ]),
        }
    }
}

impl Clone for ContentBlockStart {
    fn clone(&self) -> Self {
        match self {
            Self::Text => Self::Text,
            Self::Thinking { signed } => Self::Thinking { signed: *signed },
            Self::ToolUse { id, name } => Self::ToolUse {
                id: id.clone(),
                name: name.clone(),
            },
            Self::ProviderNative {
                provider,
                block_type,
                data,
            } => Self::ProviderNative {
                provider: provider.clone(),
                block_type: block_type.clone(),
                data: data.clone(),
            },
        }
    }
}
impl Clone for Delta {
    fn clone(&self) -> Self {
        match self {
            Self::Text { text } => Self::Text { text: text.clone() },
            Self::Thinking { text } => Self::Thinking { text: text.clone() },
            Self::ThinkingSignature { signature } => Self::ThinkingSignature {
                signature: signature.clone(),
            },
            Self::ToolJson { partial } => Self::ToolJson {
                partial: partial.clone(),
            },
            Self::ProviderNativeJson { provider, partial } => Self::ProviderNativeJson {
                provider: provider.clone(),
                partial: partial.clone(),
            },
            Self::ProviderNative {
                provider,
                delta_type,
                fold,
                data,
            } => Self::ProviderNative {
                provider: provider.clone(),
                delta_type: delta_type.clone(),
                fold: *fold,
                data: data.clone(),
            },
        }
    }
}
impl Drop for StreamEvent {
    fn drop(&mut self) {
        if let Self::End {
            vendor: Some(data), ..
        } = self
        {
            crate::deep::drop_map_in_place(data);
        }
    }
}
impl Clone for StreamEvent {
    fn clone(&self) -> Self {
        match self {
            Self::Start { id, model } => Self::Start {
                id: id.clone(),
                model: model.clone(),
            },
            Self::BlockStart { index, block } => Self::BlockStart {
                index: *index,
                block: block.clone(),
            },
            Self::BlockDelta { index, delta } => Self::BlockDelta {
                index: *index,
                delta: delta.clone(),
            },
            Self::BlockEnd { index } => Self::BlockEnd { index: *index },
            Self::End {
                stop_reason,
                usage,
                vendor,
            } => Self::End {
                stop_reason: *stop_reason,
                usage: usage.clone(),
                vendor: vendor.as_ref().map(crate::deep::clone_map),
            },
            Self::Error {
                code,
                message,
                retryable,
            } => Self::Error {
                code: *code,
                message: message.clone(),
                retryable: *retryable,
            },
        }
    }
}

/// A JS number as a JSON value; non-finite becomes `null`, as `JSON.stringify`.
pub fn number(v: f64) -> Value {
    serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
}

pub fn usage_value(u: &Usage) -> JsValue {
    JsValue::object([
        ("inputTokens", u.input_tokens.into()),
        ("outputTokens", u.client_output()),
        ("cacheReadTokens", u.client_cache_read()),
        ("cacheWriteTokens", u.cache_write_tokens.into()),
        (
            "cacheWrite5mTokens",
            u.cache_write_5m_tokens
                .map_or(JsValue::Undefined, JsValue::Number),
        ),
        (
            "cacheWrite1hTokens",
            u.cache_write_1h_tokens
                .map_or(JsValue::Undefined, JsValue::Number),
        ),
    ])
}

fn block_start_value(b: &ContentBlockStart) -> JsValue {
    match b {
        ContentBlockStart::Text => JsValue::object([("type", "text".into())]),
        ContentBlockStart::Thinking { signed } => JsValue::object([
            ("type", "thinking".into()),
            ("signed", signed.map_or(JsValue::Undefined, JsValue::Bool)),
        ]),
        ContentBlockStart::ToolUse { id, name } => JsValue::object([
            ("type", "toolUse".into()),
            ("id", id.into()),
            ("name", name.into()),
        ]),
        ContentBlockStart::ProviderNative {
            provider,
            block_type,
            data,
        } => JsValue::object([
            ("type", "providerNative".into()),
            ("provider", provider.as_str().into()),
            ("blockType", block_type.as_str().into()),
            ("data", data.clone()),
        ]),
    }
}

fn delta_value(d: &Delta) -> JsValue {
    match d {
        Delta::Text { text } => JsValue::object([("type", "text".into()), ("text", text.into())]),
        Delta::Thinking { text } => {
            JsValue::object([("type", "thinking".into()), ("text", text.into())])
        }
        Delta::ThinkingSignature { signature } => JsValue::object([
            ("type", "thinkingSignature".into()),
            ("signature", signature.into()),
        ]),
        Delta::ToolJson { partial } => {
            JsValue::object([("type", "toolJson".into()), ("partial", partial.into())])
        }
        Delta::ProviderNativeJson { provider, partial } => JsValue::object([
            ("type", "providerNativeJson".into()),
            ("provider", provider.as_str().into()),
            ("partial", partial.into()),
        ]),
        Delta::ProviderNative {
            provider,
            delta_type,
            fold,
            data,
        } => JsValue::object([
            ("type", "providerNative".into()),
            ("provider", provider.as_str().into()),
            ("deltaType", delta_type.as_str().into()),
            (
                "fold",
                match fold {
                    Some(NativeFold::Merge) => "merge".into(),
                    Some(NativeFold::Citation) => "citation".into(),
                    None => JsValue::Undefined,
                },
            ),
            ("data", data.clone()),
        ]),
    }
}

/// `CollectedResponse`.
#[derive(Debug, PartialEq)]
pub struct CollectedResponse {
    pub id: Text,
    pub model: Text,
    pub content: Vec<CollectedBlock>,
    pub stop_reason: StopReason,
    pub usage: Usage,
    pub vendor: Option<Map<String, Value>>,
}
impl Drop for CollectedResponse {
    fn drop(&mut self) {
        if let Some(v) = self.vendor.take() {
            crate::deep::drop_map(v);
        }
    }
}
impl Clone for CollectedResponse {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            model: self.model.clone(),
            content: self.content.clone(),
            stop_reason: self.stop_reason,
            usage: self.usage.clone(),
            vendor: self.vendor.as_ref().map(crate::deep::clone_map),
        }
    }
}

/// Assistant blocks collected from upstream, before the client dialect renders them.
#[derive(Debug, Clone, PartialEq)]
pub enum CollectedBlock {
    Text {
        text: Text,
        citations: Vec<JsValue>,
    },
    Thinking {
        text: Text,
        signature: Option<Text>,
    },
    ToolUse {
        id: Text,
        name: Text,
        input: JsValue,
    },
    ProviderNative {
        provider: ProviderId,
        block_type: String,
        data: JsValue,
    },
}

enum Accum {
    Text {
        text: Text,
        citations: Vec<JsValue>,
    },
    Thinking {
        text: Text,
        signature: Option<Text>,
    },
    ToolUse {
        id: Text,
        name: Text,
        json: Text,
    },
    ProviderNative {
        provider: ProviderId,
        block_type: String,
        data: JsValue,
        json: Text,
        merges: Vec<JsValue>,
    },
}

/// Folds a canonical event stream into one response (`collect` in TS).
pub fn collect(events: impl IntoIterator<Item = StreamEvent>) -> CollectedResponse {
    try_collect(events).expect(
        "collect input must satisfy the JSON depth policy; use try_collect for upstream input",
    )
}

/// Fallible collection for untrusted upstream tool argument fragments.
pub fn try_collect(
    events: impl IntoIterator<Item = StreamEvent>,
) -> Result<CollectedResponse, crate::error::GatewayError> {
    let mut depth_error = false;
    let mut id = Text::default();
    let mut model = Text::default();
    let mut stop_reason = StopReason::EndTurn;
    let mut vendor = None;
    let mut usage = Usage::default();
    let mut blocks: BTreeMap<u32, Accum> = BTreeMap::new();

    for mut ev in events {
        match &mut ev {
            StreamEvent::Start { id: i, model: m } => {
                id = std::mem::take(i);
                model = std::mem::take(m);
            }
            StreamEvent::BlockStart { index, block } => {
                let acc = match block {
                    ContentBlockStart::ToolUse { id, name } => Accum::ToolUse {
                        id: std::mem::take(id),
                        name: std::mem::take(name),
                        json: Text::default(),
                    },
                    ContentBlockStart::Thinking { .. } => Accum::Thinking {
                        text: Text::default(),
                        signature: None,
                    },
                    ContentBlockStart::ProviderNative {
                        provider,
                        block_type,
                        data,
                    } => Accum::ProviderNative {
                        provider: std::mem::take(provider),
                        block_type: std::mem::take(block_type),
                        data: std::mem::replace(data, JsValue::Null),
                        json: Text::default(),
                        merges: Vec::new(),
                    },
                    ContentBlockStart::Text => Accum::Text {
                        text: Text::default(),
                        citations: Vec::new(),
                    },
                };
                blocks.insert(*index, acc);
            }
            StreamEvent::BlockDelta { index, delta } => {
                let Some(acc) = blocks.get_mut(index) else {
                    continue;
                };
                match (delta, acc) {
                    (Delta::Text { text }, Accum::Text { text: t, .. })
                    | (Delta::Thinking { text }, Accum::Thinking { text: t, .. }) => {
                        t.push(text);
                    }
                    // Concatenated: a signature may arrive in fragments.
                    (
                        Delta::ThinkingSignature { signature },
                        Accum::Thinking { signature: s, .. },
                    ) => {
                        s.get_or_insert_with(Text::default).push(signature);
                    }
                    (Delta::ToolJson { partial }, Accum::ToolUse { json, .. })
                    | (
                        Delta::ProviderNativeJson { partial, .. },
                        Accum::ProviderNative { json, .. },
                    ) => {
                        json.push(partial);
                    }
                    (
                        Delta::ProviderNative {
                            fold: Some(NativeFold::Merge),
                            data,
                            ..
                        },
                        Accum::ProviderNative { merges, .. },
                    ) => merges.push(std::mem::replace(data, JsValue::Null)),
                    (
                        Delta::ProviderNative {
                            fold: Some(NativeFold::Citation),
                            data,
                            ..
                        },
                        Accum::Text { citations, .. },
                    ) => {
                        // `data.citation`, which is `undefined` when absent.
                        citations.push(data.get("citation").cloned().unwrap_or(JsValue::Null));
                    }
                    _ => {}
                }
            }
            StreamEvent::End {
                stop_reason: s,
                usage: u,
                vendor: v,
            } => {
                stop_reason = *s;
                usage = std::mem::take(u);
                if let Some(old) = vendor.take() {
                    crate::deep::drop_map(old);
                }
                vendor = v.take();
            }
            StreamEvent::BlockEnd { .. } | StreamEvent::Error { .. } => {}
        }
    }

    let content = blocks
        .into_values()
        .map(|acc| match acc {
            Accum::Text { text, citations } => CollectedBlock::Text { text, citations },
            Accum::Thinking { text, signature } => CollectedBlock::Thinking { text, signature },
            Accum::ToolUse { id, name, json } => CollectedBlock::ToolUse {
                id,
                name,
                input: parse_tool_json(&json, &mut depth_error),
            },
            Accum::ProviderNative {
                provider,
                block_type,
                mut data,
                json,
                merges,
            } => {
                if !json.is_empty() {
                    data.put(
                        "input".encode_utf16().collect(),
                        parse_tool_json(&json, &mut depth_error),
                    );
                }
                for merge in merges {
                    data.extend_object(merge);
                }
                CollectedBlock::ProviderNative {
                    provider,
                    block_type,
                    data,
                }
            }
        })
        .collect();

    let response = CollectedResponse {
        id,
        model,
        content,
        stop_reason,
        usage,
        vendor,
    };
    if depth_error {
        return Err(crate::error::GatewayError::new(
            ErrorCode::Upstream,
            "tool arguments exceed JSON depth 40000",
        ));
    }
    Ok(response)
}

/// Tool arguments arrive in fragments; a truncated stream must not throw.
fn parse_tool_json(raw: &Text, depth_error: &mut bool) -> JsValue {
    raw.with_json_source(|source| {
        match jsjson::parse_bounded(source, crate::deep::depth_of(source)) {
            Ok(value) => value,
            Err(crate::deep::ParseError::TooDeep) => {
                *depth_error = true;
                JsValue::Object(Vec::new())
            }
            Err(crate::deep::ParseError::Syntax) => JsValue::Object(Vec::new()),
        }
    })
}
