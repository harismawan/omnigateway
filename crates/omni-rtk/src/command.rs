//! Bounded shell-command classification.
//!
//! Fails closed: composition, substitution, redirection, malformed quoting,
//! structured-output flags and anything outside the approved wrappers yield
//! `None`, and a shell-origin block with no classification is never
//! compressed.

use crate::catalog::RtkFilterId;
use omni_ir::js::{is_js_whitespace, utf16_len};

/// `GrepMode`. Context counts are JS numbers (`Number("…digits…")`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GrepMode {
    pub heading: bool,
    pub line_number: bool,
    pub before_context: f64,
    pub after_context: f64,
}

/// `CommandClassification`.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandClassification {
    pub family: RtkFilterId,
    pub executable: String,
    pub subcommand: Option<String>,
    pub grep_mode: Option<GrepMode>,
}

impl CommandClassification {
    fn new(family: RtkFilterId, executable: &str, subcommand: Option<&str>) -> Self {
        Self {
            family,
            executable: executable.to_owned(),
            subcommand: subcommand.map(str::to_owned),
            grep_mode: None,
        }
    }
}

#[derive(Debug, PartialEq)]
enum Token {
    Word(String),
    Operator(String),
}

const UNSUPPORTED_OUTPUT: [&str; 2] = ["--json", "--sarif"];
const MAX_COMMAND_UNITS: usize = 16_384;
const MAX_TOKENS: usize = 256;

fn tokenize(command: &str) -> Option<Vec<Token>> {
    if utf16_len(command) > MAX_COMMAND_UNITS
        || command.contains(['\r', '\n', '`'])
        || command.contains("$(")
        || command.contains("<(")
        || command.contains(">(")
    {
        return None;
    }
    let chars: Vec<char> = command.chars().collect();
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut word_started = false;
    let mut quote: Option<char> = None;
    let push_word = |tokens: &mut Vec<Token>, word: &mut String, started: &mut bool| {
        if *started {
            tokens.push(Token::Word(std::mem::take(word)));
        }
        word.clear();
        *started = false;
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == '\\' && q == '"' && i + 1 < chars.len() {
                i += 1;
                word.push(chars[i]);
            } else {
                word.push(c);
            }
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            word_started = true;
            i += 1;
            continue;
        }
        if is_js_whitespace(c) {
            push_word(&mut tokens, &mut word, &mut word_started);
            i += 1;
            continue;
        }
        if ";&|<>".contains(c) || (c == '$' && chars.get(i + 1) == Some(&'(')) {
            push_word(&mut tokens, &mut word, &mut word_started);
            let mut value = c.to_string();
            if let Some(&next) = chars.get(i + 1)
                && (next == c || (c == '>' && next == '>'))
            {
                value.push(next);
                i += 1;
            }
            tokens.push(Token::Operator(value));
            i += 1;
            continue;
        }
        word.push(c);
        word_started = true;
        i += 1;
    }
    if quote.is_some() {
        return None;
    }
    push_word(&mut tokens, &mut word, &mut word_started);
    (tokens.len() <= MAX_TOKENS).then_some(tokens)
}

/// `/^[A-Za-z_][A-Za-z0-9_]*=/`.
fn is_assignment(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some(&first) = bytes.first() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return false;
    }
    for &b in &bytes[1..] {
        if b == b'=' {
            return true;
        }
        if !(b.is_ascii_alphanumeric() || b == b'_') {
            return false;
        }
    }
    false
}

