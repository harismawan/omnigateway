#![forbid(unsafe_code)]
fn main() -> std::process::ExitCode {
    omni_cli::run(std::env::args().skip(1).collect())
}
