//! Canonical stream events and `collect()`, mirroring `packages/ir/src/stream.ts`.
//!
//! [`StreamEvent::to_json`] renders the TS object shape with `JSON.stringify`
//! rules, which is what the conformance vectors record and what tests compare.
//!
//! # Known differences from TS
//!
//! - [`Usage`] counts are always `f64`: a non-numeric upstream count is
//!   `Number()`-coerced (NaN renders `null`) where TS would carry the raw
//!   value through.
//! - Text with a lone surrogate holds U+FFFD instead (see [`crate::js`]).
//! - Retry-After loose JS date forms are not parsed (see [`crate::js`]).

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::error::ErrorCode;
use crate::jsjson;
use crate::request::{
    ContentBlock, ProviderId, ProviderNativeBlock, TextBlock, ThinkingBlock, ToolUseBlock,
};

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

/// Token counts use `f64`; upstream values are numerically coerced as documented
/// in the module's compatibility exception, rather than retaining string counts.
///
/// `input_tokens` is the uncached remainder, never the whole prompt.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Usage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    pub cache_write_5m_tokens: Option<f64>,
    pub cache_write_1h_tokens: Option<f64>,
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
        cache_write_5m_tokens: None,
        cache_write_1h_tokens: None,
    }
}

/// `promptTokens`: the whole prompt.
pub fn prompt_tokens(usage: &Usage) -> f64 {
    usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens
}

#[derive(Debug, PartialEq)]
pub enum ContentBlockStart {
    Text,
    /// `signed: None` is TS's absent field.
    Thinking {
        signed: Option<bool>,
    },
    ToolUse {
        id: String,
        name: String,
    },
    ProviderNative {
        provider: ProviderId,
        block_type: String,
        data: Map<String, Value>,
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
        text: String,
    },
    Thinking {
        text: String,
    },
    ThinkingSignature {
        signature: String,
    },
    ToolJson {
        partial: String,
    },
    ProviderNativeJson {
        provider: ProviderId,
        partial: String,
    },
    ProviderNative {
        provider: ProviderId,
        delta_type: String,
        fold: Option<NativeFold>,
        data: Map<String, Value>,
    },
}

#[derive(Debug, PartialEq)]
pub enum StreamEvent {
    Start {
        id: String,
        model: String,
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
        message: String,
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
        jsjson::to_string(&crate::deep::Owned(self.to_value()).0)
    }

    /// The TS object as a JSON value, keys in TS insertion order.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        let s = |v: &str| Value::String(v.to_string());
        match self {
            StreamEvent::Start { id, model } => {
                crate::deep::insert(&mut m, "type".into(), s("start"));
                crate::deep::insert(&mut m, "id".into(), s(id));
                crate::deep::insert(&mut m, "model".into(), s(model));
            }
            StreamEvent::BlockStart { index, block } => {
                crate::deep::insert(&mut m, "type".into(), s("blockStart"));
                crate::deep::insert(&mut m, "index".into(), Value::from(*index));
                crate::deep::insert(&mut m, "block".into(), block_start_value(block));
            }
            StreamEvent::BlockDelta { index, delta } => {
                crate::deep::insert(&mut m, "type".into(), s("blockDelta"));
                crate::deep::insert(&mut m, "index".into(), Value::from(*index));
                crate::deep::insert(&mut m, "delta".into(), delta_value(delta));
            }
            StreamEvent::BlockEnd { index } => {
                crate::deep::insert(&mut m, "type".into(), s("blockEnd"));
                crate::deep::insert(&mut m, "index".into(), Value::from(*index));
            }
            StreamEvent::End {
                stop_reason,
                usage,
                vendor,
            } => {
                crate::deep::insert(&mut m, "type".into(), s("end"));
                crate::deep::insert(&mut m, "stopReason".into(), s(stop_reason.as_str()));
                crate::deep::insert(&mut m, "usage".into(), usage_value(usage));
                if let Some(v) = vendor {
                    crate::deep::insert(
                        &mut m,
                        "vendor".into(),
                        Value::Object(crate::deep::clone_map(v)),
                    );
                }
            }
            StreamEvent::Error {
                code,
                message,
                retryable,
            } => {
                crate::deep::insert(&mut m, "type".into(), s("error"));
                crate::deep::insert(&mut m, "code".into(), s(code.as_str()));
                crate::deep::insert(&mut m, "message".into(), s(message));
                crate::deep::insert(&mut m, "retryable".into(), Value::Bool(*retryable));
            }
        }
        Value::Object(m)
    }
}