fn unwrap(tokens: Vec<Token>) -> Option<Vec<String>> {
    let operators: Vec<usize> = tokens
        .iter()
        .enumerate()
        .filter_map(|(i, t)| matches!(t, Token::Operator(_)).then_some(i))
        .collect();
    if operators.len() > 1 {
        return None;
    }
    let mut tokens = tokens;
    if let Some(&index) = operators.first() {
        let is_and = matches!(&tokens[index], Token::Operator(v) if v == "&&");
        let starts_cd = matches!(tokens.first(), Some(Token::Word(w)) if w == "cd");
        if !is_and || !starts_cd || index != 2 {
            return None;
        }
        tokens.drain(..=index);
    }
    let mut values: std::collections::VecDeque<String> = tokens
        .into_iter()
        .map(|t| match t {
            Token::Word(w) | Token::Operator(w) => w,
        })
        .collect();
    while values.front().is_some_and(|v| is_assignment(v)) {
        values.pop_front();
    }
    if values.front().is_some_and(|v| v == "env") {
        values.pop_front();
        while let Some(value) = values.front() {
            if value == "-i" || value == "--ignore-environment" || is_assignment(value) {
                values.pop_front();
            } else if value == "-u" {
                values.get(1)?;
                values.drain(..2);
            } else if value.starts_with("--unset=") || value == "--" {
                values.pop_front();
            } else {
                break;
            }
        }
    }
    if values.front().is_some_and(|v| v == "timeout") {
        values.pop_front();
        while values.front().is_some_and(|v| v.starts_with('-')) {
            let option = values.pop_front()?;
            if option == "--" {
                break;
            }
            if option == "-s" || option == "-k" {
                values.pop_front()?;
            } else if !option.starts_with("--signal=") && !option.starts_with("--kill-after=") {
                return None;
            }
        }
        values.pop_front()?;
    }
    (!values.is_empty()).then(|| values.into())
}

