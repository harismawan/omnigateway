//! `packages/rtk/test/fourteenth-audit.test.ts`.

use super::common::*;
use omni_rtk::filters::listings::compress_listing;
use omni_rtk::filters::shared::{BoundedText, ChargeKind, ParserBudget, scan_text};

/// TS subclasses `ParserBudget` to record charges; the Rust budget has a
/// recording constructor instead. Returns `(records charged, output)`.
fn record_charges(text: &str, parse: &dyn Fn(&BoundedText<'_>) -> String) -> (u64, String) {
    let scanned = scan_text(text).expect("scannable fixture");
    let input = BoundedText {
        text,
        lines: scanned.lines,
        budget: ParserBudget::recording(utf16_len(text) * 8),
    };
    let output = parse(&input);
    let records = input
        .budget
        .charges()
        .iter()
        .filter(|c| c.kind == ChargeKind::Records)
        .map(|c| c.count)
        .sum();
    (records, output)
}

fn attempt(text: &str, code_units: usize, parse: &dyn Fn(&BoundedText<'_>) -> String) -> String {
    let scanned = scan_text(text).expect("scannable fixture");
    parse(&BoundedText {
        text,
        lines: scanned.lines,
        budget: ParserBudget::new(code_units),
    })
}

fn minimal_code_units(text: &str, parse: &dyn Fn(&BoundedText<'_>) -> String) -> usize {
    let mut low = 0;
    let mut high = utf16_len(text) * 8;
    assert_ne!(attempt(text, high, parse), text, "fixture never compresses");
    while low < high {
        let middle = (low + high) / 2;
        if attempt(text, middle, parse) == text {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

#[test]
fn unknown_origin_unprefixed_nested_listing_compresses_without_losing_middle_groups() {
    let mut lines = Vec::new();
    for d in 0..30 {
        for file in 0..20 {
            lines.push(format!("apps/gateway/src/module-{d}/handler-{file}.ts"));
        }
    }
    let f = run_named("ignored", &lines, "mystery");
    assert!(!f.unchanged);
    assert!(has(&f.report, "path-list"));
    assert!(utf16_len(&f.content) < utf16_len(&join(&lines)));
    assert!(
        f.content
            .contains("apps/gateway/src/module-15/handler-0.ts")
    );
    assert!(
        f.content
            .contains("apps/gateway/src/module-15/handler-19.ts")
    );
    assert!(
        f.content
            .contains("... 8 entries omitted from apps/gateway/src/module-15 ...")
    );
}

#[test]
fn command_gated_listings_keep_space_tab_and_unicode_filenames_in_middle_groups() {
    let middle = strs(&[
        "docs/release/release notes.md",
        "docs/release/build\tlog summary.md",
        "docs/release/日本語の設計資料.md",
        "docs/release/ünïcodé nàme.md",
    ]);
    let mut lines = Vec::new();
    for d in 0..12 {
        for file in 0..20 {
            lines.push(format!("docs/section-{d}/chapter-{file}.md"));
        }
    }
    lines.extend(middle.clone());
    for d in 12..24 {
        for file in 0..20 {
            lines.push(format!("docs/section-{d}/chapter-{file}.md"));
        }
    }
    let f = run("find . -type f", &lines);
    assert!(!f.unchanged);
    assert!(has(&f.report, "path-list"));
    for e in &middle {
        assert!(f.content.contains(e.as_str()), "{e}");
    }
}

#[test]
fn command_gated_listings_keep_windows_paths_containing_spaces_in_middle_groups() {
    let middle = strs(&[
        "C:\\proj\\docs\\My Reports\\quarter one.md",
        "C:\\proj\\docs\\My Reports\\quarter two.md",
    ]);
    let mut lines = Vec::new();
    for d in 0..8 {
        for file in 0..20 {
            lines.push(format!("C:\\proj\\src\\module-{d}\\source-{file}.ts"));
        }
    }
    lines.extend(middle.clone());
    for d in 8..16 {
        for file in 0..20 {
            lines.push(format!("C:\\proj\\src\\module-{d}\\source-{file}.ts"));
        }
    }
    let f = run("find . -type f", &lines);
    assert!(!f.unchanged);
    for e in &middle {
        assert!(f.content.contains(e.as_str()), "{e}");
    }
}

#[test]
fn command_gated_listings_still_reject_prose_tables_json_and_coordinates() {
    let mut valid = Vec::new();
    for d in 0..12 {
        for file in 0..20 {
            valid.push(format!("docs/section-{d}/chapter-{file}.md"));
        }
    }
    for invalid in [
        "Build failed because dependency missing",
        "NAME VALUE",
        "src/index.ts:10:error",
        r#"{"path":"src/index.ts"}"#,
        "```",
        "| name | size |",
        "find: 'docs/private': Permission denied",
    ] {
        let middled = cat(&[
            valid[..120].to_vec(),
            strs(&[invalid]),
            valid[120..].to_vec(),
        ]);
        let f = run("find . -type f", &middled);
        assert!(f.unchanged, "{invalid}");
        assert!(f.content.contains(invalid));
    }
    let control = run("find . -type f", &valid);
    assert!(!control.unchanged);
    assert!(has(&control.report, "path-list"));
    assert!(utf16_len(&control.content) < utf16_len(&join(&valid)));
    assert!(
        control
            .content
            .contains("... 8 entries omitted from docs/section-6 ...")
    );
}

fn long_rows() -> Vec<String> {
    gen_lines(60, |i| {
        format!(
            "-rw-r--r--  1 dev  staff  {} Aug  1 09:15 report-{i}-with-long-name.txt",
            1000 + i
        )
    })
}

fn parse_long(input: &BoundedText<'_>) -> String {
    compress_listing(input, "ls", Some("long"), false).into_owned()
}

#[test]
fn long_ls_parsing_charges_its_header_before_allocating_rows() {
    let rows = long_rows();
    let header = "total 4096";
    let text = join(&cat(&[strs(&[header]), rows.clone()]));
    let rendered = attempt(&text, utf16_len(&text) * 8, &parse_long);
    assert_ne!(rendered, text);
    assert!(rendered.starts_with(&format!("{header}\n")));
    assert!(rendered.contains("... 48 entries omitted from . ..."));

    let malformed = join(&cat(&[
        strs(&[header]),
        rows[..40].to_vec(),
        strs(&["locale specific row"]),
        rows[40..].to_vec(),
    ]));
    let (records, output) = record_charges(&malformed, &parse_long);
    assert_eq!(output, malformed);
    assert!(records >= 40);
}

#[test]
fn long_ls_parsing_is_stable_at_and_past_its_budget_limit() {
    let text = join(&cat(&[strs(&["total 4096"]), long_rows()]));
    let minimal = minimal_code_units(&text, &parse_long);
    let generous = attempt(&text, utf16_len(&text) * 8, &parse_long);
    assert_eq!(attempt(&text, minimal, &parse_long), generous);
    assert_eq!(attempt(&text, minimal + 1, &parse_long), generous);
    assert_eq!(attempt(&text, minimal - 1, &parse_long), text);
    assert!(
        generous
            .contains("-rw-r--r--  1 dev  staff  1000 Aug  1 09:15 report-0-with-long-name.txt")
    );
    assert!(generous.contains("... 48 entries omitted from . ..."));
}

#[test]
fn tree_parsing_is_stable_at_and_past_its_budget_limit() {
    let mut lines = strs(&["project"]);
    for d in 0..20 {
        let last = d == 19;
        lines.push(format!("{}module-{d}/", if last { "└── " } else { "├── " }));
        for file in 0..20 {
            lines.push(format!(
                "{}{}source-{file}.ts",
                if last { "    " } else { "│   " },
                if file == 19 {
                    "└── "
                } else {
                    "├── "
                }
            ));
        }
    }
    lines.push("21 directories, 400 files".to_owned());
    let text = join(&lines);
    let parse = |input: &BoundedText<'_>| -> String {
        compress_listing(input, "tree", Some("classified"), true).into_owned()
    };
    let minimal = minimal_code_units(&text, &parse);
    let generous = attempt(&text, utf16_len(&text) * 8, &parse);
    assert_eq!(attempt(&text, minimal, &parse), generous);
    assert_eq!(attempt(&text, minimal + 1, &parse), generous);
    assert_eq!(attempt(&text, minimal - 1, &parse), text);
    assert!(generous.contains("... 8 directories omitted containing 160 entries ..."));
    assert!(generous.contains("├── module-14/"));
    assert!(generous.contains("... 8 entries omitted from project/module-14 ..."));
    assert!(generous.contains("21 directories, 400 files"));

    let unsummarized = join(&lines[..lines.len() - 1]);
    let (records, output) = record_charges(&unsummarized, &parse);
    assert_eq!(output, unsummarized);
    assert!(records >= (lines.len() - 1) as u64);
}
