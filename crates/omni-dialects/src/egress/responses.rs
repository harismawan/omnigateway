//! OpenAI Responses egress: `egress/responses.ts`.

use std::collections::HashSet;

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
    native: Map<String, Value>,
}

/// `customToolInput`: the program inside `{"input": "<program>"}`, else raw.
fn custom_tool_input(raw: &str) -> String {
    if let Some(Value::Object(m)) = omni_ir::js::parse_json(raw)
        && let Some(Value::String(inner)) = m.get("input")
    {
        return inner.clone();
    }
    raw.to_string()
}

/// `renderItem`.
fn render_item(item: &Item, status: &str) -> Value {
    let done = status == "completed";
    match item.kind {
        Kind::Message => json!({
            "id": item.id,
            "type": "message",
            "status": status,
            "role": "assistant",
            "content": if done {
                json!([{ "type": "output_text", "text": item.text, "annotations": [] }])
            } else {
                json!([])
            },
        }),
        Kind::Reasoning => json!({
            "id": item.id,
            "type": "reasoning",
            "status": status,
            "summary": if done && !item.text.is_empty() {
                json!([{ "type": "summary_text", "text": item.text }])
            } else {
                json!([])
            },
        }),
        Kind::FunctionCall => json!({
            "id": item.id,
            "type": "function_call",
            "status": status,
            "call_id": item.call_id,
            "name": item.tool_name,
            "arguments": if done { item.text.as_str() } else { "" },
        }),
        Kind::CustomToolCall => json!({
            "id": item.id,
            "type": "custom_tool_call",
            "status": status,
            "call_id": item.call_id,
            "name": item.tool_name,
            "input": if done { custom_tool_input(&item.text) } else { String::new() },
        }),
        Kind::Native => Value::Object(item.native.clone()),
    }
}

/// `{ type, ...data }`.
fn native_of(block_type: &str, data: &Map<String, Value>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("type".into(), Value::String(block_type.into()));
    for (k, v) in data {
        m.insert(k.clone(), v.clone());
    }
    m
}

