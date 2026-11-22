//! Request-local tool aliasing, preserving TS insertion order and collisions.
use omni_ir::request::{ChatRequest, ContentBlock, ToolChoice, ToolDef};
use std::collections::HashMap;

#[derive(Default)]
pub struct ToolCloak {
    pub to_wire: Vec<(String, String)>,
    pub from_wire: HashMap<String, String>,
}
impl ToolCloak {
    pub fn build(request: &ChatRequest) -> Self {
        let mut names = Vec::new();
        let mut claims: HashMap<String, usize> = HashMap::new();
        for tool in request.tools.iter().flatten() {
            match tool {
                ToolDef::Portable(t) => names.push(t.name.clone()),
                ToolDef::Provider(t) if !t.name.is_empty() => {
                    *claims.entry(t.name.clone()).or_default() += 1
                }
                _ => (),
            }
        }
        for message in &request.messages {
            for block in &message.content {
                if let ContentBlock::ToolUse(t) = block {
                    names.push(t.name.clone());
                }
            }
        }
        if let Some(ToolChoice::Tool { name }) = &request.tool_choice {
            names.push(name.clone());
        }
        let mut seen = std::collections::HashSet::new();
        names.retain(|n| seen.insert(n.clone()));
        let mut bases = Vec::new();
        for name in names {
            let exempt = name.starts_with("mcp__")
                || (name.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
                    && name.bytes().all(|b| b.is_ascii_alphanumeric()));
            if exempt {
                *claims.entry(name).or_default() += 1;
                continue;
            }
            let mut base = String::new();
            for word in name
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|s| !s.is_empty())
            {
                base.push_str(&word[..1].to_ascii_uppercase());
                base.push_str(&word[1..]);
            }
            let forced = base.is_empty() || base.len() > 128;
            if base.is_empty() {
                base = "Tool".into();
            }
            if base.len() > 128 {
                base.truncate(122);
            }
            *claims.entry(base.clone()).or_default() += 1;
            bases.push((name, base, forced));
        }
        let mut cloak = Self::default();
        for (name, base, forced) in bases {
            let alias = if forced || claims.get(&base).copied().unwrap_or(0) > 1 {
                format!("{base}{}", omni_crypto::cloak::anthropic_suffix(&name))
            } else {
                base
            };
            cloak.from_wire.insert(alias.clone(), name.clone());
            cloak.to_wire.push((name, alias));
        }
        cloak
    }
    pub fn name<'a>(&'a self, name: &'a str) -> &'a str {
        self.to_wire
            .iter()
            .find(|(n, _)| n == name)
            .map_or(name, |(_, alias)| alias.as_str())
    }
}
