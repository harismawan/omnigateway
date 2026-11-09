#![forbid(unsafe_code)]
mod args;
mod context;
mod output;
use std::{io::IsTerminal, process::ExitCode};

pub fn run(argv: Vec<String>) -> ExitCode {
    if argv.iter().any(|s| s == "--version") {
        println!("{}", option_env!("OMNI_CLI_VERSION").unwrap_or("0.0.0-dev"));
        return ExitCode::SUCCESS;
    }
    let help = argv.iter().any(|s| matches!(s.as_str(), "--help" | "-h"));
    let Some(rest) = args::resolve(&argv) else {
        if help || argv.iter().all(|s| s.starts_with('-')) {
            println!(
                "omni — Rust CLI migration increment\n\nUsage: omni keys list [--root <path>] [--db <path>] [--json] [--no-color]\n\nOnly keys list is implemented in this increment."
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
        println!("omni keys list\n\nList gateway API keys");
        return ExitCode::SUCCESS;
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
