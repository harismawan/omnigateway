//! Sends request cases read from stdin (one JSON object per line:
//! `{url, method, headers: [[n, v]...], body}`) through the Rust client and
//! prints each status. Used by `conformance/http/compare-wire.ts` to put the
//! Rust and TS clients' bytes side by side on the same listener.

use std::io::BufRead;

use omni_providers::http::{Client, HttpRequest};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let client = Client::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(case) = serde_json::from_str::<serde_json::Value>(&line) else {
            eprintln!("bad case: {line}");
            std::process::exit(2);
        };
        let text = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_string();
        let headers = case["headers"]
            .as_array()
            .map(|pairs| pairs.iter().map(|p| (text(&p[0]), text(&p[1]))).collect())
            .unwrap_or_default();
        let req = HttpRequest {
            provider: "custom".into(),
            url: text(&case["url"]),
            method: text(&case["method"]),
            headers,
            body: text(&case["body"]),
            body_encoding: None,
            request_id: None,
        };
        match client.send(req).await {
            Ok(res) => {
                let status = res.status;
                res.body.text().await.ok();
                println!("{status}");
            }
            Err(e) => println!("error: {e}"),
        }
    }
}
