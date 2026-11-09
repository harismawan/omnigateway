//! OpenAI Responses egress: `egress/responses.ts`.

use std::collections::HashSet;

use omni_ir::deep::Owned;
use omni_ir::error::ErrorCode;
use omni_ir::jsjson::{write_number, write_str, write_value};
use omni_ir::request::ContentBlock;
use omni_ir::stream::{
    CollectedResponse, ContentBlockStart, Delta, NativeFold, StopReason, StreamEvent, Usage,
    number, prompt_tokens,
};
use serde_json::{Map, Value, json};

use super::openai::error_type;
use super::{begin_frame, end_frame};

/// `STATUS`: the terminal status and, when incomplete, why.
fn status(s: StopReason) -> (&'static str, Option<&'static str>) {
    match s {
        StopReason::EndTurn
        | StopReason::ToolUse
        | StopReason::StopSequence
        | StopReason::PauseTurn => ("completed", None),
        StopReason::MaxTokens => ("incomplete", Some("max_output_tokens")),
        StopReason::ContentFilter => ("incomplete", Some("content_filter")),
    }
}

fn usage_value(u: &Usage) -> Value {
    let input = prompt_tokens(u);
    json!({
        "input_tokens": number(input),
        "input_tokens_details": { "cached_tokens": number(u.cache_read_tokens) },
        "output_tokens": number(u.output_tokens),
        "output_tokens_details": { "reasoning_tokens": 0 },
        "total_tokens": number(input + u.output_tokens),
    })
}

/// `ResponsesRender`: what the route knows that the stream does not.
#[derive(Debug, Clone)]
pub struct ResponsesRender {
    pub request_id: String,
    /// `Math.floor(now / 1000)` at the request's start.
    pub created: i64,
    /// `customToolNames(body)`: tools the client declared freeform.
    pub custom_tool_names: HashSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Message,
    Reasoning,
    FunctionCall,
    CustomToolCall,
    Native,
}

impl Kind {
    fn prefix(self) -> &'static str {
        match self {
            Kind::Message => "msg",
            Kind::Reasoning => "rs",
            Kind::FunctionCall => "fc",
            Kind::CustomToolCall => "ctc",
            Kind::Native => "item",
        }
    }
}

struct Item {
    ir_index: u32,
    output_index: u32,
    id: String,
    kind: Kind,
    text: String,
    tool_name: String,
    call_id: String,
    /// A native item's `type`; its payload is `{ type, ...native }`.
    block_type: String,
    native: Map<String, Value>,
}

impl Drop for Item {
    fn drop(&mut self) {
        omni_ir::deep::drop_map_in_place(&mut self.native);
    }
}

/// `customToolInput`: the program inside `{"input": "<program>"}`, else raw.
fn custom_tool_input(raw: &str) -> String {
    omni_ir::deep::scope_for(raw, || {
        let parsed = omni_ir::deep::parse(raw)
            .ok()
            .or_else(|| {
                omni_ir::js::replace_lone_surrogates(raw)
                    .and_then(|s| omni_ir::deep::parse(&s).ok())
            })
            .map(omni_ir::deep::Owned);
        if let Some(Value::String(inner)) = parsed.as_ref().and_then(|v| v.get("input")) {
            return inner.clone();
        }
        raw.to_string()
    })
}

