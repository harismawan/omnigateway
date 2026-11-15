//! Cloud Code function-name grammar and request-local reversible aliases.
use omni_ir::request::{ChatRequest, ContentBlock, ToolChoice, ToolDef};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct ToolCloak {
    pub to_wire: Vec<(String, String)>,
    pub from_wire: HashMap<String, String>,
    name_index: HashMap<String, usize>,
}

fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

fn alias(name: &str) -> (String, bool) {
    let mut base = String::new();
    let mut refused = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || "_.-".contains(c) {
            base.push(c);
            refused = false;
        } else if !refused {
            base.push('_');
            refused = true;
        }
    }
    if !base
        .as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
    {
        base = format!("_{base}");
    }
    if base == "_" {
        return ("_tool".into(), true);
    }
    if base.len() > 128 {
        base.truncate(122);
        return (base, true);
    }
    (base, false)
}

impl ToolCloak {
    pub fn build(request: &ChatRequest) -> Self {
        let called: HashSet<_> = request
            .messages
            .iter()
            .flat_map(|m| &m.content)
            .filter_map(|b| {
                if let ContentBlock::ToolUse(t) = b {
                    Some(t.id.as_str())
                } else {
                    None
                }
            })
            .collect();
        let mut names = Vec::new();
        for tool in request.tools.iter().flatten() {
            if let ToolDef::Portable(t) = tool {
                names.push(t.name.as_str());
            }
        }
        for block in request.messages.iter().flat_map(|m| &m.content) {
            match block {
                ContentBlock::ToolUse(t) => names.push(&t.name),
                ContentBlock::ToolResult(t) if !called.contains(t.tool_use_id.as_str()) => {
                    names.push(&t.tool_use_id)
                }
                _ => (),
            }
        }
        if let Some(ToolChoice::Tool { name }) = &request.tool_choice {
            names.push(name);
        }
        let mut seen = HashSet::new();
        names.retain(|n| {
            let fresh = !seen.contains(n);
            seen.extend([*n]);
            fresh
        });
        let mut claims: HashMap<String, usize> = HashMap::new();
        let mut bases = Vec::new();
        for name in names {
            if valid(name) {
                *claims.entry(name.into()).or_default() += 1;
            } else {
                let (base, forced) = alias(name);
                *claims.entry(base.clone()).or_default() += 1;
                bases.push((name, base, forced));
            }
        }
        let mut cloak = Self::default();
        for (name, base, forced) in bases {
            let alias = if forced || claims[&base] > 1 {
                format!("{base}{}", omni_crypto::cloak::antigravity_suffix(name))
            } else {
                base
            };
            *cloak.from_wire.entry(alias.clone()).or_default() = name.into();
            cloak
                .name_index
                .extend([(name.into(), cloak.to_wire.len())]);
            cloak.to_wire.push((name.into(), alias));
        }
        cloak
    }
    pub fn name<'a>(&'a self, name: &'a str) -> &'a str {
        self.name_index
            .get(name)
            .map_or(name, |i| self.to_wire[*i].1.as_str())
    }
    pub fn original<'a>(&'a self, name: &'a str) -> &'a str {
        self.from_wire.get(name).map_or(name, String::as_str)
    }
}
