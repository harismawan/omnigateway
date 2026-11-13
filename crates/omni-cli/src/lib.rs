#![forbid(unsafe_code)]
mod args;
mod context;
mod date;
mod limits;
mod models;
mod mutations;
mod output;
mod password;
mod registry;
mod settings;
mod setup;
use std::{io::IsTerminal, process::ExitCode};

pub fn run(argv: Vec<String>) -> ExitCode {
    if argv.iter().any(|s| s == "--version") {
        println!("{}", option_env!("OMNI_CLI_VERSION").unwrap_or("0.0.0-dev"));
        return ExitCode::SUCCESS;
    }
    let help = argv.iter().any(|s| matches!(s.as_str(), "--help" | "-h"));
    let Some((command, rest)) = args::resolve(&argv) else {
        if help || argv.iter().all(|s| s.starts_with('-')) {
            println!("{}", registry::help());
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
        println!("{}", registry::command_help(&command));
        return ExitCode::SUCCESS;
    }
    if command.starts_with("plugin ") {
        eprintln!("plugins are not supported in this release");
        return ExitCode::FAILURE;
    }
    let Some(command) = registry::implemented(&command) else {
        eprintln!("{command} is not yet available in the Rust CLI");
        return ExitCode::FAILURE;
    };
    if command != "list" {
        let result = args::parse_command(&rest, &command)
            .map_err(|e| (2, e))
            .and_then(|(flags, positional, allow)| {
                if command == "admin-set-password" {
                    password::run(&flags).map_err(|e| (1, e))
                } else if command.starts_with("setup-") {
                    setup::run(&command, &flags).map_err(|e| (1, e))
                } else if command.starts_with("models-") {
                    models::run(&command, &flags, &positional, &allow)
                } else if command.starts_with("settings-") {
                    settings::run(&command, &flags, &positional)
                } else {
                    mutations::run(&command, &flags, &positional, &allow)
                }
            });
        return match result {
            Ok(out) => {
                println!("{out}");
                if command.starts_with("setup-")
                    && let Ok((flags, _, _)) = args::parse_command(&rest, &command)
                    && !flags.contains_key("json")
                    && !flags.contains_key("key")
                {
                    eprintln!(
                        "no --key given: the files carry a placeholder, so paste your key over it"
                    );
                }
                ExitCode::SUCCESS
            }
            Err((code, error)) => {
                eprintln!("{error}");
                if code == 2 {
                    let usage = registry::COMMANDS
                        .iter()
                        .find(|(n, _, _)| n.replace(' ', "-") == command)
                        .map(|(_, u, _)| *u);
                    eprintln!(
                        "usage: omni {}",
                        usage.unwrap_or_else(|| mutations::usage(&command))
                    );
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
