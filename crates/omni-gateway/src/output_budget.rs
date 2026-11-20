//! Aggregate retained response limits, checked before buffering/rendering.
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::jsjson::JsValue;
use omni_ir::stream::{ContentBlockStart, Delta, StreamEvent};

const MAX_BYTES: usize = 8 * 1024 * 1024;

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
        if self.bytes > MAX_BYTES || self.events > 65_536 || self.items > 4096 {
            return Err(limit());
        }
        Ok(())
    }
}

fn js_bytes(root: &JsValue) -> usize {
    // Match the old map charge: keys and each contained value, not the root
    // map wrapper. Keep just an iterator per level, not a stack of siblings.
    let mut bytes = 0usize;
    type Entries<'a> = Box<dyn Iterator<Item = (&'a JsValue, &'a [u16])> + 'a>;
    let mut stack: Vec<Entries<'_>> = match root {
        JsValue::Object(o) => vec![Box::new(o.iter().map(|(k, v)| (v, k.as_slice())))],
        _ => vec![Box::new(std::iter::once((root, &[][..])))],
    };
    while let Some(iter) = stack.last_mut() {
        if let Some((value, key)) = iter.next() {
            bytes += std::mem::size_of::<serde_json::Value>();
            charge_text(key, &mut bytes);
            if bytes > MAX_BYTES {
                break;
            }
            match value {
                JsValue::String(s) => charge_text(s, &mut bytes),
                JsValue::Array(a) => stack.push(Box::new(a.iter().map(|v| (v, &[][..])))),
                JsValue::Object(o) => {
                    stack.push(Box::new(o.iter().map(|(k, v)| (v, k.as_slice()))))
                }
                _ => {}
            }
            if bytes > MAX_BYTES {
                break;
            }
        } else {
            stack.pop();
        }
    }
    bytes
}

fn charge_text(units: &[u16], bytes: &mut usize) {
    for unit in char::decode_utf16(units.iter().copied()) {
        // Keep the ordinary UTF-8 charge; a lone unit is emitted as \uXXXX.
        *bytes += unit.map_or(6, char::len_utf8);
        if *bytes > MAX_BYTES {
            break;
        }
    }
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
            if bytes > MAX_BYTES {
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
    fn native_reasoning_charges_utf8_bytes_not_six_bytes_per_unit() {
        let event = StreamEvent::BlockDelta {
            index: 0,
            delta: Delta::ProviderNative {
                provider: "openai".into(),
                delta_type: "response.output_item.done".into(),
                fold: Some(omni_ir::stream::NativeFold::Merge),
                data: JsValue::object([(
                    "encrypted_content",
                    JsValue::String(vec![u16::from(b'x'); 2 * 1024 * 1024]),
                )]),
            },
        };
        let mut budget = OutputBudget::default();
        for _ in 0..3 {
            budget.charge(&event).expect("ordinary native payload fits");
        }
        assert!(
            budget.charge(&event).is_err(),
            "aggregate native budget exceeded"
        );
    }

    #[test]
    fn native_keys_and_values_charge_pairs_and_lone_units_by_emitted_width() {
        // A (1), é (2), 水 (3), 😀 (4), lone low surrogate (6).
        let units = vec![0x41, 0xe9, 0x6c34, 0xd83d, 0xde00, 0xdc00];
        let data = JsValue::Object(vec![(units.clone(), JsValue::String(units))]);
        assert_eq!(
            js_bytes(&data),
            32 + std::mem::size_of::<serde_json::Value>()
        );
    }

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
