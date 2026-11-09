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

/// Token counts. JS numbers, so `f64`: an upstream reporting `"12"` or `1.5`
/// flows through TS arithmetic unchanged, and pricing sees the same value.
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

#[derive(Debug, Clone, PartialEq)]
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

#[derive(Debug, Clone, PartialEq)]
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

#[derive(Debug, Clone, PartialEq)]
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
    /// The TS object, as `JSON.stringify` would write it.
    pub fn to_json(&self) -> String {
        jsjson::to_string(&self.to_value())
    }

    /// The TS object as a JSON value, keys in TS insertion order.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        let s = |v: &str| Value::String(v.to_string());
        match self {
            StreamEvent::Start { id, model } => {
                m.insert("type".into(), s("start"));
                m.insert("id".into(), s(id));
                m.insert("model".into(), s(model));
            }
            StreamEvent::BlockStart { index, block } => {
                m.insert("type".into(), s("blockStart"));
                m.insert("index".into(), Value::from(*index));
                m.insert("block".into(), block_start_value(block));
            }
            StreamEvent::BlockDelta { index, delta } => {
                m.insert("type".into(), s("blockDelta"));
                m.insert("index".into(), Value::from(*index));
                m.insert("delta".into(), delta_value(delta));
            }
            StreamEvent::BlockEnd { index } => {
                m.insert("type".into(), s("blockEnd"));
                m.insert("index".into(), Value::from(*index));
            }
            StreamEvent::End {
                stop_reason,
                usage,
                vendor,
            } => {
                m.insert("type".into(), s("end"));
                m.insert("stopReason".into(), s(stop_reason.as_str()));
                m.insert("usage".into(), usage_value(usage));
                if let Some(v) = vendor {
                    m.insert("vendor".into(), Value::Object(v.clone()));
                }
            }
            StreamEvent::Error {
                code,
                message,
                retryable,
            } => {
                m.insert("type".into(), s("error"));
                m.insert("code".into(), s(code.as_str()));
                m.insert("message".into(), s(message));
                m.insert("retryable".into(), Value::Bool(*retryable));
            }
        }
        Value::Object(m)
    }
}

/// A JS number as a JSON value; non-finite becomes `null`, as `JSON.stringify`.
pub fn number(v: f64) -> Value {
    serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
}

pub fn usage_value(u: &Usage) -> Value {
    let mut m = Map::new();
    m.insert("inputTokens".into(), number(u.input_tokens));
    m.insert("outputTokens".into(), number(u.output_tokens));
    m.insert("cacheReadTokens".into(), number(u.cache_read_tokens));
    m.insert("cacheWriteTokens".into(), number(u.cache_write_tokens));
    if let Some(v) = u.cache_write_5m_tokens {
        m.insert("cacheWrite5mTokens".into(), number(v));
    }
    if let Some(v) = u.cache_write_1h_tokens {
        m.insert("cacheWrite1hTokens".into(), number(v));
    }
    Value::Object(m)
}

fn block_start_value(b: &ContentBlockStart) -> Value {
    let mut m = Map::new();
    match b {
        ContentBlockStart::Text => {
            m.insert("type".into(), "text".into());
        }
        ContentBlockStart::Thinking { signed } => {
            m.insert("type".into(), "thinking".into());
            if let Some(signed) = signed {
                m.insert("signed".into(), Value::Bool(*signed));
            }
        }
        ContentBlockStart::ToolUse { id, name } => {
            m.insert("type".into(), "toolUse".into());
            m.insert("id".into(), id.as_str().into());
            m.insert("name".into(), name.as_str().into());
        }
        ContentBlockStart::ProviderNative {
            provider,
            block_type,
            data,
        } => {
            m.insert("type".into(), "providerNative".into());
            m.insert("provider".into(), provider.as_str().into());
            m.insert("blockType".into(), block_type.as_str().into());
            m.insert("data".into(), Value::Object(data.clone()));
        }
    }
    Value::Object(m)
}

