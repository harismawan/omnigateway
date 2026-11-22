//! `decodeCustomChat`: a custom server's Chat Completions stream.

use std::collections::{HashMap, VecDeque};

use super::{nullish_or, prop, truthy};
use omni_ir::error::ErrorCode;
use omni_ir::stream::{ContentBlockStart, Delta, StopReason, StreamEvent, Usage};
use omni_ir::{jsjson::JsValue as Value, text::Text};

use super::{JsKey, KeyMint, index0, iterate, json_object, nonempty, or_zero, usage_of};
use crate::codec::{DecodeError, Flow, StreamDecoder};
use crate::sse::SseMessage;

#[cfg(test)]
mod performance {
    use super::*;
    use std::{hint::black_box, time::Instant};

    #[test]
    #[ignore = "serial release stage profile, not a correctness test"]
    fn actual_benchmark_chunk_stages() {
        let data = r#"{"id":"chatcmpl-bench-01234567-89ab-cdef-0123-456789abcdef","object":"chat.completion.chunk","created":0,"model":"mock-c2000-d0","choices":[{"index":0,"delta":{"content":"lorem ipsum "}}]}"#;
        let msg = SseMessage {
            event: String::new(),
            data: data.into(),
        };
        for stage in [
            "scan",
            "typed",
            "general",
            "fast-decoder",
            "general-decoder",
        ] {
            let mut decoder = ChatDecoder::new();
            decoder.no_fast = stage == "general-decoder";
            let mut out = VecDeque::new();
            let start = Instant::now();
            for _ in 0..1_000_000 {
                match stage {
                    "scan" => {
                        black_box(omni_ir::deep::depth_of(black_box(data)));
                    }
                    "typed" => {
                        black_box(super::super::fast::parse_chat_chunk(black_box(data)));
                    }
                    "general" => {
                        black_box(json_object(black_box(data)));
                    }
                    _ => {
                        decoder.message(black_box(&msg), &mut out).expect("decode");
                        out.clear();
                    }
                }
            }
            eprintln!("{stage} million actual chunks {:?}", start.elapsed());
        }
    }
}

/// The reasoning text one chat delta carries: the first non-empty spelling.
fn reasoning_text(delta: &DeltaView<'_>) -> Text {
    if let Some(r) = delta.reasoning.and_then(Scalar::nonempty) {
        return r;
    }
    if let Some(r) = delta.reasoning_content.and_then(Scalar::nonempty) {
        return r;
    }
    let Some(Value::Array(details)) = delta.reasoning_details else {
        return Text::default();
    };
    let mut out = Text::default();
    for entry in details {
        let entry = Some(entry);
        if let Some(t) = nonempty(prop(entry, "text")) {
            out.push(&t);
        } else if let Some(s) = nonempty(prop(entry, "summary")) {
            out.push(&s);
        }
    }
    out
}

/// Typed chunks already have scalar UTF-8 strings. Generic chunks may need
/// UTF-16 or JS coercion; leave those fields in their lossless carrier.
#[derive(Clone, Copy)]
pub(super) enum Scalar<'a> {
    Utf8(&'a str),
    Js(&'a Value),
}

impl Scalar<'_> {
    fn as_text(self) -> Option<Text> {
        match self {
            Self::Utf8(s) => Some(s.into()),
            Self::Js(v) => v.as_text(),
        }
    }

    fn nonempty(self) -> Option<Text> {
        match self {
            Self::Utf8(s) => (!s.is_empty()).then(|| s.into()),
            Self::Js(v) => nonempty(Some(v)),
        }
    }

    fn start_text(self) -> Result<Text, DecodeError> {
        match self {
            Self::Utf8(s) => Ok(s.into()),
            Self::Js(Value::Null) => Ok(Text::default()),
            Self::Js(v) => super::string(Some(v)),
        }
    }
}

/// What the decoder reads off one chunk: each field as `d?.x` sees it
/// (`None` for absent, `Some(Null)` for null), whichever way it was parsed.
pub(super) struct ChunkView<'v> {
    pub(super) id: Option<Scalar<'v>>,
    pub(super) model: Option<Scalar<'v>>,
    pub(super) usage: Option<&'v Value>,
    /// `choices?.[0]`, when truthy.
    pub(super) choice: Option<ChoiceView<'v>>,
}

pub(super) struct ChoiceView<'v> {
    /// `choice.delta`, null filtered out; all-`None` when it is not an object.
    pub(super) delta: DeltaView<'v>,
    pub(super) finish_reason: Option<Scalar<'v>>,
}

