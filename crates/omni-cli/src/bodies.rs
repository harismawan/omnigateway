use crate::observability::{Error, Flags, color, emit, fail, table, text, usage};
use serde_json::Value;
fn bytes(n: usize) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1048576 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / 1048576.0)
    }
}
fn payload(v: &Value) -> String {
    bytes(if v.is_null() {
        0
    } else {
        omni_ir::jsjson::to_string(v).len()
    })
}
fn block(flags: &Flags, heading: &str, value: &Value) -> String {
    format!(
        "{}\n{}",
        color(flags, "2", heading),
        if value.is_null() {
            "(nothing recorded for this half — it never happened, or never completed)".into()
        } else {
            omni_ir::jsjson::stringify_pretty(&omni_ir::jsjson::JsValue::from(value))
                .unwrap_or_default()
        }
    )
}
pub fn run(flags: &Flags, positional: &[String]) -> Result<(), Error> {
    let id = positional
        .first()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| usage("request id is required"))?;
    let ctx = crate::context::resolve(flags).map_err(fail)?;
    let key = omni_crypto::field::derive_key(&ctx.encryption_key().map_err(fail)?);
    let store = ctx.open().map_err(fail)?;
    let raw =
        omni_control::bodies::read_request_body(&store, &key, id).map_err(|e| fail(e.message))?;
    let read: Value = serde_json::from_str(&raw).map_err(fail)?;
    emit(flags, &read, || {
        let frame = format!(
            "STATE      {}\nCAPTURED   {}\nSIZE       {} on disk\nTRUNCATED  {}",
            text(&read["detailState"]),
            crate::output::time(&read["at"]),
            bytes(read["sizeBytes"].as_u64().unwrap_or(0) as usize),
            if read["truncated"] == true {
                "yes"
            } else {
                "no"
            }
        );
        let artifact = &read["artifact"];
        if artifact.is_null() {
            let (legend, message) = match read["detailState"].as_str() {
                Some("none") => (
                    "not captured",
                    "Body capture was not running for this request. It needs OMNI_BODY_LOGGING_ALLOWED in the environment and bodyLoggingEnabled turned on, and the calling key must not have opted out.",
                ),
                Some("missing") => (
                    "captured, then lost",
                    "This request was captured, but its artifact is no longer on disk. Retention or the row cap has since pruned it, or something removed the file underneath the gateway.",
                ),
                _ => (
                    "captured, but unreadable",
                    "This request was captured and the artifact is still on disk, but it failed its checksum or would not decrypt. Changing OMNI_ENCRYPTION_KEY invalidates every artifact written under the old one.",
                ),
            };
            return Ok(format!("{frame}\n\n{legend}\n{message}"));
        }
        let attempts = artifact["attempts"]
            .as_array()
            .ok_or_else(|| fail("invalid body attempts"))?;
        let frames = attempts.iter().any(|a| !a["streamChunks"].is_null());
        let label = |s: String, a: &Value| {
            if a["truncated"] == true {
                format!("{s} (truncated)")
            } else {
                s
            }
        };
        let mut headers = vec!["PAIR", "PROVIDER", "REQUEST", "RESPONSE"];
        if frames {
            headers.push("FRAMES")
        }
        headers.push("REQUEST IS");
        let mut client = vec![
            label("CLIENT".into(), &artifact["client"]),
            String::new(),
            payload(&artifact["client"]["request"]),
            payload(&artifact["client"]["response"]),
        ];
        if frames {
            client.push("—".into())
        }
        client.push("pre-RTK".into());
        let mut rows = vec![client];
        for a in attempts {
            let mut row = vec![
                label(format!("ATTEMPT {}", text(&a["attempt"])), a),
                crate::quota::provider(flags, &text(&a["provider"])),
                payload(&a["request"]),
                payload(&a["response"]),
            ];
            if frames {
                row.push(
                    a["streamChunks"]
                        .as_array()
                        .map_or("—".into(), |s| s.len().to_string()),
                )
            }
            row.push("post-RTK".into());
            rows.push(row);
        }
        let mut sections = vec![
            frame,
            table(&headers, rows, if frames { &[2, 3, 4] } else { &[2, 3] }),
            color(
                flags,
                "2",
                "REQUEST and RESPONSE are the stored payload, after masking and bounding; neither is the size sent over the wire",
            ),
        ];
        if !attempts.is_empty() {
            sections.push(color(flags,"2","the client request is pre-RTK and every attempt request is post-RTK; they are not the same payload"));
        }
        if !artifact["error"].is_null() {
            sections.push("an error was recorded for this request".into());
        }
        if flags.contains_key("full") {
            sections.push(block(
                flags,
                "CLIENT REQUEST (pre-RTK)",
                &artifact["client"]["request"],
            ));
            sections.push(block(
                flags,
                "CLIENT RESPONSE",
                &artifact["client"]["response"],
            ));
            for a in attempts {
                let name = format!(
                    "ATTEMPT {} {}",
                    text(&a["attempt"]),
                    crate::quota::provider(flags, &text(&a["provider"]))
                );
                sections.push(block(
                    flags,
                    &format!("{name} REQUEST (post-RTK)"),
                    &a["request"],
                ));
                sections.push(block(flags, &format!("{name} RESPONSE"), &a["response"]));
                if let Some(frames) = a["streamChunks"].as_array() {
                    sections.push(block(
                        flags,
                        &format!("{name} STREAM FRAMES ({})", frames.len()),
                        &a["streamChunks"],
                    ));
                }
            }
            if !artifact["error"].is_null() {
                sections.push(block(flags, "ERROR", &artifact["error"]));
            }
        } else {
            sections
                .push("bodies withheld; pass --full to print them, --json for the artifact".into());
        }
        Ok(sections.join("\n\n"))
    })
}