/// `renderItem`, written straight into `out`.
fn write_item(item: &Item, status: &str, out: &mut String) {
    let done = status == "completed";
    let head = |t: &str, out: &mut String| {
        out.push_str(r#"{"id":"#);
        write_str(&item.id, out);
        out.push_str(r#","type":"#);
        write_str(t, out);
        out.push_str(r#","status":"#);
        write_str(status, out);
    };
    match item.kind {
        Kind::Message => {
            head("message", out);
            out.push_str(r#","role":"assistant","content":["#);
            if done {
                out.push_str(r#"{"type":"output_text","text":"#);
                write_str(&item.text, out);
                out.push_str(r#","annotations":[]}"#);
            }
            out.push_str("]}");
        }
        Kind::Reasoning => {
            head("reasoning", out);
            out.push_str(r#","summary":["#);
            if done && !item.text.is_empty() {
                out.push_str(r#"{"type":"summary_text","text":"#);
                write_str(&item.text, out);
                out.push('}');
            }
            out.push_str("]}");
        }
        Kind::FunctionCall | Kind::CustomToolCall => {
            let custom = item.kind == Kind::CustomToolCall;
            head(
                if custom {
                    "custom_tool_call"
                } else {
                    "function_call"
                },
                out,
            );
            out.push_str(r#","call_id":"#);
            write_str(&item.call_id, out);
            out.push_str(r#","name":"#);
            write_str(&item.tool_name, out);
            out.push_str(if custom {
                r#","input":"#
            } else {
                r#","arguments":"#
            });
            match (done, custom) {
                (false, _) => out.push_str(r#""""#),
                (true, false) => write_str(&item.text, out),
                (true, true) => write_str(&custom_tool_input(&item.text), out),
            }
            out.push('}');
        }
        Kind::Native => {
            omni_ir::jsjson::write_spread(
                &item.native,
                "type",
                &item.block_type,
                omni_ir::jsjson::Spread::KeyFirst,
                out,
            );
        }
    }
}

/// `,"error":{"code":…,"message":…}`.
fn write_failure(code: &str, message: &str, out: &mut String) {
    out.push_str(r#","error":{"code":"#);
    write_str(code, out);
    out.push_str(r#","message":"#);
    write_str(message, out);
    out.push('}');
}

/// `JSON.stringify(String(v ?? ""))`, without building the string for a
/// string value. A non-string summary is a malformed upstream and rare, so
/// that branch may allocate its `String()` form.
fn write_js_string(v: Option<&Value>, out: &mut String) {
    match v {
        None | Some(Value::Null) => out.push_str(r#""""#),
        Some(Value::String(s)) => write_str(s, out),
        some => write_str(&omni_ir::js::to_string(some), out),
    }
}

/// How a native `merge` payload reaches the open item.
enum Merge {
    /// Read from the borrowed event and copied.
    Borrowed,
    /// Taken out of an event the caller gave up.
    Moved(Map<String, Value>),
}

/// `responsesStream`, one event at a time.
pub struct ResponsesStream {
    render: ResponsesRender,
    model: String,
    sequence: u64,
    terminated: bool,
    /// Every completed item's JSON, comma-separated: each item is encoded
    /// once, when it closes, and the terminal snapshot copies these bytes.
    output: String,
    next_output_index: u32,
    open: Option<Item>,
}

/// Frame fields after `type` and `sequence_number`, written by the caller.
struct Fields<'a> {
    out: &'a mut String,
}

impl Fields<'_> {
    fn key(&mut self, k: &str) -> &mut String {
        self.out.push(',');
        write_str(k, self.out);
        self.out.push(':');
        self.out
    }
    fn str(&mut self, k: &str, v: &str) -> &mut Self {
        let out = self.key(k);
        write_str(v, out);
        self
    }
    fn num(&mut self, k: &str, v: u32) -> &mut Self {
        let out = self.key(k);
        write_number(f64::from(v), out);
        self
    }
}

impl ResponsesStream {
    pub fn new(render: ResponsesRender) -> ResponsesStream {
        ResponsesStream {
            render,
            model: String::new(),
            sequence: 0,
            terminated: false,
            output: String::new(),
            next_output_index: 0,
            open: None,
        }
    }

    fn frame(&mut self, event: &str, out: &mut String, fields: impl FnOnce(&mut Fields<'_>)) {
        self.sequence += 1;
        begin_frame(event, out);
        out.push_str(r#"{"type":"#);
        write_str(event, out);
        out.push_str(r#","sequence_number":"#);
        #[allow(clippy::cast_precision_loss)]
        write_number(self.sequence as f64, out);
        fields(&mut Fields { out: &mut *out });
        out.push('}');
        end_frame(out);
    }

    /// `snapshot(status, extra)`, written into `out`.
    fn write_snapshot(&self, status: &str, extra: impl FnOnce(&mut String), out: &mut String) {
        out.push_str(r#"{"id":"resp_"#);
        let mut id = String::new();
        write_str(&self.render.request_id, &mut id);
        // `"resp_" + requestId`: the quoted id without its opening quote.
        out.push_str(&id[1..]);
        out.push_str(r#","object":"response","created_at":"#);
        #[allow(clippy::cast_precision_loss)]
        write_number(self.render.created as f64, out);
        out.push_str(r#","status":"#);
        write_str(status, out);
        out.push_str(r#","model":"#);
        write_str(&self.model, out);
        out.push_str(r#","output":["#);
        out.push_str(&self.output);
        out.push(']');
        extra(out);
        out.push('}');
    }

    /// A frame whose only field is `response`: a snapshot.
    fn snapshot_frame(
        &mut self,
        event: &str,
        status: &str,
        extra: impl FnOnce(&mut String),
        out: &mut String,
    ) {
        self.sequence += 1;
        begin_frame(event, out);
        out.push_str(r#"{"type":"#);
        write_str(event, out);
        out.push_str(r#","sequence_number":"#);
        #[allow(clippy::cast_precision_loss)]
        write_number(self.sequence as f64, out);
        out.push_str(r#","response":"#);
        self.write_snapshot(status, extra, out);
        out.push('}');
        end_frame(out);
    }

    fn open_item(
        &mut self,
        ir_index: u32,
        kind: Kind,
        call_id: &str,
        tool_name: &str,
        block_type: &str,
        native: Map<String, Value>,
    ) {
        let output_index = self.next_output_index;
        self.next_output_index += 1;
        let id = if call_id.is_empty() {
            format!(
                "{}_{}_{output_index}",
                kind.prefix(),
                self.render.request_id
            )
        } else {
            format!("{}_{call_id}", kind.prefix())
        };
        self.open = Some(Item {
            ir_index,
            output_index,
            id,
            kind,
            text: String::new(),
            tool_name: tool_name.to_string(),
            call_id: call_id.to_string(),
            block_type: block_type.to_string(),
            native,
        });
    }

    fn close_current(&mut self, out: &mut String) {
        let Some(item) = self.open.take() else {
            return;
        };
        let (id, oi) = (item.id.as_str(), item.output_index);
        match item.kind {
            Kind::Message => {
                self.frame("response.output_text.done", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .num("content_index", 0);
                    f.str("text", &item.text);
                });
                self.frame("response.content_part.done", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .num("content_index", 0);
                    let out = f.key("part");
                    out.push_str(r#"{"type":"output_text","text":"#);
                    write_str(&item.text, out);
                    out.push_str(r#","annotations":[]}"#);
                });
            }
            Kind::Reasoning => {
                self.frame("response.reasoning_summary_text.done", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .num("summary_index", 0);
                    f.str("text", &item.text);
                });
                self.frame("response.reasoning_summary_part.done", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .num("summary_index", 0);
                    let out = f.key("part");
                    out.push_str(r#"{"type":"summary_text","text":"#);
                    write_str(&item.text, out);
                    out.push('}');
                });
            }
            Kind::FunctionCall => {
                self.frame("response.function_call_arguments.done", out, |f| {
                    f.str("item_id", id).num("output_index", oi);
                    f.str("arguments", &item.text);
                });
            }
            Kind::CustomToolCall => {
                let input = custom_tool_input(&item.text);
                self.frame("response.custom_tool_call_input.delta", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .str("delta", &input);
                });
                self.frame("response.custom_tool_call_input.done", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .str("input", &input);
                });
            }
            Kind::Native => {}
        }
        let mut span = (0, 0);
        self.frame("response.output_item.done", out, |f| {
            f.num("output_index", oi);
            let out = f.key("item");
            let begin = out.len();
            write_item(&item, "completed", out);
            span = (begin, out.len());
        });
        // The item's bytes, just written, are kept for the terminal snapshot.
        if !self.output.is_empty() {
            self.output.push(',');
        }
        self.output.push_str(&out[span.0..span.1]);
    }

    /// [`Self::push`] for an event the caller is done with: a native
    /// `merge` delta's payload is moved into the open item rather than
    /// copied. Every frame is written from borrowed data, as `push` writes it.
    pub fn push_owned(&mut self, mut event: StreamEvent, out: &mut String) {
        let merge = match &mut event {
            StreamEvent::BlockDelta {
                delta:
                    Delta::ProviderNative {
                        fold: Some(NativeFold::Merge),
                        data,
                        ..
                    },
                ..
            } => Some(std::mem::take(data)),
            _ => None,
        };
        match merge {
            None => self.push(&event, out),
            Some(data) => self.native_delta(&event, Merge::Moved(data), out),
        }
    }

    /// A native delta for the open native item: the frame from borrowed data,
    /// then a `merge` payload folded in (moved when the caller gave it up).
    fn native_delta(&mut self, event: &StreamEvent, merge: Merge, out: &mut String) {
        let StreamEvent::BlockDelta {
            index,
            delta:
                Delta::ProviderNative {
                    delta_type,
                    fold,
                    data,
                    ..
                },
        } = event
        else {
            return;
        };
        let Some(item) = self.open.take() else {
            return;
        };
        if item.ir_index != *index || item.kind != Kind::Native {
            self.open = Some(item);
            return;
        }
        let oi = item.output_index;
        if delta_type == "reasoning_summary_text.delta" {
            // From the moved map when there is one: the event's was taken.
            let text = match &merge {
                Merge::Moved(moved) => moved.get("text"),
                Merge::Borrowed => data.get("text"),
            };
            let id = item.id.as_str();
            self.frame("response.reasoning_summary_text.delta", out, |f| {
                f.str("item_id", id)
                    .num("output_index", oi)
                    .num("summary_index", 0);
                write_js_string(text, f.key("delta"));
            });
        }
        let mut item = item;
        if *fold == Some(NativeFold::Merge) {
            match merge {
                Merge::Moved(moved) => {
                    for (k, v) in moved {
                        item.native.insert(k, v);
                    }
                }
                // A borrowed event has to be copied to be kept; `push_owned`
                // moves it instead.
                Merge::Borrowed => {
                    for (k, v) in data {
                        item.native.insert(k.clone(), omni_ir::deep::clone(v));
                    }
                }
            }
        }
        self.open = Some(item);
    }

    /// The open item's retained native payload (diagnostics and tests).
    pub fn open_native(&self) -> Option<&Map<String, Value>> {
        self.open.as_ref().map(|o| &o.native)
    }

    pub fn push(&mut self, event: &StreamEvent, out: &mut String) {
        match event {
            StreamEvent::Start { model, .. } => {
                self.model.clone_from(model);
                for name in ["response.created", "response.in_progress"] {
                    self.snapshot_frame(name, "in_progress", |_| {}, out);
                }
            }
            StreamEvent::BlockStart { index, block } => {
                if self.open.as_ref().is_some_and(|o| o.ir_index == *index) {
                    return;
                }
                self.close_current(out);
                match block {
                    ContentBlockStart::Text => {
                        self.open_item(*index, Kind::Message, "", "", "", Map::new());
                    }
                    ContentBlockStart::Thinking { .. } => {
                        self.open_item(*index, Kind::Reasoning, "", "", "", Map::new());
                    }
                    ContentBlockStart::ToolUse { id, name } => {
                        let kind = if self.render.custom_tool_names.contains(name) {
                            Kind::CustomToolCall
                        } else {
                            Kind::FunctionCall
                        };
                        self.open_item(*index, kind, id, name, "", Map::new());
                    }
                    ContentBlockStart::ProviderNative {
                        block_type, data, ..
                    } => {
                        self.open_item(
                            *index,
                            Kind::Native,
                            "",
                            "",
                            block_type,
                            omni_ir::deep::clone_map(data),
                        );
                    }
                }
                let Some(item) = self.open.take() else {
                    return;
                };
                let (id, oi) = (item.id.as_str(), item.output_index);
                self.frame("response.output_item.added", out, |f| {
                    f.num("output_index", oi);
                    write_item(&item, "in_progress", f.key("item"));
                });
                match item.kind {
                    Kind::Message => self.frame("response.content_part.added", out, |f| {
                        f.str("item_id", id)
                            .num("output_index", oi)
                            .num("content_index", 0);
                        f.key("part")
                            .push_str(r#"{"type":"output_text","text":"","annotations":[]}"#);
                    }),
                    Kind::Reasoning => {
                        self.frame("response.reasoning_summary_part.added", out, |f| {
                            f.str("item_id", id)
                                .num("output_index", oi)
                                .num("summary_index", 0);
                            f.key("part")
                                .push_str(r#"{"type":"summary_text","text":""}"#);
                        });
                    }
                    _ => {}
                }
                self.open = Some(item);
            }
            StreamEvent::BlockDelta { index, delta } => {
                let Some(mut item) = self.open.take() else {
                    return;
                };
                if item.ir_index != *index {
                    self.open = Some(item);
                    return;
                }
                let (oi, kind) = (item.output_index, item.kind);
                match delta {
                    Delta::Text { text } if kind == Kind::Message => {
                        item.text.push_str(text);
                        let id = item.id.as_str();
                        self.frame("response.output_text.delta", out, |f| {
                            f.str("item_id", id)
                                .num("output_index", oi)
                                .num("content_index", 0);
                            f.str("delta", text);
                        });
                    }
                    Delta::Thinking { text } if kind == Kind::Reasoning => {
                        item.text.push_str(text);
                        let id = item.id.as_str();
                        self.frame("response.reasoning_summary_text.delta", out, |f| {
                            f.str("item_id", id)
                                .num("output_index", oi)
                                .num("summary_index", 0);
                            f.str("delta", text);
                        });
                    }
                    Delta::ToolJson { partial } => {
                        item.text.push_str(partial);
                        if kind == Kind::FunctionCall {
                            let id = item.id.as_str();
                            self.frame("response.function_call_arguments.delta", out, |f| {
                                f.str("item_id", id).num("output_index", oi);
                                f.str("delta", partial);
                            });
                        }
                    }
                    Delta::ProviderNative { .. } if kind == Kind::Native => {
                        self.open = Some(item);
                        self.native_delta(event, Merge::Borrowed, out);
                        return;
                    }
                    _ => {}
                }
                self.open = Some(item);
            }
            StreamEvent::BlockEnd { index } => {
                if self.open.as_ref().is_some_and(|o| o.ir_index == *index) {
                    self.close_current(out);
                }
            }
            StreamEvent::End {
                stop_reason, usage, ..
            } => {
                self.close_current(out);
                let (status, reason) = status(*stop_reason);
                self.terminated = true;
                let name = if status == "completed" {
                    "response.completed"
                } else {
                    "response.incomplete"
                };
                let extra = |out: &mut String| {
                    if let Some(reason) = reason {
                        out.push_str(r#","incomplete_details":{"reason":"#);
                        write_str(reason, out);
                        out.push('}');
                    }
                    out.push_str(r#","usage":"#);
                    write_value(&usage_value(usage), out);
                };
                self.snapshot_frame(name, status, extra, out);
            }
            StreamEvent::Error { code, message, .. } => {
                self.close_current(out);
                self.terminated = true;
                let code = error_type(*code).1;
                let extra = |out: &mut String| write_failure(code, message, out);
                self.snapshot_frame("response.failed", "failed", extra, out);
            }
        }
    }

    pub fn finish(&mut self, out: &mut String) {
        if !self.terminated {
            self.close_current(out);
            let extra = |out: &mut String| {
                write_failure(
                    "stream_disconnected",
                    "stream closed before response.completed",
                    out,
                );
            };
            self.snapshot_frame("response.failed", "failed", extra, out);
        }
        begin_frame("message", out);
        out.push_str("[DONE]");
        end_frame(out);
    }
}

/// `responsesResponse`.
/// The body holds client payloads (tool inputs, native blocks), so it is
/// returned as a [`Owned`] that drops iteratively.
pub fn response(collected: &CollectedResponse, render: &ResponsesRender) -> Owned {
    Owned(response_value(collected, render))
}

fn response_value(collected: &CollectedResponse, render: &ResponsesRender) -> Value {
    let mut out = String::new();
    write_response(collected, render, &mut out);
    // Our own output, so it parses; `Value` is the type the route renders.
    omni_ir::deep::parse(&out).unwrap_or(Value::Null)
}

/// `responsesResponse`, written as the bytes `JSON.stringify` produces.
pub fn write_response(collected: &CollectedResponse, render: &ResponsesRender, out: &mut String) {
    let rid = &render.request_id;
    let mut s = ResponsesStream::new(render.clone());
    s.model.clone_from(&collected.model);
    for (i, block) in collected.content.iter().enumerate() {
        let oi = u32::try_from(i).unwrap_or(u32::MAX);
        let item = |kind, id: String, text: String, tool_name: &str, call_id: &str| Item {
            ir_index: oi,
            output_index: oi,
            id,
            kind,
            text,
            tool_name: tool_name.to_string(),
            call_id: call_id.to_string(),
            block_type: String::new(),
            native: Map::new(),
        };
        let rendered = match block {
            ContentBlock::Text(t) => item(
                Kind::Message,
                format!("msg_{rid}_{oi}"),
                t.text.clone(),
                "",
                "",
            ),
            ContentBlock::Thinking(t) => item(
                Kind::Reasoning,
                format!("rs_{rid}_{oi}"),
                t.text.clone(),
                "",
                "",
            ),
            ContentBlock::ToolUse(t) => {
                let custom = render.custom_tool_names.contains(&t.name);
                item(
                    if custom {
                        Kind::CustomToolCall
                    } else {
                        Kind::FunctionCall
                    },
                    format!("{}_{}", if custom { "ctc" } else { "fc" }, t.id),
                    omni_ir::jsjson::to_string(&t.input),
                    &t.name,
                    &t.id,
                )
            }
            ContentBlock::ProviderNative(n) if n.provider == "openai" => {
                if !s.output.is_empty() {
                    s.output.push(',');
                }
                omni_ir::jsjson::write_spread(
                    &n.data,
                    "type",
                    &n.block_type,
                    omni_ir::jsjson::Spread::KeyFirst,
                    &mut s.output,
                );
                continue;
            }
            _ => continue,
        };
        if !s.output.is_empty() {
            s.output.push(',');
        }
        let mut buf = std::mem::take(&mut s.output);
        write_item(&rendered, "completed", &mut buf);
        s.output = buf;
    }
    let (status, reason) = status(collected.stop_reason);
    s.write_snapshot(
        status,
        |out| {
            out.push_str(r#","store":false"#);
            if let Some(reason) = reason {
                out.push_str(r#","incomplete_details":{"reason":"#);
                write_str(reason, out);
                out.push('}');
            }
            out.push_str(r#","usage":"#);
            write_value(&usage_value(&collected.usage), out);
        },
        out,
    );
}

/// `responsesErrorBody`.
pub fn error_body(code: ErrorCode, message: &str) -> Value {
    let (t, c) = error_type(code);
    json!({ "error": { "type": t, "code": c, "message": message, "param": null } })
}
