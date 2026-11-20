//! Aggregate retained response limits, checked before buffering/rendering.
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::jsjson::JsValue;
use omni_ir::stream::{ContentBlockStart, Delta, StreamEvent};

#[derive(Default)]
pub(crate) struct OutputBudget {
    bytes: usize,
    events: usize,
    items: usize,
}

impl OutputBudget {
    pub(crate) fn charge(&mut self, event: &StreamEvent) -> Result<(), GatewayError> {
        let bytes = match event {
            StreamEvent::Start { id, model } => id.len().saturating_add(model.len()),
            StreamEvent::BlockStart { block, .. } => {
                self.items += 1;
                match block {
                    ContentBlockStart::ToolUse { id, name } => id.len().saturating_add(name.len()),
                    ContentBlockStart::ProviderNative { data, .. } => js_bytes(data),
                    _ => 0,
                }
            }
            StreamEvent::BlockDelta { delta, .. } => match delta {
                Delta::Text { text } | Delta::Thinking { text } => text.len(),
                Delta::ThinkingSignature { signature } => signature.len(),
                Delta::ToolJson { partial } | Delta::ProviderNativeJson { partial, .. } => {
                    partial.len()
                }
                Delta::ProviderNative { data, .. } => js_bytes(data),
            },
            StreamEvent::Error { message, .. } => message.len(),
            StreamEvent::End { usage, vendor, .. } => {
                let raw = [&usage.raw_output_tokens, &usage.raw_cache_read_tokens];
                raw.into_iter()
                    .filter_map(Option::as_deref)
                    .map(js_bytes)
                    .sum::<usize>()
                    .saturating_add(vendor.as_ref().map_or(0, map_bytes))
            }
            _ => 0,
        };
        self.bytes = self.bytes.saturating_add(bytes);
        self.events += 1;
        if self.bytes > 8 * 1024 * 1024 || self.events > 65_536 || self.items > 4096 {
            return Err(limit());
        }
        Ok(())
    }
}

fn js_bytes(root: &JsValue) -> usize {
    let mut bytes = 0usize;
    let mut stack: Vec<Box<dyn Iterator<Item = (&JsValue, usize)>>> =
        vec![Box::new(std::iter::once((root, 0)))];
    while let Some(iter) = stack.last_mut() {
        if let Some((value, key_bytes)) = iter.next() {
            bytes = bytes
                .saturating_add(std::mem::size_of::<JsValue>())
                .saturating_add(key_bytes);
            match value {
                JsValue::String(s) => bytes = bytes.saturating_add(s.len().saturating_mul(6)),
                JsValue::Array(a) => stack.push(Box::new(a.iter().map(|v| (v, 0)))),
                JsValue::Object(o) => stack.push(Box::new(
                    o.iter().map(|(k, v)| (v, k.len().saturating_mul(6))),
                )),
                _ => {}
            }
            if bytes > 8 * 1024 * 1024 {
                break;
            }
        } else {
            stack.pop();
        }
    }
    bytes
}

fn map_bytes(map: &serde_json::Map<String, serde_json::Value>) -> usize {
    // Iterators retain O(depth) traversal state, never one slot per sibling.
    let mut bytes = map.keys().map(String::len).sum::<usize>();
    let mut stack: Vec<Box<dyn Iterator<Item = &serde_json::Value>>> = vec![Box::new(map.values())];
    while let Some(iter) = stack.last_mut() {
        if let Some(value) = iter.next() {
            bytes = bytes.saturating_add(std::mem::size_of::<serde_json::Value>());
            match value {
                serde_json::Value::String(s) => bytes = bytes.saturating_add(s.len()),
                serde_json::Value::Array(a) => stack.push(Box::new(a.iter())),
                serde_json::Value::Object(m) => {
                    bytes = bytes.saturating_add(m.keys().map(String::len).sum::<usize>());
                    stack.push(Box::new(m.values()));
                }
                _ => {}
            }
            if bytes > 8 * 1024 * 1024 {
                return bytes;
            }
        } else {
            stack.pop();
        }
    }
    bytes
}

fn limit() -> GatewayError {
    GatewayError::new(ErrorCode::Upstream, "retained response budget exceeded")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bytes_and_many_small_events_are_bounded() {
        let mut b = OutputBudget::default();
        let event = StreamEvent::BlockDelta {
            index: 0,
            delta: Delta::Text {
                text: "x".repeat(1024).into(),
            },
        };
        for _ in 0..8192 {
            b.charge(&event).expect("exact byte limit");
        }
        assert!(b.charge(&event).is_err());
        let mut b = OutputBudget::default();
        for _ in 0..65_536 {
            b.charge(&StreamEvent::BlockEnd { index: 0 })
                .expect("exact event limit");
        }
        assert!(b.charge(&StreamEvent::BlockEnd { index: 0 }).is_err());
        let mut b = OutputBudget::default();
        let event = StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        };
        for _ in 0..4096 {
            b.charge(&event).expect("exact item limit");
        }
        assert!(b.charge(&event).is_err());
    }
}
