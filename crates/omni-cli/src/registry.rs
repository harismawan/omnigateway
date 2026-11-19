// Frozen TS registry order is significant for grouped help.
pub const COMMANDS: &[(&str, &str, &str)] = &[
    (
        "status",
        "status",
        "Show the gateway process, its accounts, and their quota",
    ),
    (
        "start",
        "start [--foreground]",
        "Start the gateway and wait until it is serving",
    ),
    ("stop", "stop", "Stop the gateway"),
    (
        "restart",
        "restart",
        "Stop the gateway, then start it again",
    ),
    (
        "doctor",
        "doctor",
        "Check what this CLI resolved, and whether it can do anything with it",
    ),
    (
        "logs",
        "logs [-n N] [--follow] [--cursor C] [filters] [--service]",
        "Show recent requests (--service is an alias for `omni console`)",
    ),
    (
        "bodies",
        "bodies <request-id> [--full]",
        "Show captured bodies for one request; withheld unless --full",
    ),
    (
        "console",
        "console [-n N] [--follow] [--level debug|info|warn|error]",
        "Show the gateway process's own output",
    ),
    (
        "usage",
        "usage [--grain daily|raw] [--by DIMENSION] [--since T] [--until T]",
        "Aggregate spend and tokens",
    ),
    (
        "quota",
        "quota",
        "Show provider quota use, burn rate, and when each window runs out",
    ),
    (
        "connect",
        "connect <provider> [--label L] [--credential ID]",
        "Authorize a provider account from the terminal",
    ),
    (
        "logs export",
        "logs export --since T --until T [--format csv|jsonl] [filters]",
        "Write matching request metadata to stdout as CSV or JSONL",
    ),
    (
        "service install",
        "service install [--system] [--enable] [--force]",
        "Write a systemd unit for this installation",
    ),
    (
        "service uninstall",
        "service uninstall [--system]",
        "Disable and remove the systemd unit",
    ),
    (
        "credentials list",
        "credentials list",
        "List provider accounts and whether the router may use them",
    ),
    (
        "credentials show",
        "credentials show <id>",
        "Show one account in full, without its secrets",
    ),
    (
        "credentials enable",
        "credentials enable <id>",
        "Let the router use an account",
    ),
    (
        "credentials disable",
        "credentials disable <id>",
        "Stop letting the router use an account",
    ),
    (
        "credentials set",
        "credentials set <id> [--label L] [--tier N] [--weight W]",
        "Change an account's label, tier, or weight",
    ),
    (
        "credentials rm",
        "credentials rm <id>",
        "Delete an account and its stored tokens",
    ),
    (
        "credentials refresh",
        "credentials refresh <id>",
        "Force an OAuth token refresh now",
    ),
    (
        "credentials add-key",
        "credentials add-key <provider> [--label L] [--endpoint-id ID --endpoint-label L --origin URL --protocol P]",
        "Store a provider API key, read from a prompt or stdin",
    ),
    (
        "credentials health",
        "credentials health",
        "Show breaker state per credential and model",
    ),
    (
        "quota refresh",
        "quota refresh <id> | --all",
        "Read provider quota now, for one account or for every account",
    ),
    (
        "quota resets",
        "quota resets <id>",
        "List an account's banked quota resets (Codex, Claude)",
    ),
    (
        "quota reset",
        "quota reset <id> [--credit CREDIT_ID]",
        "Spend one banked quota reset on an account (irreversible)",
    ),
    (
        "models list",
        "models list",
        "List virtual models and their targets",
    ),
    (
        "models show",
        "models show <id>",
        "Show one virtual model's targets and pricing",
    ),
    (
        "models put",
        "models put <id> (-f model.json | --from-catalog <provider>:<model> ...)",
        "Create or replace a virtual model",
    ),
    ("models rm", "models rm <id>", "Delete a virtual model"),
    (
        "models dry-run",
        "models dry-run <id> [--tools] [--images] [--reasoning]",
        "Show where a request for this model would be sent, and why",
    ),
    (
        "models catalog",
        "models catalog [--provider P]",
        "List the built-in model catalog and its list pricing",
    ),
    ("keys list", "keys list", "List gateway API keys"),
    (
        "keys create",
        "keys create [--label L] [--allow <model> ...] [--limit <d>:<w>=N ...] [--model-limit <model>:<d>:<w>=N ...] [--expires <when>] [--policy <text>] [--smart-routing] [--no-bodies]",
        "Mint a gateway API key, printed once",
    ),
    (
        "keys limits",
        "keys limits <id> [--set <d>:<w>=N ...] [--unset <d>:<w> ...] [--model-limit <model>:<d>:<w>=N ...] [--unset-model-limit <model>:<d>[:<w>] ...]",
        "Show or edit one key's limits, with what has been used against them",
    ),
    (
        "keys models",
        "keys models <id> [--allow <model> ...] [--all] [--none]",
        "Show or replace one key's allowed models",
    ),
    (
        "keys expiry",
        "keys expiry <id> [--at <when>] [--never]",
        "Show or replace one key's expiry",
    ),
    (
        "keys guardrail",
        "keys guardrail <id> [--policy <text> | --policy-file <path> | --clear]",
        "Show or replace one key's usage policy",
    ),
    (
        "keys smart-routing",
        "keys smart-routing <id> (--on | --off)",
        "Turn confidential-data routing on or off for one key",
    ),
    (
        "keys revoke",
        "keys revoke <id>",
        "Revoke a gateway API key, keeping its usage history",
    ),
    (
        "plugin list",
        "plugin list",
        "List installed plugins and whether the gateway would load each one",
    ),
    (
        "plugin verify",
        "plugin verify <id>",
        "Run every load-time check on one plugin without loading it",
    ),
    (
        "plugin install",
        "plugin install <path|tarball|https url|package[@version]> [--registry <url>]",
        "Unpack a plugin into this installation, running nothing from it",
    ),
    (
        "plugin update",
        "plugin update <id> [--registry <url>]",
        "Reinstall a plugin from the source it was installed from",
    ),
    (
        "plugin remove",
        "plugin remove <id> [--purge]",
        "Remove a plugin, optionally dropping its stored data too",
    ),
    (
        "settings get",
        "settings get",
        "Show routing and retention settings",
    ),
    (
        "settings set",
        "settings set <path> <value>",
        "Change one setting, e.g. weights.cost 0.4, rtkEnabled true, or guardrailModel null",
    ),
    (
        "setup claude",
        "setup claude [--dir <path>] [--key <key>] [--dry-run]",
        "Write Claude Code settings for this gateway",
    ),
    (
        "setup opencode",
        "setup opencode [--dir <path>] [--key <key>] [--dry-run]",
        "Write an opencode.json provider entry for this gateway",
    ),
    (
        "admin set-password",
        "admin set-password",
        "Set or replace the console password",
    ),
    (
        "db migrate",
        "db migrate [--to <postgres-url>]",
        "Create or upgrade the database schema, or copy this installation onto Postgres",
    ),
    (
        "db stats",
        "db stats",
        "Show database size, free pages, and what snapshots are held",
    ),
    (
        "db snapshots",
        "db snapshots",
        "List the snapshots held for this installation",
    ),
    (
        "db backup",
        "db backup",
        "Take a snapshot of the database, pruning by the retention policy",
    ),
    (
        "db restore",
        "db restore <id> [--dry-run]",
        "Replace the database with a snapshot, keeping a copy of what was there",
    ),
    (
        "db vacuum",
        "db vacuum",
        "Rewrite the database, reclaiming the pages deletion left free",
    ),
    (
        "db clear-bodies",
        "db clear-bodies",
        "Delete every captured request and response body; the requests stay logged",
    ),
];

