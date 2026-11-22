//! OpenAI Responses egress.

use std::collections::HashSet;

use omni_ir::error::ErrorCode;
use omni_ir::jsjson::{JsValue, write_js_value, write_number, write_str};
use omni_ir::stream::{
    CollectedBlock, CollectedResponse, ContentBlockStart, Delta, NativeFold, StopReason,
    StreamEvent, Usage,
};
use omni_ir::text::Text;

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

fn usage_value(u: &Usage) -> JsValue {
    let input = u.client_prompt();
    let total = u.client_total(&input);
    JsValue::object([
        ("input_tokens", input),
        (
            "input_tokens_details",
            JsValue::object([("cached_tokens", u.client_cache_read())]),
        ),
        ("output_tokens", u.client_output()),
        (
            "output_tokens_details",
            JsValue::object([("reasoning_tokens", 0.0.into())]),
        ),
        ("total_tokens", total),
    ])
}

/// `ResponsesRender`: what the route knows that the stream does not.
#[derive(Debug, Clone)]
pub struct ResponsesRender {
    pub request_id: String,
    /// `Math.floor(now / 1000)` at the request's start.
    pub created: i64,
    /// Tools the client declared freeform.
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
    id: Text,
    kind: Kind,
    text: Text,
    tool_name: Text,
    call_id: Text,
    /// A native item's `type`; its payload is `{ type, ...native }`.
    block_type: String,
    native: JsValue,
}

/// `customToolInput`: the program inside `{"input": "<program>"}`, else raw.
fn custom_tool_input(raw: &Text) -> Text {
    raw.with_json_source(|s| omni_ir::jsjson::parse_bounded(s, omni_ir::deep::depth_of(s)).ok())
        .and_then(|parsed| parsed.get("input").and_then(JsValue::as_text))
        .unwrap_or_else(|| raw.clone())
}

