//! The system prompt as text, recording every block that could not become
//! text.

use omni_ir::request::ContentBlock;

/// `None` when the request has no system prompt at all; the
/// text blocks joined with a blank line otherwise. Each non-text block is
/// recorded as `<provider>:system-<type>-dropped`.
pub fn system_text(
    system: Option<&[ContentBlock]>,
    provider: &str,
    note: &mut impl FnMut(String),
) -> Option<String> {
    let system = system?;
    let mut kept: Vec<&str> = Vec::with_capacity(system.len());
    for block in system {
        match block {
            ContentBlock::Text(t) => kept.push(&t.text),
            other => note(format!("{provider}:system-{}-dropped", other.type_name())),
        }
    }
    Some(kept.join("\n\n"))
}