fn delta_value(d: &Delta) -> Value {
    let mut m = Map::new();
    match d {
        Delta::Text { text } => {
            m.insert("type".into(), "text".into());
            m.insert("text".into(), text.as_str().into());
        }
        Delta::Thinking { text } => {
            m.insert("type".into(), "thinking".into());
            m.insert("text".into(), text.as_str().into());
        }
        Delta::ThinkingSignature { signature } => {
            m.insert("type".into(), "thinkingSignature".into());
            m.insert("signature".into(), signature.as_str().into());
        }
        Delta::ToolJson { partial } => {
            m.insert("type".into(), "toolJson".into());
            m.insert("partial".into(), partial.as_str().into());
        }
        Delta::ProviderNativeJson { provider, partial } => {
            m.insert("type".into(), "providerNativeJson".into());
            m.insert("provider".into(), provider.as_str().into());
            m.insert("partial".into(), partial.as_str().into());
        }
        Delta::ProviderNative {
            provider,
            delta_type,
            fold,
            data,
        } => {
            m.insert("type".into(), "providerNative".into());
            m.insert("provider".into(), provider.as_str().into());
            m.insert("deltaType".into(), delta_type.as_str().into());
            if let Some(fold) = fold {
                let f = match fold {
                    NativeFold::Merge => "merge",
                    NativeFold::Citation => "citation",
                };
                m.insert("fold".into(), f.into());
            }
            m.insert("data".into(), Value::Object(data.clone()));
        }
    }
    Value::Object(m)
}

/// `CollectedResponse`.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectedResponse {
    pub id: String,
    pub model: String,
    pub content: Vec<ContentBlock>,
    pub stop_reason: StopReason,
    pub usage: Usage,
    pub vendor: Option<Map<String, Value>>,
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

    for ev in events {
        match ev {
            StreamEvent::Start { id: i, model: m } => {
                id = i;
                model = m;
            }
            StreamEvent::BlockStart { index, block } => {
                let acc = match block {
                    ContentBlockStart::ToolUse { id, name } => Accum::ToolUse {
                        id,
                        name,
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
                        provider,
                        block_type,
                        data,
                        json: String::new(),
                        merges: Vec::new(),
                    },
                    ContentBlockStart::Text => Accum::Text {
                        text: String::new(),
                        citations: Vec::new(),
                    },
                };
                blocks.insert(index, acc);
            }
            StreamEvent::BlockDelta { index, delta } => {
                let Some(acc) = blocks.get_mut(&index) else {
                    continue;
                };
                match (delta, acc) {
                    (Delta::Text { text }, Accum::Text { text: t, .. })
                    | (Delta::Thinking { text }, Accum::Thinking { text: t, .. }) => {
                        t.push_str(&text);
                    }
                    // Concatenated: a signature may arrive in fragments.
                    (
                        Delta::ThinkingSignature { signature },
                        Accum::Thinking { signature: s, .. },
                    ) => {
                        s.get_or_insert_with(String::new).push_str(&signature);
                    }
                    (Delta::ToolJson { partial }, Accum::ToolUse { json, .. })
                    | (
                        Delta::ProviderNativeJson { partial, .. },
                        Accum::ProviderNative { json, .. },
                    ) => {
                        json.push_str(&partial);
                    }
                    (
                        Delta::ProviderNative {
                            fold: Some(NativeFold::Merge),
                            data,
                            ..
                        },
                        Accum::ProviderNative { merges, .. },
                    ) => merges.push(data),
                    (
                        Delta::ProviderNative {
                            fold: Some(NativeFold::Citation),
                            data,
                            ..
                        },
                        Accum::Text { citations, .. },
                    ) => {
                        // `data.citation`, which is `undefined` when absent.
                        citations.push(data.get("citation").cloned().unwrap_or(Value::Null));
                    }
                    _ => {}
                }
            }
            StreamEvent::End {
                stop_reason: s,
                usage: u,
                vendor: v,
            } => {
                stop_reason = s;
                usage = u;
                vendor = v;
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
                    data.insert("input".into(), parse_tool_json(&json, &mut depth_error));
                }
                for merge in merges {
                    for (k, v) in merge {
                        data.insert(k, v);
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
