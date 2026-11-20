//! Cloud Code function-name grammar and request-local reversible aliases.
use omni_ir::request::{ChatRequest, ContentBlock, ToolChoice, ToolDef};
use omni_ir::text::Text;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct ToolCloak {
    pub to_wire: Vec<(Text, String)>,
    pub from_wire: HashMap<String, Text>,
    name_index: HashMap<Text, usize>,
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
        Self::from_names(names.into_iter().map(Text::from))
    }

    pub(super) fn from_names(names: impl IntoIterator<Item = Text>) -> Self {
        let mut seen = HashSet::new();
        let mut claims: HashMap<String, usize> = HashMap::new();
        let mut bases = Vec::new();
        for name in names {
            if !seen.insert(name.clone()) {
                continue;
            }
            if let Some(name) = name.as_utf8().filter(|n| valid(n)) {
                *claims.entry(name.to_owned()).or_default() += 1;
            } else {
                let (base, forced) = alias(&name.to_utf8_lossy());
                *claims.entry(base.clone()).or_default() += 1;
                bases.push((name, base, forced));
            }
        }
        let mut cloak = Self::default();
        for (name, base, forced) in bases {
            let alias = if forced || claims[&base] > 1 {
                format!(
                    "{base}{}",
                    omni_crypto::cloak::antigravity_suffix(&name.to_utf8_lossy())
                )
            } else {
                base
            };
            cloak.from_wire.insert(alias.clone(), name.clone());
            cloak.name_index.insert(name.clone(), cloak.to_wire.len());
            cloak.to_wire.push((name, alias));
        }
        cloak
    }

    pub(super) fn from_source(req: &omni_ir::jsjson::JsValue) -> Self {
        use omni_ir::jsjson::JsValue as V;
        let blocks = || {
            req["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|m| m["content"].as_array().into_iter().flatten())
        };
        let field = |v: &V, key| v.get(key).and_then(V::as_text);
        let called: HashSet<_> = blocks()
            .filter(|b| b["type"].string_eq("toolUse"))
            .filter_map(|b| field(b, "id"))
            .collect();
        let tools = req["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["kind"].string_eq("portable"))
            .filter_map(|t| field(t, "name"));
        let referenced = blocks().filter_map(|b| {
            if b["type"].string_eq("toolUse") {
                field(b, "name")
            } else if b["type"].string_eq("toolResult") {
                field(b, "toolUseId").filter(|id| !called.contains(id))
            } else {
                None
            }
        });
        let choice = field(&req["toolChoice"], "name");
        Self::from_names(tools.chain(referenced).chain(choice))
    }
    pub fn name<'a>(&'a self, name: &'a str) -> &'a str {
        self.name_index
            .get(&Text::from(name))
            .map_or(name, |i| self.to_wire[*i].1.as_str())
    }
    pub fn original<'a>(&'a self, name: &'a str) -> &'a str {
        self.from_wire
            .get(name)
            .and_then(Text::as_utf8)
            .unwrap_or(name)
    }

    pub(super) fn wire_text(&self, name: &Text) -> Text {
        self.name_index
            .get(name)
            .map_or_else(|| name.clone(), |i| self.to_wire[*i].1.as_str().into())
    }

    pub(super) fn original_text(&self, name: Text) -> Text {
        name.as_utf8()
            .and_then(|n| self.from_wire.get(n))
            .cloned()
            .unwrap_or(name)
    }
}