pub fn help() -> String {
    let mut out = String::from(
        "omni — manage a local OmniGateway installation\n\nUsage: omni <command> [options]\n\nGlobal options:\n  --root <path>   installation to manage (default: $OMNI_ROOT, cwd, ~/.config/omnigateway)\n  --db <path>     database file, overriding OMNI_DB_PATH\n  --json          emit JSON instead of tables\n  --no-color      never colourise output\n  --yes, -y       answer confirmations without asking\n  --system        act on the system systemd unit rather than the user one\n  --help, -h      show this help\n\n",
    );
    let groups: &[(&str, &[&str])] = &[
        (
            "Gateway",
            &[
                "status", "start", "stop", "restart", "doctor", "logs", "bodies", "console",
            ],
        ),
        ("Service", &["service "]),
        ("Accounts", &["connect", "credentials "]),
        ("Models", &["models "]),
        ("Keys", &["keys "]),
        ("Plugins", &["plugin "]),
        ("Configuration", &["settings ", "admin ", "db "]),
        ("Reports", &["usage", "quota"]),
    ];
    for (title, prefixes) in groups {
        let entries: Vec<_> = COMMANDS
            .iter()
            .filter(|(name, _, _)| {
                prefixes.iter().any(|p| {
                    if p.ends_with(' ') {
                        name.starts_with(p)
                    } else {
                        name == p
                    }
                })
            })
            .collect();
        let width = entries
            .iter()
            .map(|(_, usage, _)| usage.len())
            .max()
            .unwrap_or(0);
        out.push_str(&format!("{title}:\n"));
        for (_, usage, summary) in entries {
            out.push_str(&format!("  {usage:width$}  {summary}\n"));
        }
        out.push('\n');
    }
    out.trim_end().into()
}

