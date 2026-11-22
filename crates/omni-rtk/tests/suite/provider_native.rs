//! Regression suite: provider-native blocks stay byte-identical and never
//! block neighbouring compression.

use super::common::*;
use omni_rtk::transform_request;
use serde_json::json;

fn noisy() -> String {
    join(&gen_lines(400, |i| {
        format!("2026-08-11T00:00:0{}Z INFO same line", i % 10)
    }))
}

#[test]
fn a_provider_native_server_tool_result_is_left_byte_identical() {
    let noisy = noisy();
    let request = req(json!({
        "model": "fast", "stream": false,
        "messages": [{
            "role": "assistant",
            "content": [
                {"type": "providerNative", "provider": "anthropic", "blockType": "server_tool_use",
                 "data": {"id": "srvtoolu_1", "name": "web_search", "input": {"query": "logs"}}},
                {"type": "providerNative", "provider": "anthropic", "blockType": "web_search_tool_result",
                 "data": {"tool_use_id": "srvtoolu_1",
                          "content": [{"type": "web_search_result", "url": "u", "encrypted_content": noisy}]}},
            ],
        }],
    }));
    let before = request.messages.clone();
    let result = transform_request(&request, &ENABLED);
    assert_eq!(result.request.messages, before);
    assert!(result.report.filters.is_empty());
}

#[test]
fn a_provider_native_block_beside_a_compressible_custom_result_does_not_block_compression() {
    let noisy = noisy();
    let request = req(json!({
        "model": "fast", "stream": false,
        "messages": [
            {"role": "assistant", "content": [
                {"type": "providerNative", "provider": "anthropic", "blockType": "server_tool_use",
                 "data": {"id": "srvtoolu_1", "name": "web_search", "input": {}}},
                {"type": "toolUse", "id": "call", "name": "Bash", "input": {"command": "cat app.log"}},
            ]},
            {"role": "user", "content": [{"type": "toolResult", "toolUseId": "call", "content": noisy}]},
        ],
    }));
    let result = transform_request(&request, &ENABLED);
    assert_eq!(
        result.request.messages[0].content[0],
        request.messages[0].content[0]
    );
    assert!(utf16_len(&result_content(&result.request, 1, 0)) < utf16_len(&noisy));
}

#[test]
fn a_provider_native_block_in_the_message_being_rewritten_is_untouched() {
    let noisy = noisy();
    let request = req(json!({
        "model": "fast", "stream": false,
        "messages": [
            {"role": "assistant", "content": [
                {"type": "toolUse", "id": "call", "name": "Bash", "input": {"command": "cat app.log"}},
            ]},
            {"role": "user", "content": [
                {"type": "providerNative", "provider": "anthropic", "blockType": "web_search_tool_result",
                 "data": {"tool_use_id": "srvtoolu_1",
                          "content": [{"type": "web_search_result", "url": "u", "encrypted_content": noisy}]}},
                {"type": "toolResult", "toolUseId": "call", "content": noisy},
            ]},
        ],
    }));
    let native = request.messages[1].content[0].clone();
    let result = transform_request(&request, &ENABLED);
    assert!(utf16_len(&result_content(&result.request, 1, 1)) < utf16_len(&noisy));
    assert_eq!(result.request.messages[1].content[0], native);
}