impl Drop for ContentBlockStart {
    fn drop(&mut self) {
        if let Self::ProviderNative { data, .. } = self {
            crate::deep::drop_map_in_place(data);
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
                data: crate::deep::clone_map(data),
            },
        }
    }
}
impl Drop for Delta {
    fn drop(&mut self) {
        if let Self::ProviderNative { data, .. } = self {
            crate::deep::drop_map_in_place(data);
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
                data: crate::deep::clone_map(data),
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
                usage: *usage,
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

pub fn usage_value(u: &Usage) -> Value {
    let mut m = Map::new();
    crate::deep::insert(&mut m, "inputTokens".into(), number(u.input_tokens));
    crate::deep::insert(&mut m, "outputTokens".into(), number(u.output_tokens));
    crate::deep::insert(
        &mut m,
        "cacheReadTokens".into(),
        number(u.cache_read_tokens),
    );
    crate::deep::insert(
        &mut m,
        "cacheWriteTokens".into(),
        number(u.cache_write_tokens),
    );
    if let Some(v) = u.cache_write_5m_tokens {
        crate::deep::insert(&mut m, "cacheWrite5mTokens".into(), number(v));
    }
    if let Some(v) = u.cache_write_1h_tokens {
        crate::deep::insert(&mut m, "cacheWrite1hTokens".into(), number(v));
    }
    Value::Object(m)
}

fn block_start_value(b: &ContentBlockStart) -> Value {
    let mut m = Map::new();
    match b {
        ContentBlockStart::Text => {
            crate::deep::insert(&mut m, "type".into(), "text".into());
        }
        ContentBlockStart::Thinking { signed } => {
            crate::deep::insert(&mut m, "type".into(), "thinking".into());
            if let Some(signed) = signed {
                crate::deep::insert(&mut m, "signed".into(), Value::Bool(*signed));
            }
        }
        ContentBlockStart::ToolUse { id, name } => {
            crate::deep::insert(&mut m, "type".into(), "toolUse".into());
            crate::deep::insert(&mut m, "id".into(), id.as_str().into());
            crate::deep::insert(&mut m, "name".into(), name.as_str().into());
        }
        ContentBlockStart::ProviderNative {
            provider,
            block_type,
            data,
        } => {
            crate::deep::insert(&mut m, "type".into(), "providerNative".into());
            crate::deep::insert(&mut m, "provider".into(), provider.as_str().into());
            crate::deep::insert(&mut m, "blockType".into(), block_type.as_str().into());
            crate::deep::insert(
                &mut m,
                "data".into(),
                Value::Object(crate::deep::clone_map(data)),
            );
        }
    }
    Value::Object(m)
}

fn delta_value(d: &Delta) -> Value {
    let mut m = Map::new();
    match d {
        Delta::Text { text } => {
            crate::deep::insert(&mut m, "type".into(), "text".into());
            crate::deep::insert(&mut m, "text".into(), text.as_str().into());
        }
        Delta::Thinking { text } => {
            crate::deep::insert(&mut m, "type".into(), "thinking".into());
            crate::deep::insert(&mut m, "text".into(), text.as_str().into());
        }
        Delta::ThinkingSignature { signature } => {
            crate::deep::insert(&mut m, "type".into(), "thinkingSignature".into());
            crate::deep::insert(&mut m, "signature".into(), signature.as_str().into());
        }
        Delta::ToolJson { partial } => {
            crate::deep::insert(&mut m, "type".into(), "toolJson".into());
            crate::deep::insert(&mut m, "partial".into(), partial.as_str().into());
        }
        Delta::ProviderNativeJson { provider, partial } => {
            crate::deep::insert(&mut m, "type".into(), "providerNativeJson".into());
            crate::deep::insert(&mut m, "provider".into(), provider.as_str().into());
            crate::deep::insert(&mut m, "partial".into(), partial.as_str().into());
        }
        Delta::ProviderNative {
            provider,
            delta_type,
            fold,
            data,
        } => {
            crate::deep::insert(&mut m, "type".into(), "providerNative".into());
            crate::deep::insert(&mut m, "provider".into(), provider.as_str().into());
            crate::deep::insert(&mut m, "deltaType".into(), delta_type.as_str().into());
            if let Some(fold) = fold {
                let f = match fold {
                    NativeFold::Merge => "merge",
                    NativeFold::Citation => "citation",
                };
                crate::deep::insert(&mut m, "fold".into(), f.into());
            }
            crate::deep::insert(
                &mut m,
                "data".into(),
                Value::Object(crate::deep::clone_map(data)),
            );
        }
    }
    Value::Object(m)
}

/// `CollectedResponse`.
#[derive(Debug, PartialEq)]
pub struct CollectedResponse {
    pub id: String,
    pub model: String,
    pub content: Vec<ContentBlock>,
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
            usage: self.usage,
            vendor: self.vendor.as_ref().map(crate::deep::clone_map),
        }
    }
}

enum Accum {
    Text {
        text: String,
        citations: Vec<Value>,
    },
    Thinking {
        text: String,
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        json: String,
    },
    ProviderNative {
        provider: ProviderId,
        block_type: String,
        data: Map<String, Value>,
        json: String,
        merges: Vec<Map<String, Value>>,
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
    let mut id = String::new();
    let mut model = String::new();
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
                        json: String::new(),
                    },
                    ContentBlockStart::Thinking { .. } => Accum::Thinking {
                        text: String::new(),
                        signature: None,
                    },
                    ContentBlockStart::ProviderNative {
                        provider,
                        block_type,
                        data,
                    } => Accum::ProviderNative {
                        provider: std::mem::take(provider),
                        block_type: std::mem::take(block_type),
                        data: std::mem::take(data),
                        json: String::new(),
                        merges: Vec::new(),
                    },
                    ContentBlockStart::Text => Accum::Text {
                        text: String::new(),
                        citations: Vec::new(),
                    },
                };
                if let Some(old) = blocks.insert(*index, acc) {
                    match old {
                        Accum::Text { citations, .. } => {
                            for v in citations {
                                crate::deep::drop(v);
                            }
                        }
                        Accum::ProviderNative { data, merges, .. } => {
                            crate::deep::drop_map(data);
                            for v in merges {
                                crate::deep::drop_map(v);
                            }
                        }
                        _ => {}
                    }
                }
            }
            StreamEvent::BlockDelta { index, delta } => {
                let Some(acc) = blocks.get_mut(index) else {
                    continue;
                };
                match (delta, acc) {
                    (Delta::Text { text }, Accum::Text { text: t, .. })
                    | (Delta::Thinking { text }, Accum::Thinking { text: t, .. }) => {
                        t.push_str(text);
                    }
                    // Concatenated: a signature may arrive in fragments.
                    (
                        Delta::ThinkingSignature { signature },
                        Accum::Thinking { signature: s, .. },
                    ) => {
                        s.get_or_insert_with(String::new).push_str(signature);
                    }
                    (Delta::ToolJson { partial }, Accum::ToolUse { json, .. })
                    | (
                        Delta::ProviderNativeJson { partial, .. },
                        Accum::ProviderNative { json, .. },
                    ) => {
                        json.push_str(partial);
                    }
                    (
                        Delta::ProviderNative {
                            fold: Some(NativeFold::Merge),
                            data,
                            ..
                        },
                        Accum::ProviderNative { merges, .. },
                    ) => merges.push(std::mem::take(data)),
                    (
                        Delta::ProviderNative {
                            fold: Some(NativeFold::Citation),
                            data,
                            ..
                        },
                        Accum::Text { citations, .. },
                    ) => {
                        // `data.citation`, which is `undefined` when absent.
                        citations.push(
                            data.get("citation")
                                .map(crate::deep::clone)
                                .unwrap_or(Value::Null),
                        );
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
                usage = *u;
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
            Accum::Text { text, citations } => ContentBlock::Text(TextBlock {
                text,
                cache_control: None,
                citations: (!citations.is_empty()).then_some(citations),
            }),
            Accum::Thinking { text, signature } => {
                ContentBlock::Thinking(ThinkingBlock { text, signature })
            }
            Accum::ToolUse { id, name, json } => ContentBlock::ToolUse(ToolUseBlock {
                id,
                name,
                input: parse_tool_json(&json, &mut depth_error),
                cache_control: None,
            }),
            Accum::ProviderNative {
                provider,
                block_type,
                mut data,
                json,
                merges,
            } => {
                if !json.is_empty() {
                    crate::deep::insert(
                        &mut data,
                        "input".into(),
                        parse_tool_json(&json, &mut depth_error),
                    );
                }
                for merge in merges {
                    for (k, v) in merge {
                        crate::deep::insert(&mut data, k, v);
                    }
                }
                ContentBlock::ProviderNative(ProviderNativeBlock {
                    provider,
                    block_type,
                    data,
                    cache_control: None,
                })
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
fn parse_tool_json(raw: &str, depth_error: &mut bool) -> Value {
    if crate::js::trim(raw).is_empty() {
        return Value::Object(Map::new());
    }
    crate::deep::scope_for(raw, || match crate::deep::parse(raw) {
        Ok(value) => value,
        Err(crate::deep::ParseError::TooDeep) => {
            *depth_error = true;
            Value::Object(Map::new())
        }
        Err(crate::deep::ParseError::Syntax) => crate::js::replace_lone_surrogates(raw)
            .and_then(|text| crate::deep::parse(&text).ok())
            .unwrap_or_else(|| Value::Object(Map::new())),
    })
}
