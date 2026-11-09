#![forbid(unsafe_code)]
mod args;
mod context;
mod date;
mod limits;
mod mutations;
mod output;
use std::{io::IsTerminal, process::ExitCode};

pub fn run(argv: Vec<String>) -> ExitCode {
    if argv.iter().any(|s| s == "--version") {
        println!("{}", option_env!("OMNI_CLI_VERSION").unwrap_or("0.0.0-dev"));
        return ExitCode::SUCCESS;
    }
    let help = argv.iter().any(|s| matches!(s.as_str(), "--help" | "-h"));
    let Some((command, rest)) = args::resolve(&argv) else {
        if help || argv.iter().all(|s| s.starts_with('-')) {
            println!(
                "omni — Rust CLI migration increment\n\nImplemented: keys list, create, limits, models, guardrail, smart-routing, revoke, expiry\n\nGlobal flags: --root <path> --db <path> --json --no-color --yes"
            );
            return ExitCode::SUCCESS;
        }
        eprintln!(
            "unknown command: {}",
            argv.iter()
                .filter(|s| !s.starts_with('-'))
                .cloned()
                .collect::<Vec<_>>()
                .join(" ")
        );
        eprintln!("run omni --help for the command list");
        return ExitCode::from(2);
    };
    if help {
        println!(
            "omni {}\n\n{}",
            mutations::usage(&command),
            match command.as_str() {
                "models" => "Show or replace one key's allowed models",
                "expiry" => "Show or replace one key's expiry",
                "create" => "Mint a gateway API key, printed once",
                "limits" => "Show or edit one key's limits, with what has been used against them",
                "guardrail" => "Show or replace one key's usage policy",
                "smart-routing" => "Turn confidential-data routing on or off for one key",
                "revoke" => "Revoke a gateway API key, keeping its usage history",
                _ => "List gateway API keys",
            }
        );
        return ExitCode::SUCCESS;
    }
    if command != "list" {
        let result = args::parse_command(&rest, &command)
            .map_err(|e| (2, e))
            .and_then(|(flags, positional, allow)| {
                mutations::run(&command, &flags, &positional, &allow)
            });
        return match result {
            Ok(out) => {
                println!("{out}");
                ExitCode::SUCCESS
            }
            Err((code, error)) => {
                eprintln!("{error}");
                if code == 2 {
                    eprintln!("usage: omni {}", mutations::usage(&command));
                }
                ExitCode::from(code)
            }
        };
    }
    let flags = match args::parse(&rest) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("{e}\nusage: omni keys list");
            return ExitCode::from(2);
        }
    };
    let result = (|| {
        let store = context::open(&flags)?;
        let now = chrono::Utc::now().timestamp_millis();
        let data = omni_control::keys::list_keys(&store, now).map_err(|e| e.to_string())?;
        let color = !flags.contains_key("no-color")
            && std::env::var("NO_COLOR").unwrap_or_default().is_empty()
            && std::io::stdout().is_terminal();
        Ok::<_, String>(if flags.contains_key("json") {
            data.json()
        } else {
            output::human(&data, now, color)?
        })
    })();
    match result {
        Ok(out) => {
            println!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
