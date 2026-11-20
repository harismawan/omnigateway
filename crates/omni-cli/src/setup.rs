use omni_control::{
    fs_error::fs_error,
    setup::{self, SLOTS, SetupClient},
};
use std::{
    collections::HashMap,
    io::{BufRead, IsTerminal},
    path::PathBuf,
};

pub fn run(command: &str, flags: &HashMap<String, String>) -> Result<String, String> {
    let ctx = crate::context::resolve(flags)?;
    let base = ctx.base_url()?;
    let store = ctx.open()?;
    let models = omni_control::models::cli_list(&store)?;
    let credentials = omni_control::credentials::cli_rows(&store)?;
    let described = setup::describe_models(&models, &credentials)?;
    if models.is_empty() {
        return Err("no virtual models configured; add one with `omni models put`".into());
    }
    let ids = described
        .iter()
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>();
    let mut mapping = SLOTS.map(|_| String::new());
    for (i, (label, _, _)) in SLOTS.iter().enumerate() {
        let question = format!(
            "{label} model{} [{}]: ",
            if i == 0 { "" } else { " (blank to omit)" },
            ids.join(", ")
        );
        if !std::io::stdin().is_terminal() {
            return Err(format!("{question} — refusing without a terminal"));
        }
        eprintln!("{question}");
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        let answer = omni_ir::js::trim(&line).to_owned();
        if i == 0 && answer.is_empty() {
            return Err("default model is required".into());
        }
        mapping[i] = answer;
    }
    let client = if command == "setup-claude" {
        SetupClient::Claude
    } else {
        SetupClient::Opencode
    };
    let dir = flags.get("dir").map(PathBuf::from).unwrap_or_else(|| {
        if client == SetupClient::Claude {
            std::env::home_dir().unwrap_or_default().join(".claude")
        } else {
            std::env::current_dir().unwrap_or_default()
        }
    });
    let dir = normalize(&dir);
    let path = normalize(&dir.join(client.path()));
    let existing = if client == SetupClient::Claude && path.exists() {
        let mut file = std::fs::File::open(&path).map_err(|e| fs_error(&e, "open", &path))?;
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut raw).map_err(|e| fs_error(&e, "read", &path))?;
        Some(raw)
    } else {
        None
    };
    let existing = existing.as_deref().map(String::from_utf8_lossy);
    let contents = setup::render(
        client,
        &described,
        &base,
        &mapping,
        flags.get("key").map(String::as_str),
        existing.as_deref(),
    )?;
    if !flags.contains_key("dry-run") {
        std::fs::create_dir_all(&dir).map_err(|e| fs_error(&e, "mkdir", &dir))?;
        let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
        let result = std::fs::File::create(&temporary)
            .map_err(|e| fs_error(&e, "open", &temporary))
            .and_then(|mut f| {
                std::io::Write::write_all(&mut f, contents.as_bytes())
                    .map_err(|e| fs_error(&e, "write", &temporary))
            })
            .and_then(|()| {
                std::fs::rename(&temporary, &path).map_err(|e| {
                    format!(
                        "{} -> '{}'",
                        fs_error(&e, "rename", &temporary),
                        path.display()
                    )
                })
            });
        if result.is_err() {
            drop(std::fs::remove_file(&temporary));
        }
        result?;
    }
    let display = path.to_string_lossy();
    Ok(if flags.contains_key("json") {
        omni_ir::jsjson::to_string_pretty(
            &serde_json::json!({"files":[{"path":display,"contents":contents}],"pluginFailures":[]}),
        )
    } else if flags.contains_key("dry-run") {
        format!("--- {display}\n{contents}")
    } else {
        display.into_owned()
    })
}

fn normalize(path: &std::path::Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if out.file_name().is_some_and(|s| s != "..") {
                    out.pop();
                } else if !out.has_root() {
                    out.push("..");
                }
            }
            p => out.push(p.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}
