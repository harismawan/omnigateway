//! The prompt-token estimate, mirroring `packages/ir/src/tokens.ts`.
//!
//! Never billed from. Routing reads it to price a request against each
//! target's cache-read and input rates. Lengths are UTF-16 code units, as JS
//! `string.length` counts them, and JSON payloads are measured as
//! `JSON.stringify` writes them.

use crate::js::utf16_len;
use crate::jsjson;
use crate::request::{ChatRequest, ContentBlock, Message, ProviderNativeBlock, ToolDef};
use serde_json::Value;

const CHARS_PER_TOKEN: usize = 4;
const IMAGE_TOKENS: f64 = 1_600.0;
const BLOCK_OVERHEAD: f64 = 4.0;
const MESSAGE_OVERHEAD: f64 = 4.0;

#[allow(clippy::cast_precision_loss)]
fn from_text(text: &str) -> f64 {
    utf16_len(text).div_ceil(CHARS_PER_TOKEN) as f64
}

fn from_json(value: &Value) -> f64 {
    from_text(&jsjson::to_string(value))
}

/// `JSON.stringify` length of a map, without copying it into a `Value`.
fn from_map(map: &serde_json::Map<String, Value>) -> f64 {
    let mut out = String::new();
    jsjson::write_map(map, &mut out);
    from_text(&out)
}

fn native_tokens(n: &ProviderNativeBlock) -> f64 {
    BLOCK_OVERHEAD + from_text(&n.block_type) + from_map(&n.data)
}

#[allow(clippy::cast_precision_loss)]
fn block_tokens(block: &ContentBlock) -> f64 {
    match block {
        ContentBlock::Text(b) => BLOCK_OVERHEAD + from_text(&b.text),
        ContentBlock::Image(_) => BLOCK_OVERHEAD + IMAGE_TOKENS,
        ContentBlock::Thinking(b) => BLOCK_OVERHEAD + from_text(&b.text),
        ContentBlock::ToolUse(b) => BLOCK_OVERHEAD + from_text(&b.name) + from_json(&b.input),
        ContentBlock::ToolResult(b) => {
            BLOCK_OVERHEAD
                + from_text(&b.tool_use_id)
                + from_text(&b.content)
                + b.images.as_ref().map_or(0, Vec::len) as f64 * IMAGE_TOKENS
                + b.files
                    .iter()
                    .flatten()
                    .map(|f| from_text(&f.data))
                    .sum::<f64>()
                + b.native.iter().flatten().map(native_tokens).sum::<f64>()
        }
        ContentBlock::ProviderNative(b) => native_tokens(b),
    }
}

fn message_tokens(message: &Message) -> f64 {
    MESSAGE_OVERHEAD + message.content.iter().map(block_tokens).sum::<f64>()
}

fn tool_tokens(tool: &ToolDef) -> f64 {
    match tool {
        ToolDef::Provider(t) => {
            BLOCK_OVERHEAD + from_text(&t.name) + from_text(&t.tool_type) + from_map(&t.wire)
        }
        ToolDef::Portable(t) => {
            BLOCK_OVERHEAD
                + from_text(&t.name)
                + from_text(t.description.as_deref().unwrap_or(""))
                + from_json(&t.input_schema)
        }
    }
}

fn tool_cache_marked(tool: &ToolDef) -> bool {
    match tool {
        ToolDef::Provider(t) => t.cache_control.is_some(),
        ToolDef::Portable(t) => t.cache_control.is_some(),
    }
}

/// `estimateInputTokens`.
pub fn estimate_input_tokens(request: &ChatRequest) -> f64 {
    request
        .system
        .iter()
        .flatten()
        .map(block_tokens)
        .sum::<f64>()
        + request.messages.iter().map(message_tokens).sum::<f64>()
        + request.tools.iter().flatten().map(tool_tokens).sum::<f64>()
}

/// `estimateCachedInputTokens`: the running total through the last block
/// carrying a cache breakpoint, in assembly order (tools, system, messages).
pub fn estimate_cached_input_tokens(request: &ChatRequest) -> f64 {
    let mut running = 0.0;
    let mut cached = 0.0;
    for tool in request.tools.iter().flatten() {
        running += tool_tokens(tool);
        if tool_cache_marked(tool) {
            cached = running;
        }
    }
    for block in request.system.iter().flatten() {
        running += block_tokens(block);
        if block.cache_control().is_some() {
            cached = running;
        }
    }
    for message in &request.messages {
        running += MESSAGE_OVERHEAD;
        for block in &message.content {
            running += block_tokens(block);
            if block.cache_control().is_some() {
                cached = running;
            }
            if let ContentBlock::ToolResult(b) = block {
                let inner = b.images.iter().flatten().any(|i| i.cache_control.is_some())
                    || b.native.iter().flatten().any(|n| n.cache_control.is_some());
                if inner {
                    cached = running;
                }
            }
        }
    }
    cached
}