pub fn command_help(name: &str) -> String {
    let (_, usage, summary) = COMMANDS
        .iter()
        .find(|(n, _, _)| *n == name)
        .expect("resolved command");
    format!("omni {usage}\n\n{summary}")
}

pub fn implemented(name: &str) -> Option<String> {
    if matches!(
        name,
        "start" | "stop" | "restart" | "doctor" | "service install" | "service uninstall"
    ) {
        return Some(name.replace(' ', "-"));
    }
    if matches!(
        name,
        "logs"
            | "logs export"
            | "usage"
            | "bodies"
            | "console"
            | "quota"
            | "quota refresh"
            | "quota resets"
            | "quota reset"
    ) {
        return Some(name.replace(' ', "-"));
    }
    if matches!(
        name,
        "db stats"
            | "db snapshots"
            | "db backup"
            | "db vacuum"
            | "db clear-bodies"
            | "db restore"
            | "db migrate"
    ) {
        return Some(name.replace(' ', "-"));
    }
    if name == "status" {
        return Some(name.into());
    }
    if name == "admin set-password" {
        return Some("admin-set-password".into());
    }
    if name.starts_with("setup ") {
        return Some(name.replace(' ', "-"));
    }
    if let Some(key) = name.strip_prefix("keys ") {
        return Some(key.into());
    }
    if matches!(
        name,
        "connect"
            | "credentials list"
            | "credentials refresh"
            | "credentials show"
            | "credentials health"
            | "credentials enable"
            | "credentials disable"
            | "credentials set"
            | "credentials rm"
            | "credentials add-key"
    ) || name.starts_with("settings ")
        || name.starts_with("models ")
    {
        return Some(name.replace(' ', "-"));
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn longest_adjacent_command_preserves_global_and_positional_arguments() {
        for (argv, name, rest) in [
            (
                vec![
                    "--root", "-root", "--json", "logs", "export", "extra", "fourth",
                ],
                "logs export",
                vec!["--root", "-root", "--json", "extra", "fourth"],
            ),
            (
                vec!["logs", "--json", "export"],
                "logs",
                vec!["--json", "export"],
            ),
            (
                vec!["--root=x", "quota", "refresh", "id"],
                "quota refresh",
                vec!["--root=x", "id"],
            ),
            (vec!["--", "status"], "status", vec!["--"]),
        ] {
            let argv = argv.into_iter().map(String::from).collect::<Vec<_>>();
            let (actual, remaining) = crate::args::resolve(&argv).expect("registered command");
            assert_eq!(actual, name);
            assert_eq!(remaining, rest);
        }
        for argv in [vec!["--root", "status"], vec!["keys", "--json", "list"]] {
            assert!(
                crate::args::resolve(&argv.into_iter().map(String::from).collect::<Vec<_>>())
                    .is_none()
            );
        }
    }
}
