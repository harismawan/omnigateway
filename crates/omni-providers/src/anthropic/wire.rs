//! Anthropic wire content encoding. Request assembly is kept separate.
use super::cloak::ToolCloak;
use crate::tool_result_files::{split_files, with_file_text};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    request::ContentBlock,
};
use serde_json::{Value, json};

pub fn encode_block(block: &ContentBlock, cloak: &ToolCloak) -> Result<Value, GatewayError> {
    let mut value = match block {
        ContentBlock::Text(b) => {
            let mut v = json!({"type":"text","text":b.text});
            if let Some(c) = &b.citations {
                v["citations"] = json!(c);
            }
            v
        }
        ContentBlock::Image(b) => {
            json!({"type":"image","source":{"type":"base64","media_type":b.media_type,"data":b.data}})
        }
        ContentBlock::Thinking(b) => {
            let mut v = json!({"type":"thinking","thinking":b.text});
            if let Some(s) = &b.signature {
                v["signature"] = json!(s);
            }
            v
        }
        ContentBlock::ToolUse(b) => {
            json!({"type":"tool_use","id":b.id,"name":cloak.name(&b.name),"input":b.input})
        }
        ContentBlock::ProviderNative(b) => {
            if b.provider != "anthropic" {
                return Err(GatewayError::new(
                    ErrorCode::Internal,
                    format!(
                        "anthropic adapter received a {} provider-native block",
                        b.provider
                    ),
                ));
            }
            let mut v = Value::Object(b.data.clone());
            v["type"] = json!(b.block_type);
            v
        }
        ContentBlock::ToolResult(b) => {
            let files = split_files(b.files.as_deref().unwrap_or_default(), |t| {
                t == "application/pdf"
            });
            let text = with_file_text(&b.content, &files.text);
            let mut parts = Vec::new();
            for image in b.images.iter().flatten() {
                parts.push(encode_block(&ContentBlock::Image(image.clone()), cloak)?);
            }
            for file in files.carried {
                let mut doc = json!({"type":"document","source":{"type":"base64","media_type":file.media_type,"data":file.data}});
                if let Some(title) = &file.filename {
                    doc["title"] = json!(title);
                }
                parts.push(doc);
            }
            for native in b.native.iter().flatten() {
                parts.push(encode_block(
                    &ContentBlock::ProviderNative(native.clone()),
                    cloak,
                )?);
            }
            let content = if parts.is_empty() {
                Value::String(text)
            } else {
                if !text.is_empty() {
                    parts.insert(0, json!({"type":"text","text":text}));
                }
                Value::Array(parts)
            };
            let mut v = json!({"type":"tool_result","tool_use_id":b.tool_use_id,"content":content});
            if let Some(error) = b.is_error {
                v["is_error"] = json!(error);
            }
            v
        }
    };
    if let Some(cache) = block.cache_control() {
        value["cache_control"] = json!(cache);
    }
    Ok(value)
}
