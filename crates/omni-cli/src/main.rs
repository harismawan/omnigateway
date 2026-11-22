#![forbid(unsafe_code)]
fn main() -> std::process::ExitCode {
    // Bun decodes malformed UTF-8 in argv with replacement characters.
    omni_cli::run(
        std::env::args_os()
            .skip(1)
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect(),
    )
}