#[derive(Default)]
pub(super) struct DeltaView<'v> {
    pub(super) content: Option<Scalar<'v>>,
    pub(super) reasoning: Option<Scalar<'v>>,
    pub(super) reasoning_content: Option<Scalar<'v>>,
    pub(super) reasoning_details: Option<&'v Value>,
    pub(super) tool_calls: Option<&'v Value>,
}

impl<'v> DeltaView<'v> {
    fn of(delta: Option<&'v Value>) -> Self {
        DeltaView {
            content: prop(delta, "content").map(Scalar::Js),
            reasoning: prop(delta, "reasoning").map(Scalar::Js),
            reasoning_content: prop(delta, "reasoning_content").map(Scalar::Js),
            reasoning_details: prop(delta, "reasoning_details"),
            tool_calls: prop(delta, "tool_calls"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Open {
    Text,
    Thinking,
    Tool,
}

/// `decodeCustomChat`.
#[derive(Debug, Default)]
pub struct ChatDecoder {
    identity_budget: super::IdentityBudget,
    started: bool,
    stop_reason: Option<StopReason>,
    usage: Usage,
    tool_index: HashMap<JsKey, u32>,
    argument_depth: HashMap<u32, super::ArgumentDepth>,
    keys: KeyMint,
    next_index: u32,
    open: Option<(Open, u32)>,
    /// Tests only: always take the generic path, to compare the two.
    #[cfg(test)]
    pub(super) no_fast: bool,
}

impl ChatDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Closes whatever block is open and opens a new one: at most one block
    /// is open at a time, so an Anthropic-shaped egress can replay the order.
    fn open_block(
        &mut self,
        kind: Open,
        block: ContentBlockStart,
        out: &mut VecDeque<StreamEvent>,
    ) -> u32 {
        if let Some((_, i)) = self.open {
            out.push_back(StreamEvent::BlockEnd { index: i });
        }
        let index = self.next_index;
        self.next_index += 1;
        self.open = Some((kind, index));
        out.push_back(StreamEvent::BlockStart { index, block });
        index
    }

    /// The open block if it is a `kind` (text or thinking), else a new one.
    fn continue_or_open(&mut self, kind: Open, out: &mut VecDeque<StreamEvent>) -> u32 {
        match self.open {
            Some((k, i)) if k == kind => i,
            _ => {
                // Never signed: a signature here was minted by another provider.
                let block = if kind == Open::Thinking {
                    ContentBlockStart::Thinking { signed: None }
                } else {
                    ContentBlockStart::Text
                };
                self.open_block(kind, block, out)
            }
        }
    }

    /// One chunk's fields, as `decodeCustomChat`'s loop body reads them.
    fn apply(
        &mut self,
        d: &ChunkView<'_>,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        let (id, model) = (d.id, d.model);
        if !self.started && (id.is_some() || model.is_some()) {
            self.started = true;
            let text = |v: Option<Scalar<'_>>| v.map(Scalar::start_text).transpose();
            out.push_back(StreamEvent::Start {
                id: text(id)?.unwrap_or_default(),
                model: text(model)?.unwrap_or_default(),
            });
        }

        let usage = d.usage;
        if truthy(usage) {
            let details = prop(usage, "prompt_tokens_details");
            self.usage = usage_of(
                prop(usage, "prompt_tokens"),
                prop(usage, "completion_tokens"),
                nullish_or(
                    prop(details, "cached_tokens"),
                    prop(usage, "prompt_cache_hit_tokens"),
                ),
                nullish_or(
                    prop(details, "cache_creation_tokens"),
                    prop(details, "cache_write_tokens"),
                ),
            )?;
        }

        let Some(choice) = &d.choice else {
            return Ok(Flow::Continue);
        };
        let delta = &choice.delta;

        let reasoning = reasoning_text(delta);
        if !reasoning.is_empty() {
            let index = self.continue_or_open(Open::Thinking, out);
            out.push_back(StreamEvent::BlockDelta {
                index,
                delta: Delta::Thinking { text: reasoning },
            });
        }

        if let Some(content) = delta.content.and_then(Scalar::nonempty) {
            let index = self.continue_or_open(Open::Text, out);
            out.push_back(StreamEvent::BlockDelta {
                index,
                delta: Delta::Text { text: content },
            });
        }

        for call in iterate(delta.tool_calls)? {
            // Reading a property of `null` throws in JS.
            if call.is_null() {
                return Err(DecodeError::Throw("tool call is null"));
            }
            let call = Some(&call);
            let wire_index = or_zero(prop(call, "index"));
            let key = self.keys.key(&wire_index);
            let function = prop(call, "function");
            let index = match self.tool_index.get(&key) {
                Some(&index) => index,
                None => {
                    self.identity_budget.add(key.bytes())?;
                    // Yield the previous block's end before coercing
                    // the next tool's identity (which may throw).
                    if let Some((_, index)) = self.open.take() {
                        out.push_back(StreamEvent::BlockEnd { index });
                    }
                    let id = match prop(call, "id") {
                        None | Some(Value::Null) => {
                            super::string(Some(&wire_index))?.surrounded("call_", "")
                        }
                        some => super::string(some)?,
                    };
                    let name = match prop(function, "name") {
                        None | Some(Value::Null) => Text::default(),
                        some => super::string(some)?,
                    };
                    let index =
                        self.open_block(Open::Tool, ContentBlockStart::ToolUse { id, name }, out);
                    self.tool_index.insert(key, index);
                    index
                }
            };
            if let Some(args) = nonempty(prop(function, "arguments")) {
                self.argument_depth.entry(index).or_default().push(&args)?;
                out.push_back(StreamEvent::BlockDelta {
                    index,
                    delta: Delta::ToolJson { partial: args },
                });
            }
        }

        if let Some(reason) = choice.finish_reason.and_then(Scalar::as_text) {
            match CHAT_FINISH.iter().find(|(k, _)| reason == *k) {
                Some((_, mapped)) => self.stop_reason = Some(*mapped),
                None => {
                    out.push_back(StreamEvent::Error {
                        code: ErrorCode::Upstream,
                        message: reason
                            .surrounded("unrecognized custom endpoint finish reason \"", "\""),
                        retryable: false,
                    });
                    return Ok(Flow::Stop);
                }
            }
        }
        Ok(Flow::Continue)
    }
}

const CHAT_FINISH: [(&str, StopReason); 4] = [
    ("stop", StopReason::EndTurn),
    ("length", StopReason::MaxTokens),
    ("tool_calls", StopReason::ToolUse),
    ("content_filter", StopReason::ContentFilter),
];

impl StreamDecoder for ChatDecoder {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        if msg.data == "[DONE]" {
            // The transport-level success marker.
            if let Some((_, i)) = self.open {
                out.push_back(StreamEvent::BlockEnd { index: i });
            }
            out.push_back(StreamEvent::End {
                stop_reason: self.stop_reason.unwrap_or(StopReason::EndTurn),
                usage: self.usage.clone(),
                vendor: None,
            });
            return Ok(Flow::Stop);
        }
        let depth = omni_ir::deep::depth_of(&msg.data);
        if depth > omni_ir::deep::MAX_DEPTH {
            return Err(DecodeError::Throw("upstream JSON exceeds depth 40000"));
        }
        omni_ir::deep::scope_for_bound(depth, |_| {
            #[cfg(test)]
            let fast = if self.no_fast {
                None
            } else {
                super::fast::parse_chat_chunk(&msg.data)
            };
            #[cfg(not(test))]
            let fast = super::fast::parse_chat_chunk(&msg.data);
            if let Some(fast) = fast {
                return self.apply(&fast.view(), out);
            }
            let Some(d) = json_object(&msg.data) else {
                return Ok(Flow::Continue);
            };
            let d = Some(&d);
            let choice = index0(prop(d, "choices"));
            let view = ChunkView {
                id: prop(d, "id").map(Scalar::Js),
                model: prop(d, "model").map(Scalar::Js),
                usage: prop(d, "usage"),
                choice: truthy(choice.as_ref()).then(|| {
                    let choice = choice.as_ref();
                    ChoiceView {
                        delta: DeltaView::of(prop(choice, "delta").filter(|v| !v.is_null())),
                        finish_reason: prop(choice, "finish_reason").map(Scalar::Js),
                    }
                }),
            };
            self.apply(&view, out)
        })
    }

    fn finish(&mut self, out: &mut VecDeque<StreamEvent>) {
        out.push_back(StreamEvent::Error {
            code: ErrorCode::Upstream,
            message: "upstream stream ended before [DONE]".into(),
            retryable: ErrorCode::Upstream.retryable(),
        });
    }
}