/// `responsesStream`, one event at a time.
pub struct ResponsesStream {
    render: ResponsesRender,
    model: String,
    sequence: u64,
    terminated: bool,
    output: Vec<Value>,
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
    fn value(&mut self, k: &str, v: &Value) -> &mut Self {
        let out = self.key(k);
        write_value(v, out);
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
            output: Vec::new(),
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

    /// `snapshot(status, extra)`.
    fn snapshot(&self, status: &str, extra: &[(&str, Value)]) -> Value {
        let mut m = Map::new();
        m.insert(
            "id".into(),
            Value::String(format!("resp_{}", self.render.request_id)),
        );
        m.insert("object".into(), "response".into());
        #[allow(clippy::cast_precision_loss)]
        m.insert("created_at".into(), number(self.render.created as f64));
        m.insert("status".into(), status.into());
        m.insert("model".into(), self.model.as_str().into());
        m.insert("output".into(), Value::Array(self.output.clone()));
        for (k, v) in extra {
            m.insert((*k).to_string(), v.clone());
        }
        Value::Object(m)
    }

    fn open_item(
        &mut self,
        ir_index: u32,
        kind: Kind,
        call_id: &str,
        tool_name: &str,
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
                let part = json!({ "type": "output_text", "text": item.text, "annotations": [] });
                self.frame("response.content_part.done", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .num("content_index", 0);
                    f.value("part", &part);
                });
            }
            Kind::Reasoning => {
                self.frame("response.reasoning_summary_text.done", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .num("summary_index", 0);
                    f.str("text", &item.text);
                });
                let part = json!({ "type": "summary_text", "text": item.text });
                self.frame("response.reasoning_summary_part.done", out, |f| {
                    f.str("item_id", id)
                        .num("output_index", oi)
                        .num("summary_index", 0);
                    f.value("part", &part);
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
        let body = render_item(&item, "completed");
        self.frame("response.output_item.done", out, |f| {
            f.num("output_index", oi).value("item", &body);
        });
        self.output.push(body);
    }

    pub fn push(&mut self, event: &StreamEvent, out: &mut String) {
        match event {
            StreamEvent::Start { model, .. } => {
                self.model.clone_from(model);
                for name in ["response.created", "response.in_progress"] {
                    let snap = self.snapshot("in_progress", &[]);
                    self.frame(name, out, |f| {
                        f.value("response", &snap);
                    });
                }
            }
            StreamEvent::BlockStart { index, block } => {
                if self.open.as_ref().is_some_and(|o| o.ir_index == *index) {
                    return;
                }
                self.close_current(out);
                match block {
                    ContentBlockStart::Text => {
                        self.open_item(*index, Kind::Message, "", "", Map::new());
                    }
                    ContentBlockStart::Thinking { .. } => {
                        self.open_item(*index, Kind::Reasoning, "", "", Map::new());
                    }
                    ContentBlockStart::ToolUse { id, name } => {
                        let kind = if self.render.custom_tool_names.contains(name) {
                            Kind::CustomToolCall
                        } else {
                            Kind::FunctionCall
                        };
                        self.open_item(*index, kind, id, name, Map::new());
                    }
                    ContentBlockStart::ProviderNative {
                        block_type, data, ..
                    } => {
                        self.open_item(*index, Kind::Native, "", "", native_of(block_type, data));
                    }
                }
                let Some(item) = self.open.take() else {
                    return;
                };
                let body = render_item(&item, "in_progress");
                let (id, oi) = (item.id.as_str(), item.output_index);
                self.frame("response.output_item.added", out, |f| {
                    f.num("output_index", oi).value("item", &body);
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
                    Delta::ProviderNative {
                        delta_type,
                        fold,
                        data,
                        ..
                    } if kind == Kind::Native => {
                        if delta_type == "reasoning_summary_text.delta" {
                            let text = match data.get("text") {
                                None | Some(Value::Null) => String::new(),
                                some => omni_ir::js::to_string(some),
                            };
                            let id = item.id.as_str();
                            self.frame("response.reasoning_summary_text.delta", out, |f| {
                                f.str("item_id", id)
                                    .num("output_index", oi)
                                    .num("summary_index", 0);
                                f.str("delta", &text);
                            });
                        }
                        if *fold == Some(NativeFold::Merge) {
                            for (k, v) in data {
                                item.native.insert(k.clone(), v.clone());
                            }
                        }
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
                let mut extra = Vec::with_capacity(2);
                if let Some(reason) = reason {
                    extra.push(("incomplete_details", json!({ "reason": reason })));
                }
                extra.push(("usage", usage_value(usage)));
                let snap = self.snapshot(status, &extra);
                let name = if status == "completed" {
                    "response.completed"
                } else {
                    "response.incomplete"
                };
                self.frame(name, out, |f| {
                    f.value("response", &snap);
                });
            }
            StreamEvent::Error { code, message, .. } => {
                self.close_current(out);
                self.terminated = true;
                let error = json!({ "code": error_type(*code).1, "message": message });
                let snap = self.snapshot("failed", &[("error", error)]);
                self.frame("response.failed", out, |f| {
                    f.value("response", &snap);
                });
            }
        }
    }

    pub fn finish(&mut self, out: &mut String) {
        if !self.terminated {
            self.close_current(out);
            let error = json!({
                "code": "stream_disconnected",
                "message": "stream closed before response.completed",
            });
            let snap = self.snapshot("failed", &[("error", error)]);
            self.frame("response.failed", out, |f| {
                f.value("response", &snap);
            });
        }
        begin_frame("message", out);
        out.push_str("[DONE]");
        end_frame(out);
    }
}

/// `responsesResponse`.
pub fn response(collected: &CollectedResponse, render: &ResponsesRender) -> Value {
    let rid = &render.request_id;
    let mut output = Vec::new();
    for (i, block) in collected.content.iter().enumerate() {
        let oi = u32::try_from(i).unwrap_or(u32::MAX);
        let item = |kind, id: String, text: String, tool_name: &str, call_id: &str, native| Item {
            ir_index: oi,
            output_index: oi,
            id,
            kind,
            text,
            tool_name: tool_name.to_string(),
            call_id: call_id.to_string(),
            native,
        };
        let rendered = match block {
            ContentBlock::Text(t) => Some(item(
                Kind::Message,
                format!("msg_{rid}_{oi}"),
                t.text.clone(),
                "",
                "",
                Map::new(),
            )),
            ContentBlock::Thinking(t) => Some(item(
                Kind::Reasoning,
                format!("rs_{rid}_{oi}"),
                t.text.clone(),
                "",
                "",
                Map::new(),
            )),
            ContentBlock::ToolUse(t) => {
                let custom = render.custom_tool_names.contains(&t.name);
                Some(item(
                    if custom {
                        Kind::CustomToolCall
                    } else {
                        Kind::FunctionCall
                    },
                    format!("{}_{}", if custom { "ctc" } else { "fc" }, t.id),
                    omni_ir::jsjson::to_string(&t.input),
                    &t.name,
                    &t.id,
                    Map::new(),
                ))
            }
            ContentBlock::ProviderNative(n) if n.provider == "openai" => Some(item(
                Kind::Native,
                format!("item_{rid}_{oi}"),
                String::new(),
                "",
                "",
                native_of(&n.block_type, &n.data),
            )),
            _ => None,
        };
        if let Some(it) = rendered {
            output.push(render_item(&it, "completed"));
        }
    }
    let (status, reason) = status(collected.stop_reason);
    let mut m = Map::new();
    m.insert("id".into(), Value::String(format!("resp_{rid}")));
    m.insert("object".into(), "response".into());
    #[allow(clippy::cast_precision_loss)]
    m.insert("created_at".into(), number(render.created as f64));
    m.insert("status".into(), status.into());
    m.insert("model".into(), collected.model.as_str().into());
    m.insert("output".into(), Value::Array(output));
    m.insert("store".into(), Value::Bool(false));
    if let Some(reason) = reason {
        m.insert("incomplete_details".into(), json!({ "reason": reason }));
    }
    m.insert("usage".into(), usage_value(&collected.usage));
    Value::Object(m)
}

/// `responsesErrorBody`.
pub fn error_body(code: ErrorCode, message: &str) -> Value {
    let (t, c) = error_type(code);
    json!({ "error": { "type": t, "code": c, "message": message, "param": null } })
}