fn script_family(name: &str) -> RtkFilterId {
    if name.starts_with("test:") || name == "test" {
        RtkFilterId::TestOutput
    } else if ["lint", "typecheck", "check"].contains(&name)
        || name.starts_with("lint:")
        || name.starts_with("typecheck:")
    {
        RtkFilterId::LintOutput
    } else {
        RtkFilterId::BuildOutput
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `Number(digits)`: correctly rounded, as JS is.
fn number(s: &str) -> f64 {
    s.parse().unwrap_or(f64::NAN)
}

fn classify_grep(executable: &str, args: &[String]) -> Option<CommandClassification> {
    let mut heading = false;
    let mut before = 0.0;
    let mut after = 0.0;
    let mut line_number = false;
    let mut operands = 0;
    let mut index = 0;
    while index < args.len() {
        let argument = args[index].as_str();
        if argument == "--" {
            operands += args.len() - index - 1;
            break;
        }
        if !argument.starts_with('-') {
            operands += 1;
            index += 1;
            continue;
        }
        if [
            "--json",
            "--files",
            "--replace",
            "-r",
            "--files-with-matches",
            "-l",
            "-P",
        ]
        .contains(&argument)
        {
            return None;
        }
        if argument == "--heading" {
            heading = true;
        } else if argument == "--no-heading" {
            heading = false;
        } else if argument == "-n" || argument == "--line-number" {
            line_number = true;
        } else if [
            "-C",
            "-A",
            "-B",
            "--context",
            "--after-context",
            "--before-context",
        ]
        .contains(&argument)
        {
            index += 1;
            let count = args.get(index).filter(|c| digits(c))?;
            let value = number(count);
            match argument {
                "-C" | "--context" => {
                    before = value;
                    after = value;
                }
                "-A" | "--after-context" => after = value,
                _ => before = value,
            }
        } else if argument.len() > 2
            && argument.starts_with('-')
            && matches!(argument.as_bytes()[1], b'C' | b'A' | b'B')
            && digits(&argument[2..])
        {
            let value = number(&argument[2..]);
            match argument.as_bytes()[1] {
                b'C' => {
                    before = value;
                    after = value;
                }
                b'A' => after = value,
                _ => before = value,
            }
        } else if let Some((name, count)) = argument.split_once('=')
            && ["--context", "--after-context", "--before-context"].contains(&name)
            && digits(count)
        {
            let value = number(count);
            match name {
                "--context" => {
                    before = value;
                    after = value;
                }
                "--after-context" => after = value,
                _ => before = value,
            }
        } else if ![
            "-i",
            "--ignore-case",
            "-F",
            "--fixed-strings",
            "-w",
            "--word-regexp",
        ]
        .contains(&argument)
        {
            return None;
        }
        index += 1;
    }
    if operands == 0 {
        return None;
    }
    Some(CommandClassification {
        grep_mode: Some(GrepMode {
            heading,
            line_number,
            before_context: before,
            after_context: after,
        }),
        ..CommandClassification::new(RtkFilterId::Grep, executable, None)
    })
}

/// `/^-+[alRh]+$/`.
fn ls_option(option: &str) -> bool {
    let rest = option.trim_start_matches('-');
    rest.len() < option.len() && !rest.is_empty() && rest.bytes().all(|b| b"alRh".contains(&b))
}

fn direct(executable: &str, args: &[String]) -> Option<CommandClassification> {
    use RtkFilterId as F;
    if executable.is_empty() {
        return None;
    }
    if executable == "rg" || executable == "grep" {
        return classify_grep(executable, args);
    }
    let sub = args.first().map(String::as_str);
    let new = |family, subcommand| Some(CommandClassification::new(family, executable, subcommand));
    if executable == "git" {
        match sub {
            Some("diff") => return new(F::GitDiff, sub),
            Some("status") => return new(F::GitStatus, sub),
            Some("log") => return new(F::GitLog, sub),
            Some("branch" | "switch" | "checkout" | "push" | "pull" | "fetch") => {
                return new(F::GitOperation, sub);
            }
            Some("ls-files") => return new(F::PathList, sub),
            _ => {}
        }
    }
    let second = args.get(1).map(String::as_str);
    if executable == "docker"
        && (sub == Some("build")
            || (sub == Some("buildx") && second == Some("build"))
            || (sub == Some("compose") && second == Some("build")))
    {
        return new(F::DockerBuild, sub);
    }
    if executable == "tree" {
        let options: Vec<&String> = args.iter().filter(|a| a.starts_with('-')).collect();
        if options.iter().any(|o| *o != "-F" && *o != "--classify") {
            return None;
        }
        return new(F::TreeOutput, (!options.is_empty()).then_some("classified"));
    }
    if executable == "ls" {
        let options: Vec<&String> = args.iter().filter(|a| a.starts_with('-')).collect();
        if options.iter().any(|o| !ls_option(o)) {
            return None;
        }
        let recursive = options.iter().any(|o| o.contains('R'));
        let long = options.iter().any(|o| o.contains('l'));
        if !recursive && !long {
            return None;
        }
        let subcommand = match (recursive, long) {
            (true, true) => "recursive-long",
            (true, false) => "recursive-plain",
            _ => "long",
        };
        return new(F::TreeOutput, Some(subcommand));
    }
    if ["find", "glob"].contains(&executable) {
        return new(F::PathList, None);
    }
    if ["sed", "cat", "head", "tail", "awk", "nl"].contains(&executable) {
        return new(F::NumberedRead, None);
    }
    let sub_in = |options: &[&str]| sub.is_some_and(|s| options.contains(&s));
    if executable == "tsc"
        || executable == "eslint"
        || executable == "golangci-lint"
        || (executable == "biome" && sub_in(&["check", "lint"]))
        || (executable == "ruff" && sub == Some("check"))
        || (executable == "cargo" && sub == Some("clippy"))
    {
        return new(F::LintOutput, sub);
    }
    if ["vitest", "jest", "pytest"].contains(&executable)
        || (executable == "go" && sub == Some("test"))
    {
        return new(F::TestOutput, sub);
    }
    if (executable == "bun" && sub_in(&["add", "install", "update", "remove"]))
        || (executable == "npm" && sub_in(&["install", "update", "audit"]))
        || (executable == "pnpm" && sub_in(&["install", "update"]))
        || (executable == "yarn" && sub_in(&["install", "up"]))
        || (executable == "cargo" && sub_in(&["add", "update", "fetch"]))
        || (executable == "pip" && sub == Some("install"))
        || (executable == "uv" && sub_in(&["sync", "add", "remove"]))
    {
        return new(F::PackageOutput, Some(sub.unwrap_or("")));
    }
    if (executable == "bun" || executable == "npm" || executable == "cargo") && sub == Some("test")
    {
        return new(F::TestOutput, sub);
    }
    if (executable == "bun" && sub == Some("build"))
        || (executable == "cargo" && sub_in(&["build", "check"]))
    {
        return new(F::BuildOutput, Some(sub.unwrap_or("")));
    }
    None
}

/// The option loop shared by `bun x`/`bunx` (`--bun`) and `npx`
/// (`--yes`/`-y`): each own option at most once and before `--`, `--` at most
/// once. Returns the index of the wrapped executable.
fn wrapper(words: &[String], start: usize, own: &[&str]) -> Option<usize> {
    let mut index = start;
    let mut saw_own = false;
    let mut saw_separator = false;
    while let Some(option) = words.get(index).filter(|w| w.starts_with('-')) {
        index += 1;
        if own.contains(&option.as_str()) && !saw_own && !saw_separator {
            saw_own = true;
        } else if option == "--" && !saw_separator {
            saw_separator = true;
        } else {
            return None;
        }
    }
    Some(index)
}

fn wrapped(words: &[String], index: usize) -> Option<CommandClassification> {
    let wrapped = words.get(index)?;
    if wrapped.is_empty() || wrapped == "--" {
        return None;
    }
    direct(wrapped, &words[index + 1..])
}

/// `classifyCommand`.
pub fn classify_command(command: &str) -> Option<CommandClassification> {
    let words = unwrap(tokenize(command)?)?;
    if words.iter().any(|w| {
        UNSUPPORTED_OUTPUT.contains(&w.as_str())
            || ["--format=", "--output-format=", "--reporter="]
                .iter()
                .any(|p| w.starts_with(p))
            || ["--format", "--output-format", "--reporter"].contains(&w.as_str())
    }) {
        return None;
    }
    let executable = words.first()?.as_str();
    let second = words.get(1).map(String::as_str);
    if (executable == "bun" || executable == "npm") && second == Some("run") {
        let mut index = 2;
        if words.get(index).is_some_and(|w| w == "--") {
            index += 1;
        }
        let script = words.get(index).filter(|s| !s.is_empty())?;
        return Some(CommandClassification::new(
            script_family(script),
            executable,
            Some("run"),
        ));
    }
    if (executable == "bun" && second == Some("x")) || executable == "bunx" {
        let start = if executable == "bun" { 2 } else { 1 };
        return wrapped(&words, wrapper(&words, start, &["--bun"])?);
    }
    if executable == "npx" {
        return wrapped(&words, wrapper(&words, 1, &["--yes", "-y"])?);
    }
    direct(executable, &words[1..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_handles_quotes_escapes_and_operators() {
        assert_eq!(
            tokenize(r#"a "b \" c" 'd e'>>f"#),
            Some(vec![
                Token::Word("a".into()),
                Token::Word("b \" c".into()),
                Token::Word("d e".into()),
                Token::Operator(">>".into()),
                Token::Word("f".into()),
            ])
        );
        assert_eq!(tokenize("''"), Some(vec![Token::Word(String::new())]));
    }

    #[test]
    fn grep_context_forms() {
        let mode = |c: &str| classify_command(c).and_then(|c| c.grep_mode);
        let m = mode("rg -A3 --before-context=4 x").expect("mode");
        assert_eq!((m.before_context, m.after_context), (4.0, 3.0));
        assert!(mode("rg -A x y").is_none());
        assert!(mode("rg -n").is_none());
        assert!(mode("rg -- -x").is_some());
    }

    #[test]
    fn ls_options_need_a_dash_and_letters() {
        assert!(ls_option("-la"));
        assert!(ls_option("--R"));
        assert!(!ls_option("-"));
        assert!(!ls_option("-x"));
    }
}
