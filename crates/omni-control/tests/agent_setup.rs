//! Reader contract for `omni_control::setup::agent_setup`.
use omni_control::setup::agent_setup;
use omni_store::SqliteStore;
use serde_json::{Value, json};

const BASE_URL: &str = "https://gateway.example/v1/V1///";

fn store() -> SqliteStore {
    let store = SqliteStore::open(":memory:", 0).expect("store");
    store
        .connection()
        .execute_batch(
            r#"
            INSERT INTO credentials(id, provider, label, auth_type, api_key, created_at, updated_at)
            VALUES ('api', 'openai', 'api', 'apiKey', 'do-not-read', 1, 1),
                   ('oauth', 'openai', 'oauth', 'oauth', NULL, 1, 1);
            INSERT INTO virtual_models(id, targets, strategy, is_alias) VALUES
              ('opus', '[{"provider":"openai","model":"gpt-6-astra"}]', 'weighted', 0),
              ('sonnet', '[{"provider":"openai","model":"gpt-6-astra","credentialId":"api"}]', 'weighted', 0),
              ('haiku', '[{"provider":"unknown","model":"unlisted","maxOutputTokens":1000}]', 'weighted', 0),
              ('unused', '[]', 'weighted', 0);
            "#,
        )
        .expect("fixture");
    store
}

fn response(query: &str) -> Value {
    serde_json::from_str(&agent_setup(&store(), BASE_URL, query).expect("agent setup"))
        .expect("response JSON")
}

#[test]
fn claude_fallback_renders_explicit_mappings_and_only_a_placeholder_key() {
    let body = response(
        "client=OpenCode&defaultModel=opus&fableModel=opus&opusModel=opus&sonnetModel=sonnet&haikuModel=&apiKey=not-for-rendering",
    );
    assert_eq!(
        body,
        json!({"client": "claude", "files": [{"path": "settings.json", "contents": r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "https://gateway.example/v1/V1///",
    "ANTHROPIC_AUTH_TOKEN": "<your OmniGateway key>",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_MODEL": "opus",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "opus",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet"
  }
}
"#}]}),
    );
}

#[test]
fn opencode_deduplicates_in_mapping_order_and_describes_only_selected_models() {
    let body = response(
        "client=opencode&defaultModel=%6Fpus&fableModel=opus&sonnetModel=sonnet&haikuModel=haiku",
    );
    assert_eq!(
        body,
        json!({"client": "opencode", "files": [{"path": "opencode.json", "contents": r#"{
  "$schema": "https://opencode.ai/config.json",
  "model": "omnigateway/opus",
  "provider": {
    "omnigateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniGateway",
      "options": {
        "baseURL": "https://gateway.example/v1",
        "apiKey": "<your OmniGateway key>"
      },
      "models": {
        "opus": {
          "name": "GPT-6 Astra",
          "limit": {
            "context": 272000,
            "output": 128000
          }
        },
        "sonnet": {
          "name": "GPT-6 Astra",
          "limit": {
            "context": 922000,
            "output": 128000
          }
        },
        "haiku": {
          "name": "haiku"
        }
      }
    }
  }
}
"#}]}),
    );
}

#[test]
fn missing_or_stale_mappings_are_bad_requests() {
    let store = store();
    for (query, message) in [
        ("", "defaultModel is required for claude setup"),
        (
            "client=opencode&defaultModel=",
            "defaultModel is required for opencode setup",
        ),
        (
            "client=claude&defaultModel=missing",
            "defaultModel names unknown virtual model \"missing\"",
        ),
        (
            "client=opencode&defaultModel=opus&haikuModel=missing",
            "haikuModel names unknown virtual model \"missing\"",
        ),
    ] {
        let error = agent_setup(&store, BASE_URL, query).expect_err(query);
        assert_eq!(error.code, Some("BAD_REQUEST"), "{query}");
        assert_eq!(error.message, message, "{query}");
    }
}