/// `renderItem`, written straight into `out`.
fn write_item(item: &Item, status: &str, out: &mut String) {
    let done = status == "completed";
    let head = |t: &str, out: &mut String| {
        out.push_str(r#"{"id":"#);
        item.id.write_json(out);
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
                item.text.write_json(out);
                out.push_str(r#","annotations":[]}"#);
            }
            out.push_str("]}");
        }
        Kind::Reasoning => {
            head("reasoning", out);
            out.push_str(r#","summary":["#);
            if done && !item.text.is_empty() {
                out.push_str(r#"{"type":"summary_text","text":"#);
                item.text.write_json(out);
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
            item.call_id.write_json(out);
            out.push_str(r#","name":"#);
            item.tool_name.write_json(out);
            out.push_str(if custom {
                r#","input":"#
            } else {
                r#","arguments":"#
            });
            match (done, custom) {
                (false, _) => out.push_str(r#""""#),
                (true, false) => item.text.write_json(out),
                (true, true) => custom_tool_input(&item.text).write_json(out),
            }
            out.push('}');
        }
        Kind::Native => {
            omni_ir::jsjson::write_js_spread(
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
fn write_failure(code: &str, message: &Text, out: &mut String) {
    out.push_str(r#","error":{"code":"#);
    write_str(code, out);
    out.push_str(r#","message":"#);
    message.write_json(out);
    out.push('}');
}

/// `JSON.stringify(String(v ?? ""))`, without building the string for a
/// string value. A non-string summary is a malformed upstream and rare, so
/// that branch may allocate its `String()` form.
fn write_js_string(v: Option<&JsValue>, out: &mut String) {
    match v {
        None | Some(JsValue::Null) => out.push_str(r#""""#),
        Some(JsValue::String(s)) => omni_ir::jsjson::write_utf16(s, out),
        some => omni_ir::jsjson::coerce_text(some)
            .unwrap_or_default()
            .write_json(out),
    }
}

/// How a native `merge` payload reaches the open item.
enum Merge {
    /// Read from the borrowed event and copied.
    Borrowed,
    /// Taken out of an event the caller gave up.
    Moved(JsValue),
}

/// The Responses stream encoder, one event at a time.
pub struct ResponsesStream {
    render: ResponsesRender,
    model: Text,
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
    fn text(&mut self, k: &str, v: &Text) -> &mut Self {
        v.write_json(self.key(k));
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
            model: Text::default(),
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
        self.model.write_json(out);
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
        call_id: &Text,
        tool_name: &Text,
        block_type: &str,
        native: JsValue,
    ) {
        let output_index = self.next_output_index;
        self.next_output_index += 1;
        let id = if call_id.is_empty() {
            Text::from(format!(
                "{}_{}_{output_index}",
                kind.prefix(),
                self.render.request_id
            ))
        } else {
            call_id.surrounded(&format!("{}_", kind.prefix()), "")
        };
        self.open = Some(Item {
            ir_index,
            output_index,
            id,
            kind,
            text: Text::default(),
            tool_name: tool_name.clone(),
            call_id: call_id.clone(),
            block_type: block_type.to_string(),
            native,
        });
    }

    fn close_current(&mut self, out: &mut String) {
        let Some(item) = self.open.take() else {
            return;
        };
        let (id, oi) = (&item.id, item.output_index);
        match item.kind {
            Kind::Message => {
                self.frame("response.output_text.done", out, |f| {
                    f.text("item_id", id)
                        .num("output_index", oi)
                        .num("content_index", 0);
                    f.text("text", &item.text);
                });
                self.frame("response.content_part.done", out, |f| {
                    f.text("item_id", id)
                        .num("output_index", oi)
                        .num("content_index", 0);
                    let out = f.key("part");
                    out.push_str(r#"{"type":"output_text","text":"#);
                    item.text.write_json(out);
                    out.push_str(r#","annotations":[]}"#);
                });
            }
            Kind::Reasoning => {
                self.frame("response.reasoning_summary_text.done", out, |f| {
                    f.text("item_id", id)
                        .num("output_index", oi)
                        .num("summary_index", 0);
                    f.text("text", &item.text);
                });
                self.frame("response.reasoning_summary_part.done", out, |f| {
                    f.text("item_id", id)
                        .num("output_index", oi)
                        .num("summary_index", 0);
                    let out = f.key("part");
                    out.push_str(r#"{"type":"summary_text","text":"#);
                    item.text.write_json(out);
                    out.push('}');
                });
            }
            Kind::FunctionCall => {
                self.frame("response.function_call_arguments.done", out, |f| {
                    f.text("item_id", id).num("output_index", oi);
                    f.text("arguments", &item.text);
                });
            }
            Kind::CustomToolCall => {
                let input = custom_tool_input(&item.text);
                self.frame("response.custom_tool_call_input.delta", out, |f| {
                    f.text("item_id", id)
                        .num("output_index", oi)
                        .text("delta", &input);
                });
                self.frame("response.custom_tool_call_input.done", out, |f| {
                    f.text("item_id", id)
                        .num("output_index", oi)
                        .text("input", &input);
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
    pub fn push_owned(&mut self, event: StreamEvent, out: &mut String) {
        if event.has_json_payload() {
            return omni_ir::deep::scope(|| self.push_owned_inner(event, out));
        }
        self.push_owned_inner(event, out);
    }
    fn push_owned_inner(&mut self, mut event: StreamEvent, out: &mut String) {
        let merge = match &mut event {
            StreamEvent::BlockDelta {
                delta:
                    Delta::ProviderNative {
                        fold: Some(NativeFold::Merge),
                        data,
                        ..
                    },
                ..
            } => Some(std::mem::replace(data, JsValue::Null)),
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
            let id = &item.id;
            self.frame("response.reasoning_summary_text.delta", out, |f| {
                f.text("item_id", id)
                    .num("output_index", oi)
                    .num("summary_index", 0);
                write_js_string(text, f.key("delta"));
            });
        }
        let mut item = item;
        if *fold == Some(NativeFold::Merge) {
            match merge {
                Merge::Moved(moved) => item.native.extend_object(moved),
                // A borrowed event has to be copied to be kept; `push_owned`
                // moves it instead.
                Merge::Borrowed => item.native.extend_object(data.clone()),
            }
        }
        self.open = Some(item);
    }

    /// The open item's retained native payload (diagnostics and tests).
    pub fn open_native(&self) -> Option<&JsValue> {
        self.open.as_ref().map(|o| &o.native)
    }

    pub fn push(&mut self, event: &StreamEvent, out: &mut String) {
        if event.has_json_payload() {
            return omni_ir::deep::scope(|| self.push_inner(event, out));
        }
        self.push_inner(event, out);
    }
    fn push_inner(&mut self, event: &StreamEvent, out: &mut String) {
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
                let empty = Text::default();
                let empty_object = || JsValue::Object(Vec::new());
                match block {
                    ContentBlockStart::Text => {
                        self.open_item(*index, Kind::Message, &empty, &empty, "", empty_object());
                    }
                    ContentBlockStart::Thinking { .. } => {
                        self.open_item(*index, Kind::Reasoning, &empty, &empty, "", empty_object());
                    }
                    ContentBlockStart::ToolUse { id, name } => {
                        let kind = if name
                            .as_utf8()
                            .is_some_and(|n| self.render.custom_tool_names.contains(n))
                        {
                            Kind::CustomToolCall
                        } else {
                            Kind::FunctionCall
                        };
                        self.open_item(*index, kind, id, name, "", empty_object());
                    }
                    ContentBlockStart::ProviderNative {
                        block_type, data, ..
                    } => {
                        self.open_item(
                            *index,
                            Kind::Native,
                            &empty,
                            &empty,
                            block_type,
                            data.clone(),
                        );
                    }
                }
                let Some(item) = self.open.take() else {
                    return;
                };
                let (id, oi) = (&item.id, item.output_index);
                self.frame("response.output_item.added", out, |f| {
                    f.num("output_index", oi);
                    write_item(&item, "in_progress", f.key("item"));
                });
                match item.kind {
                    Kind::Message => self.frame("response.content_part.added", out, |f| {
                        f.text("item_id", id)
                            .num("output_index", oi)
                            .num("content_index", 0);
                        f.key("part")
                            .push_str(r#"{"type":"output_text","text":"","annotations":[]}"#);
                    }),
                    Kind::Reasoning => {
                        self.frame("response.reasoning_summary_part.added", out, |f| {
                            f.text("item_id", id)
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
                        item.text.push(text);
                        let id = &item.id;
                        self.frame("response.output_text.delta", out, |f| {
                            f.text("item_id", id)
                                .num("output_index", oi)
                                .num("content_index", 0);
                            f.text("delta", text);
                        });
                    }
                    Delta::Thinking { text } if kind == Kind::Reasoning => {
                        item.text.push(text);
                        let id = &item.id;
                        self.frame("response.reasoning_summary_text.delta", out, |f| {
                            f.text("item_id", id)
                                .num("output_index", oi)
                                .num("summary_index", 0);
                            f.text("delta", text);
                        });
                    }
                    Delta::ToolJson { partial } => {
                        item.text.push(partial);
                        if kind == Kind::FunctionCall {
                            let id = &item.id;
                            self.frame("response.function_call_arguments.delta", out, |f| {
                                f.text("item_id", id).num("output_index", oi);
                                f.text("delta", partial);
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
                    write_js_value(&usage_value(usage), out);
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
                    &"stream closed before response.completed".into(),
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
pub fn response(collected: &CollectedResponse, render: &ResponsesRender) -> JsValue {
    let mut out = String::new();
    write_response(collected, render, &mut out);
    // Our own output, which can contain literal escaped surrogate units.
    omni_ir::jsjson::parse_js(&out).expect("rendered Responses JSON")
}

/// `responsesResponse`, written as the bytes `JSON.stringify` produces.
pub(crate) fn write_response(
    collected: &CollectedResponse,
    render: &ResponsesRender,
    out: &mut String,
) {
    let rid = &render.request_id;
    let mut s = ResponsesStream::new(render.clone());
    s.model.clone_from(&collected.model);
    for (i, block) in collected.content.iter().enumerate() {
        let oi = u32::try_from(i).unwrap_or(u32::MAX);
        let empty = Text::default();
        let item = |kind, id: Text, text: Text, tool_name: &Text, call_id: &Text| Item {
            ir_index: oi,
            output_index: oi,
            id,
            kind,
            text,
            tool_name: tool_name.clone(),
            call_id: call_id.clone(),
            block_type: String::new(),
            native: JsValue::Object(Vec::new()),
        };
        let rendered = match block {
            CollectedBlock::Text { text, .. } => item(
                Kind::Message,
                format!("msg_{rid}_{oi}").into(),
                text.clone(),
                &empty,
                &empty,
            ),
            CollectedBlock::Thinking { text, .. } => item(
                Kind::Reasoning,
                format!("rs_{rid}_{oi}").into(),
                text.clone(),
                &empty,
                &empty,
            ),
            CollectedBlock::ToolUse { id, name, input } => {
                let custom = name
                    .as_utf8()
                    .is_some_and(|name| render.custom_tool_names.contains(name));
                item(
                    if custom {
                        Kind::CustomToolCall
                    } else {
                        Kind::FunctionCall
                    },
                    id.surrounded(if custom { "ctc_" } else { "fc_" }, ""),
                    omni_ir::jsjson::render(input).into(),
                    name,
                    id,
                )
            }
            CollectedBlock::ProviderNative {
                provider,
                data,
                block_type,
            } if provider == "openai" => {
                if !s.output.is_empty() {
                    s.output.push(',');
                }
                omni_ir::jsjson::write_js_spread(
                    data,
                    "type",
                    block_type,
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
            write_js_value(&usage_value(&collected.usage), out);
        },
        out,
    );
}

/// `responsesErrorBody`.
pub fn error_body(code: ErrorCode, message: &Text) -> JsValue {
    let (t, c) = error_type(code);
    JsValue::object([(
        "error",
        JsValue::object([
            ("type", t.into()),
            ("code", c.into()),
            ("message", message.into()),
            ("param", JsValue::Null),
        ]),
    )])
}
