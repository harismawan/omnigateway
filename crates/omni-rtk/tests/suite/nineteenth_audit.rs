//! Audit regression suite: git anchor retention (combined diffs, binary
//! patches, stat/log rows) and unknown-origin detection bounds.

use super::common::*;
use regex::Regex;
use std::collections::HashMap;

fn real_omitted(f: &Fixture) -> u64 {
    (f.lines.len() - retained_rows(&f.content)) as u64
}

fn quoted_patch(path: &str) -> Vec<String> {
    vec![
        format!("diff --git a/{path} b/{path}"),
        format!("--- a/{path}"),
        format!("+++ b/{path}"),
        "@@ -1,2 +1,2 @@".to_owned(),
    ]
}

fn yaml_values() -> Vec<String> {
    let mut lines = cat(&[
        strs(&["# values.yaml for the gateway chart"]),
        quoted_patch("values.yaml"),
    ]);
    for i in 0..250 {
        lines.push(format!(
            "  limitEntry{i}: \"the important configured value number {i}\""
        ));
    }
    lines
}

fn java_stack_trace() -> Vec<String> {
    let mut lines = cat(&[
        strs(&["Exception in thread \"main\" java.lang.IllegalStateException: broken"]),
        quoted_patch("Frame.java"),
    ]);
    for i in 0..250 {
        lines.push(format!(
            "    at com.example.gateway.Frame{i}.invoke(Frame{i}.java:{})",
            i + 10
        ));
    }
    lines
}

fn markdown_with_code_block() -> Vec<String> {
    let mut lines = cat(&[
        strs(&["# Runbook"]),
        quoted_patch("runbook.sh"),
        strs(&["Indented code block follows:", ""]),
    ]);
    for i in 0..250 {
        lines.push(format!(
            "    const importantRunbookStep{i} = \"operator action {i}\";"
        ));
    }
    lines
}

fn tree_text() -> Vec<String> {
    let mut lines = cat(&[strs(&["packages/"]), quoted_patch("tree.txt")]);
    for i in 0..250 {
        lines.push(format!(
            " |-- module-{i}/  containing the important source file {i}"
        ));
    }
    lines
}

fn pipe_table() -> Vec<String> {
    let mut lines = cat(&[
        strs(&[" | Setting | Default | Description |"]),
        quoted_patch("settings.md"),
        strs(&[" |---|---|---|"]),
    ]);
    for i in 0..250 {
        lines.push(format!(
            " | option{i} | off | the important documented behaviour {i} |"
        ));
    }
    lines
}

#[test]
fn generic_reads_are_never_hijacked_by_git_output_shape() {
    let fixtures: Vec<(&str, &str, Vec<String>, &str)> = vec![
        (
            "a YAML values file",
            "cat charts/gateway/values.yaml",
            yaml_values(),
            "  limitEntry90: \"the important configured value number 90\"",
        ),
        (
            "a Java stack trace",
            "cat /tmp/crash.log",
            java_stack_trace(),
            "    at com.example.gateway.Frame90.invoke(Frame90.java:100)",
        ),
        (
            "Markdown with an indented code block",
            "cat docs/RUNBOOK.md",
            markdown_with_code_block(),
            "    const importantRunbookStep90 = \"operator action 90\";",
        ),
        (
            "a tree listing saved as text",
            "sed -n 1,400p tree.txt",
            tree_text(),
            " |-- module-90/  containing the important source file 90",
        ),
        (
            "a one-space-indented pipe table",
            "cat docs/settings.md",
            pipe_table(),
            " | option90 | off | the important documented behaviour 90 |",
        ),
    ];
    for (name, command, lines, middle) in fixtures {
        let f = run(command, &lines);
        expect_compressed(&f, "numbered-read");
        for id in ["git-diff", "git-log", "git-status"] {
            assert!(!has(&f.report, id), "{name}: {id}");
        }
        assert_eq!(retained_rows(&f.content), 150, "{name}");
        assert!(f.content.contains(middle), "{name}");
        assert!(f.content.contains(lines[0].as_str()));
        assert!(f.content.contains(lines[lines.len() - 1].as_str()));
        assert_eq!(omitted_total(&f.content), (lines.len() - 150) as u64);
    }
}

#[test]
fn prose_quoting_a_diff_hunk_still_stays_a_numbered_read() {
    let mut lines = strs(&[
        "# Release notes",
        "diff --git a/deploy.sh b/deploy.sh",
        "--- a/deploy.sh",
        "+++ b/deploy.sh",
        "@@ -10,6 +10,6 @@",
    ]);
    for i in 0..300 {
        lines.push(format!(
            "IMPORTANT MIDDLE NOTE {i}: operators must rotate the key."
        ));
    }
    let f = run("cat docs/RELEASE.md", &lines);
    expect_compressed(&f, "numbered-read");
    assert!(!has(&f.report, "git-diff"));
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn an_uncorrelated_diff_still_infers_git_diff_and_keeps_every_changed_row() {
    let mut lines = strs(&[
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
    ]);
    for h in 0..40 {
        lines.push(format!("@@ -{0},4 +{0},4 @@", h * 10 + 1));
        lines.push(format!(
            "   context row before hunk {h} carrying no marker at all"
        ));
        lines.push(format!("-const removedCritical{h} = {h};"));
        lines.push(format!("+const addedCritical{h} = {h};"));
        lines.push(format!(
            "   context row after hunk {h} carrying no marker at all"
        ));
    }
    let f = run_orphan(&lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "git-diff"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    for h in 0..40 {
        assert!(
            f.content
                .contains(&format!("-const removedCritical{h} = {h};"))
        );
        assert!(
            f.content
                .contains(&format!("+const addedCritical{h} = {h};"))
        );
    }
}

#[test]
fn an_uncorrelated_status_block_still_infers_git_status() {
    let mut lines = strs(&[
        "On branch main",
        "Changes not staged for commit:",
        "  (use \"git add <file>...\" to update what will be committed)",
    ]);
    for i in 0..60 {
        lines.push(format!("\tmodified:   packages/module-{i}/src/index.ts"));
        lines.push(String::new());
    }
    lines.push("no changes added to commit (use \"git add\" and/or \"git commit -a\")".to_owned());
    let f = run_orphan(&lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "git-status"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    for i in 0..60 {
        assert!(
            f.content
                .contains(&format!("\tmodified:   packages/module-{i}/src/index.ts"))
        );
    }
}

#[test]
fn the_same_yaml_with_no_command_still_infers_git_diff_exactly_as_before() {
    assert!(has(&run_orphan(&yaml_values()).report, "git-diff"));
}

fn filler(count: usize, label: &str) -> Vec<String> {
    gen_lines(count, |i| format!("   {label} context row {i}"))
}

fn conflicted_merge_corpus() -> Vec<String> {
    let mut lines = Vec::new();
    for i in 0..7 {
        lines.push(format!("diff --cc conflicted-{i}.txt"));
        lines.push(format!("index 78bce4f,45d560{i}..0000000"));
        if i == 2 {
            lines.push("mode 100644,100755..100644".to_owned());
        }
        lines.push(format!("--- a/conflicted-{i}.txt"));
        lines.push(format!("+++ b/conflicted-{i}.txt"));
        lines.push(format!("@@@ -{0},3 -{0},3 +{0},9 @@@", i * 10 + 1));
        lines.push("++<<<<<<< HEAD".to_owned());
        lines.push(format!(" +OURS-{i}-alpha"));
        lines.push(format!(" +OURS-{i}-beta"));
        lines.push(format!(" +OURS-{i}-gamma"));
        lines.push("++=======".to_owned());
        lines.push(format!("+ THEIRS-{i}-alpha"));
        lines.push(format!("+ THEIRS-{i}-gamma"));
        lines.push("++>>>>>>> theirs".to_owned());
        lines.push(format!("   shared context row {i} present in both parents"));
    }
    lines
}

fn octopus_corpus() -> Vec<String> {
    let mut lines = Vec::new();
    for i in 0..9 {
        lines.push(format!("diff --combined octopus-{i}.txt"));
        lines.push(format!("index de9804{i},de9804{i},de9804{i}..4d0dc1f"));
        lines.push(format!("--- a/octopus-{i}.txt"));
        lines.push(format!("+++ b/octopus-{i}.txt"));
        lines.push(format!("@@@@ -{0},3 -{0},3 -{0},3 +{0},3 @@@@", i + 1));
        lines.push(format!("---removed-from-every-parent-{i}"));
        lines.push(format!("+++THREEWAY-RESOLUTION-{i}"));
        lines.push(format!("   unchanged tail row {i}"));
    }
    lines
}

fn wide_octopus_corpus(parents: usize, files: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let column = |marked: usize| -> String {
        (0..parents)
            .map(|i| if i == marked { '-' } else { ' ' })
            .collect()
    };
    for file in 0..files {
        let hashes = (0..parents)
            .map(|i| format!("{i}{file}bcdef"))
            .collect::<Vec<_>>()
            .join(",");
        lines.push(format!("diff --combined file{file}.txt"));
        lines.push(format!("index {hashes}..a{file}00000"));
        lines.push(format!("--- a/file{file}.txt"));
        lines.push(format!("+++ b/file{file}.txt"));
        let at = "@".repeat(parents + 1);
        let ranges = vec!["-5,5"; parents].join(" ");
        lines.push(format!("{at} -5,4 {ranges} +5,{} {at} BASE-", parents + 3));
        for row in 5..=7 {
            lines.push(format!("{}BASE-{row}", " ".repeat(parents)));
        }
        lines.push(format!("-{}BASE-8", " ".repeat(parents - 1)));
        lines.push(format!(
            " {}{}SHARED-BY-EARLY-{file}",
            "-".repeat(parents.saturating_sub(2).max(1)),
            if parents > 2 { " " } else { "" }
        ));
        lines.push(format!("{}ONLY-IN-LAST-{file}", column(parents - 1)));
        lines.push(format!("{}MERGED-{file}", "+".repeat(parents)));
        for tip in 1..=parents {
            let row = format!(
                "{} {}TIP-{tip}-{file}",
                "+".repeat(tip - 1),
                "+".repeat(parents - tip)
            );
            // `.replace(/ +$/, " ")`: the rows never end in spaces, so a no-op.
            lines.push(row);
        }
    }
    lines
}

fn binary_patch_corpus() -> Vec<String> {
    let mut lines = Vec::new();
    for i in 0..6 {
        lines.push(format!("diff --git a/asset-{i}.bin b/asset-{i}.bin"));
        lines.push(format!("index 553605b{i}..928a0e1{i} 100644"));
        lines.push("GIT binary patch".to_owned());
        lines.push(format!("literal {}", 900 + i));
        for row in 0..14 {
            lines.push(format!(
                "zcmV-~1AF{{HFCiR!Xi~8ETUD!L@sG2Rx9+VT+jsMLy5+@cgXR$(b_i1nu&cZ6Ls{i}{row}"
            ));
        }
        lines.push(String::new());
        lines.push(if i % 2 == 0 {
            format!("literal {}", 800 + i)
        } else {
            format!("delta {}", 80 + i)
        });
        for row in 0..9 {
            lines.push(format!(
                "zv?9}}2^wtlQOD4W6i<hkko~1_r@MWzsZU<oDS))pVj%rsw-DGD`Shk6Xu{i}{row}"
            ));
        }
        lines.push(String::new());
    }
    lines
}

fn generated_diff_corpus() -> Vec<Vec<String>> {
    let mut corpus = Vec::new();
    let mut renames = strs(&[
        "diff --git a/old/a0.ts b/new/a0.ts",
        "--- a/old/a0.ts",
        "+++ b/new/a0.ts",
    ]);
    for i in 0..200 {
        renames.push(format!("rename from packages/old/module-{i}.ts"));
        renames.push(format!("rename to packages/new/module-{i}.ts"));
    }
    corpus.push(cat(&[renames, filler(120, "rename")]));
    let mut binary = strs(&[
        "diff --git a/assets/i0.png b/assets/i0.png",
        "--- a/assets/i0.png",
        "+++ b/assets/i0.png",
    ]);
    for i in 0..150 {
        binary.push(format!(
            "Binary files a/assets/image-{i}.png and b/assets/image-{i}.png differ"
        ));
    }
    corpus.push(cat(&[binary, filler(120, "binary")]));
    let mut modes = strs(&["diff --git a/src/m.ts b/src/m.ts", "@@ -1,2 +1,2 @@"]);
    for i in 0..120 {
        modes.push("old mode 100644".to_owned());
        modes.push("new mode 100755".to_owned());
        modes.push(format!("index {i:07x}..{i}bbbbbb 100644"));
        modes.push(format!("similarity index {}%", i % 100));
        modes.push(format!(
            "   plain context row {i} that carries no anchor whatsoever"
        ));
    }
    corpus.push(modes);
    corpus.push(cat(&[conflicted_merge_corpus(), filler(120, "conflict")]));
    corpus.push(cat(&[octopus_corpus(), filler(120, "octopus")]));
    corpus.push(cat(&[binary_patch_corpus(), filler(120, "binary-patch")]));
    corpus.push(cat(&[wide_octopus_corpus(5, 3), filler(120, "octopus-5")]));
    corpus.push(cat(&[wide_octopus_corpus(6, 3), filler(120, "octopus-6")]));
    corpus.push(cat(&[wide_octopus_corpus(8, 2), filler(120, "octopus-8")]));
    corpus
}

fn abbreviated_log_corpus() -> Vec<String> {
    let mut lines = Vec::new();
    for i in 0..17 {
        lines.push(format!(
            "commit {i:04x}{}",
            if i == 3 {
                " (HEAD -> main, tag: v1.0)"
            } else {
                ""
            }
        ));
        lines.push("Author: Example Developer <developer@example.com>".to_owned());
        lines.push("Date:   Mon Aug 10 19:43:18 2026 +0700".to_owned());
        lines.push(String::new());
        lines.push(format!("    fix(area{i}): abbreviated subject {i}"));
        lines.push(String::new());
        lines.push("    Rationale:".to_owned());
        lines.push(format!("      - first critical bullet {i}"));
        if i < 6 {
            lines.push(format!("      - second critical bullet {i}"));
        }
        if i < 11 {
            lines.push(format!("        indentedCodeSnippet{i}();"));
        }
        if i < 5 {
            lines.push(format!("    \ttab rendered body line {i}"));
        }
        lines.push(format!("    Refs: #{i}"));
        lines.push(String::new());
    }
    cat(&[lines, filler(120, "abbrev")])
}

fn generated_log_corpus() -> Vec<Vec<String>> {
    let mut corpus = Vec::new();
    let mut fuller = Vec::new();
    for i in 0..40 {
        fuller.push(format!("commit {i:040x}"));
        fuller.extend(strs(&[
            "Author:     Example Developer <developer@example.com>",
            "AuthorDate: Mon Aug 10 19:43:18 2026 +0700",
            "Commit:     Example Maintainer <maintainer@example.com>",
            "CommitDate: Tue Aug 11 08:02:00 2026 +0700",
            "",
        ]));
        fuller.push(format!(
            "    subject line for commit number {i} in the fuller format"
        ));
        fuller.push(String::new());
    }
    corpus.push(cat(&[fuller, filler(120, "fuller")]));
    let mut decorated = Vec::new();
    for i in 0..40 {
        decorated.push(format!("commit {i:040x}"));
        decorated.push(format!("Merge: {i}aaaaaa {i}bbbbbb"));
        decorated.push(format!(
            "Reflog: HEAD@{{{i}}} (Example Developer <developer@example.com>)"
        ));
        decorated.push(format!("Tag: v1.{i}.0"));
        decorated.push("Author: Example Developer <developer@example.com>".to_owned());
        decorated.push("Date:   Mon Aug 10 19:43:18 2026 +0700".to_owned());
        decorated.push(String::new());
        decorated.push(format!("    subject line for decorated commit {i}"));
        decorated.push(format!(
            " packages/module/src/file-{i}.ts | {} +++--",
            i % 9
        ));
        decorated.push(" 1 file changed, 3 insertions(+), 2 deletions(-)".to_owned());
        decorated.push(String::new());
    }
    corpus.push(cat(&[decorated, filler(120, "decorated")]));
    corpus.push(abbreviated_log_corpus());
    corpus
}

fn stat_log_corpus() -> Vec<String> {
    let mut lines = Vec::new();
    for i in 0..40 {
        lines.push(format!("commit {i:040x}"));
        lines.push("Author: Example Developer <developer@example.com>".to_owned());
        lines.push("Date:   Mon Aug 10 19:43:18 2026 +0700".to_owned());
        lines.push(String::new());
        lines.push(format!("    subject line for stat commit {i}"));
        lines.push(String::new());
        lines.push(format!(
            " apps/gateway/src/critical-file-{i}.ts | {} ++++++++-----",
            i + 2
        ));
        lines.push(format!(
            " packages/store/src/schema-{i}.ts      | {} +++--",
            (i % 7) + 1
        ));
        lines.push(" 2 files changed, 9 insertions(+), 4 deletions(-)".to_owned());
        lines.push(String::new());
    }
    cat(&[lines, filler(120, "stat")])
}

/// The test's own independent grammar (not from production). Fixture rows
/// are ASCII, so Rust and JS `\s`/`\d` agree.
fn diff_document_row() -> Regex {
    Regex::new(r"^(?:diff --(?:git|cc|combined) |--- |\+\+\+ |@@+ |index [0-9a-f]+(?:,[0-9a-f]+)*\.\.|mode [0-7]+(?:,[0-7]+)*\.\.|(?:old|new|new file|deleted file) mode |(?:similarity|dissimilarity) index |(?:rename|copy) (?:from|to) |Binary files |GIT binary patch$|(?:literal|delta) \d+$|\\ No newline|[ +-]*[-+]| .+files? changed)").expect("regex")
}

fn log_document_row() -> Regex {
    Regex::new(r"^(?:commit [0-9a-f]{4,}|Author:|AuthorDate:|Commit:|CommitDate:|Date:|Merge: |Reflog:|Tag:| {4}[ \t]*\S| \S.*\|\s+\d+| .+files? changed)").expect("regex")
}

/// `(label, command, family, independent row grammar, blocks)`.
type AnchorCase = (
    &'static str,
    &'static str,
    &'static str,
    Regex,
    Vec<Vec<String>>,
);

#[test]
fn every_detected_git_anchor_row_survives_retention() {
    let cases: Vec<AnchorCase> = vec![
        (
            "git diff",
            "git diff",
            "git-diff",
            diff_document_row(),
            generated_diff_corpus(),
        ),
        ("git log", "git log", "git-log", log_document_row(), {
            let mut blocks = generated_log_corpus();
            blocks.push(stat_log_corpus());
            blocks
        }),
    ];
    for (label, command, id, row, blocks) in cases {
        for (index, lines) in blocks.iter().enumerate() {
            let f = run(command, lines);
            expect_compressed(&f, id);
            let mut kept: HashMap<&str, usize> = HashMap::new();
            for line in f.content.split('\n') {
                *kept.entry(line).or_default() += 1;
            }
            let mut missing = Vec::new();
            for line in lines {
                if !row.is_match(line) {
                    continue;
                }
                match kept.get_mut(line.as_str()) {
                    Some(n) if *n > 0 => *n -= 1,
                    _ => missing.push(line.clone()),
                }
            }
            assert!(missing.is_empty(), "{label} block {index}: {missing:?}");
            assert_eq!(
                omitted_total(&f.content),
                real_omitted(&f),
                "{label} {index}"
            );
        }
    }
}

#[test]
fn plain_git_diff_during_a_conflicted_merge_keeps_ours_theirs_and_the_cc_headers() {
    let lines = cat(&[conflicted_merge_corpus(), filler(120, "conflict")]);
    let f = run("git diff", &lines);
    expect_compressed(&f, "git-diff");
    for i in 0..7 {
        for s in [
            format!("diff --cc conflicted-{i}.txt"),
            format!("index 78bce4f,45d560{i}..0000000"),
            format!("@@@ -{0},3 -{0},3 ", i * 10 + 1),
            format!(" +OURS-{i}-alpha"),
            format!(" +OURS-{i}-beta"),
            format!(" +OURS-{i}-gamma"),
            format!("+ THEIRS-{i}-alpha"),
            format!("+ THEIRS-{i}-gamma"),
        ] {
            assert!(f.content.contains(&s), "{s}");
        }
    }
    assert!(f.content.contains("mode 100644,100755..100644"));
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn a_three_parent_octopus_combined_diff_keeps_its_four_at_hunks_and_three_column_rows() {
    let lines = cat(&[octopus_corpus(), filler(120, "octopus")]);
    let f = run("git diff", &lines);
    expect_compressed(&f, "git-diff");
    for i in 0..9 {
        for s in [
            format!("diff --combined octopus-{i}.txt"),
            format!("@@@@ -{0},3 -{0},3 ", i + 1),
            format!("---removed-from-every-parent-{i}"),
            format!("+++THREEWAY-RESOLUTION-{i}"),
        ] {
            assert!(f.content.contains(&s), "{s}");
        }
    }
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

const PARENT_SWEEP: [usize; 9] = [3, 5, 6, 7, 8, 12, 17, 18, 20];

#[test]
fn wide_octopus_combined_diffs_keep_both_sides_of_every_hunk() {
    for parents in PARENT_SWEEP {
        let lines = cat(&[
            wide_octopus_corpus(parents, 3),
            filler(120, &format!("octopus-{parents}")),
        ]);
        let f = run("git diff", &lines);
        expect_compressed(&f, "git-diff");
        for file in 0..3 {
            let mut needles = vec![
                format!("diff --combined file{file}.txt"),
                format!("{} -5,4 ", "@".repeat(parents + 1)),
                format!("ONLY-IN-LAST-{file}"),
                format!("SHARED-BY-EARLY-{file}"),
                format!("{}MERGED-{file}", "+".repeat(parents)),
            ];
            needles.extend((1..=parents).map(|tip| format!("TIP-{tip}-{file}")));
            for s in needles {
                assert!(f.content.contains(&s), "{parents}: {s}");
            }
        }
        assert_eq!(omitted_total(&f.content), real_omitted(&f), "{parents}");
    }
}

fn column_class(line: &str, parents: usize) -> Option<String> {
    let header =
        Regex::new(r"^(?:diff |index |mode |--- |\+\+\+ |@@|Binary files |GIT binary patch)")
            .expect("regex");
    if header.is_match(line) {
        return None;
    }
    // `line.slice(0, parents)`: fixture rows are ASCII, so bytes are units.
    let prefix = line.get(..parents)?;
    if prefix.chars().any(|c| !matches!(c, ' ' | '+' | '-')) {
        return None;
    }
    let minus = prefix.matches('-').count();
    let plus = prefix.matches('+').count();
    (minus + plus != 0).then(|| format!("{parents}p:{minus}-:{plus}+"))
}

fn asymmetric_classes(
    lines: &[String],
    content: &str,
    parents: usize,
) -> Vec<(String, usize, usize)> {
    let mut remaining: HashMap<&str, usize> = HashMap::new();
    for line in content.split('\n') {
        *remaining.entry(line).or_default() += 1;
    }
    let mut order = Vec::new();
    let mut totals: HashMap<String, usize> = HashMap::new();
    let mut kept: HashMap<String, usize> = HashMap::new();
    for line in lines {
        let Some(key) = column_class(line, parents) else {
            continue;
        };
        if !totals.contains_key(&key) {
            order.push(key.clone());
        }
        *totals.entry(key.clone()).or_default() += 1;
        if let Some(n) = remaining.get_mut(line.as_str()).filter(|n| **n > 0) {
            *n -= 1;
            *kept.entry(key).or_default() += 1;
        }
    }
    order
        .into_iter()
        .filter_map(|key| {
            let total = totals[&key];
            let survived = kept.get(&key).copied().unwrap_or(0);
            (survived != 0 && survived != total).then_some((key, survived, total))
        })
        .collect()
}

#[test]
fn combined_diffs_retain_prefix_column_classes_whole() {
    let mut combined: Vec<(String, usize, Vec<String>)> = vec![
        (
            "a conflicted two-parent merge".to_owned(),
            2,
            cat(&[conflicted_merge_corpus(), filler(120, "conflict")]),
        ),
        (
            "a three-parent octopus".to_owned(),
            3,
            cat(&[octopus_corpus(), filler(120, "octopus")]),
        ),
    ];
    for parents in PARENT_SWEEP {
        combined.push((
            format!("a {parents}-parent octopus"),
            parents,
            cat(&[
                wide_octopus_corpus(parents, 3),
                filler(120, &format!("octopus-{parents}")),
            ]),
        ));
    }
    for (label, parents, lines) in combined {
        let f = run("git diff", &lines);
        expect_compressed(&f, "git-diff");
        assert_eq!(
            asymmetric_classes(&lines, &f.content, parents),
            vec![],
            "{label}"
        );
    }
}

#[test]
fn a_conflicted_merge_retains_as_many_space_plus_rows_as_plus_space_rows() {
    let lines = cat(&[conflicted_merge_corpus(), filler(120, "conflict")]);
    let f = run("git diff", &lines);
    expect_compressed(&f, "git-diff");
    let rows: Vec<&str> = f.content.split('\n').collect();
    assert_eq!(rows.iter().filter(|l| l.starts_with(" +")).count(), 21);
    assert_eq!(rows.iter().filter(|l| l.starts_with("+ ")).count(), 14);
    assert_eq!(
        rows.iter()
            .filter(|l| l.starts_with("++") && !l.starts_with("+++ "))
            .count(),
        21
    );
}

#[test]
fn git_push_ref_pairs_survive_whole() {
    let lines = cat(&[
        gen_lines(20, |i| format!("Enumerating objects: {i}, done.")),
        strs(&["To ../remote.git"]),
        gen_lines(40, |i| {
            format!(" * [new branch]      feat/local-{i} -> feat/remote-{i}")
        }),
        gen_lines(12, |i| {
            format!("   {i}aaaaaa..{i}bbbbbb  main-{i} -> main-{i}")
        }),
        gen_lines(20, |i| format!("Total {i} (delta 0), reused 0 (delta 0)")),
    ]);
    let f = run("git push --all", &lines);
    expect_compressed(&f, "git-operation");
    for i in 0..40 {
        assert!(
            f.content
                .contains(&format!("feat/local-{i} -> feat/remote-{i}"))
        );
    }
    for i in 0..12 {
        assert!(f.content.contains(&format!("main-{i} -> main-{i}")));
    }
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn git_push_rejections_keep_every_ref_pair_by_compression_or_by_fail_safe_retention() {
    let lines = cat(&[
        strs(&["To ../remote.git"]),
        gen_lines(20, |i| {
            format!(" * [new branch]      feat/ok-{i} -> feat/ok-{i}")
        }),
        gen_lines(12, |i| {
            format!(" ! [rejected]        feat/blocked-{i} -> feat/blocked-{i} (non-fast-forward)")
        }),
        strs(&[
            "error: failed to push some refs to '../remote.git'",
            "hint: Updates were rejected because the tip of your current branch is behind",
            "hint: its remote counterpart. If you want to integrate the remote changes,",
        ]),
        gen_lines(40, |i| format!("Total {i} (delta 0), reused 0 (delta 0)")),
    ]);
    let f = run("git push --all", &lines);
    for i in 0..20 {
        assert!(f.content.contains(&format!("feat/ok-{i} -> feat/ok-{i}")));
    }
    for i in 0..12 {
        assert!(
            f.content
                .contains(&format!("feat/blocked-{i} -> feat/blocked-{i}"))
        );
    }
    if f.report.applied {
        assert_eq!(omitted_total(&f.content), real_omitted(&f));
    } else {
        assert_eq!(f.content, f.original);
    }
}

#[test]
fn git_status_rename_and_unmerged_pairs_survive_whole() {
    let lines = cat(&[
        strs(&["On branch main", "Unmerged paths:"]),
        gen_lines(25, |i| format!("\tboth modified:   src/conflict-{i}.ts")),
        strs(&["Changes to be committed:"]),
        gen_lines(30, |i| {
            format!("\trenamed:    src/old-{i}.ts -> src/new-{i}.ts")
        }),
        vec!["  (use \"git restore --staged <file>...\" to unstage)".to_owned(); 15],
    ]);
    let f = run("git status", &lines);
    expect_compressed(&f, "git-status");
    for i in 0..25 {
        assert!(
            f.content
                .contains(&format!("\tboth modified:   src/conflict-{i}.ts"))
        );
    }
    for i in 0..30 {
        assert!(
            f.content
                .contains(&format!("src/old-{i}.ts -> src/new-{i}.ts"))
        );
    }
}

#[test]
fn every_git_binary_patch_and_literal_delta_marker_survives_while_payload_collapses() {
    let lines = cat(&[binary_patch_corpus(), filler(120, "binary-patch")]);
    let f = run("git diff --binary", &lines);
    expect_compressed(&f, "git-diff");
    for i in 0..6 {
        assert!(
            f.content
                .contains(&format!("diff --git a/asset-{i}.bin b/asset-{i}.bin"))
        );
        assert!(f.content.contains(&format!("literal {}", 900 + i)));
        let reverse = if i % 2 == 0 {
            format!("literal {}", 800 + i)
        } else {
            format!("delta {}", 80 + i)
        };
        assert!(f.content.contains(&reverse));
    }
    assert_eq!(
        f.content
            .split('\n')
            .filter(|l| *l == "GIT binary patch")
            .count(),
        6
    );
    let payload = f
        .content
        .split('\n')
        .filter(|l| {
            let b = l.as_bytes();
            b.first() == Some(&b'z')
                && b.get(1).is_some_and(u8::is_ascii_alphanumeric)
                && l.len() > 40
        })
        .count();
    assert!(payload < 138);
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn every_per_file_stat_row_survives_alongside_the_files_changed_roll_up() {
    let lines = stat_log_corpus();
    let f = run("git log --stat", &lines);
    expect_compressed(&f, "git-log");
    for i in 0..40 {
        assert!(
            f.content
                .contains(&format!("apps/gateway/src/critical-file-{i}.ts |"))
        );
        assert!(
            f.content
                .contains(&format!("packages/store/src/schema-{i}.ts      |"))
        );
    }
    assert!(
        f.content
            .contains(" 2 files changed, 9 insertions(+), 4 deletions(-)")
    );
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn every_abbreviated_commit_header_and_indented_body_row_is_kept() {
    let lines = abbreviated_log_corpus();
    let f = run("git log --abbrev-commit --abbrev=4 --decorate", &lines);
    expect_compressed(&f, "git-log");
    for i in 0..17 {
        assert!(f.content.contains(&format!("commit {i:04x}")));
        assert!(
            f.content
                .contains(&format!("      - first critical bullet {i}"))
        );
    }
    assert!(f.content.contains("commit 0003 (HEAD -> main, tag: v1.0)"));
    for i in 0..11 {
        assert!(
            f.content
                .contains(&format!("        indentedCodeSnippet{i}();"))
        );
    }
    for i in 0..5 {
        assert!(
            f.content
                .contains(&format!("    \ttab rendered body line {i}"))
        );
    }
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn prose_beginning_with_the_word_commit_is_still_not_log_evidence() {
    let mut lines = strs(&[
        "# Contributing",
        "commit a change to the parser before opening the review",
        "commit beadaebeef because the hash prefix is followed by ordinary prose",
        "Author: names in prose are not a git log either",
    ]);
    for i in 0..300 {
        lines.push(format!(
            "IMPORTANT MIDDLE GUIDANCE {i}: never rewrite a published branch."
        ));
    }
    assert!(!has(&run_orphan(&lines).report, "git-log"));
}

#[test]
fn a_tab_indented_makefile_is_still_not_a_commit_body() {
    let mut lines = strs(&[
        "all: build test",
        "commit 0000 is mentioned in this prose line only",
    ]);
    for i in 0..300 {
        lines.push(format!("\tgo build ./cmd/tool-{i}"));
    }
    assert!(!has(&run_orphan(&lines).report, "git-log"));
}

#[test]
fn widened_diff_anchors_do_not_widen_unknown_origin_detection() {
    let documents: Vec<(&str, Vec<String>)> = vec![
        (
            "a multi-document YAML manifest",
            cat(&[
                strs(&["---", "apiVersion: apps/v1", "kind: Deployment"]),
                gen_lines(120, |i| format!("  - name: sidecar-{i}")),
                strs(&["---"]),
                gen_lines(120, |i| format!("  - name: volume-{i}")),
            ]),
        ),
        (
            "Markdown with a fenced diff sample carrying no header",
            cat(&[
                strs(&[
                    "# Upgrade guide",
                    "```diff",
                    "--- a/config.toml",
                    "+++ b/config.toml",
                    "@@@ -1,2 +1,2 @@@",
                    "```",
                ]),
                gen_lines(200, |i| format!("Step {i}: rotate the signing key.")),
            ]),
        ),
        (
            "a Python traceback quoting dashes and pluses",
            cat(&[
                strs(&["Traceback (most recent call last):"]),
                gen_lines(200, |i| {
                    format!(
                        "  File \"/srv/app/module_{i}.py\", line {}, in handler",
                        i + 4
                    )
                }),
                strs(&["ValueError: --- unexpected +++ token"]),
            ]),
        ),
        (
            "a changelog with horizontal rules",
            cat(&[
                strs(&["# Changelog", "--- "]),
                gen_lines(200, |i| format!("- fixed defect {i} in the router")),
                strs(&["+++ "]),
            ]),
        ),
        (
            "a Makefile with tab recipes and dash-prefixed commands",
            cat(&[
                strs(&["all: build test"]),
                gen_lines(200, |i| format!("\t-rm -f build/artifact-{i}.o")),
                strs(&["\t@echo done"]),
            ]),
        ),
    ];
    for (name, lines) in documents {
        assert!(!has(&run_orphan(&lines).report, "git-diff"), "{name}");
    }
}

#[test]
fn combined_diff_header_plus_pair_is_still_real_evidence_when_origin_is_unknown() {
    let f = run_orphan(&cat(&[conflicted_merge_corpus(), filler(120, "conflict")]));
    assert!(has(&f.report, "git-diff"));
}

#[test]
fn verbatim_tsc_output_with_an_in_n_files_tail_compresses() {
    let mut lines: Vec<String> = (0..40)
        .map(|i| {
            format!(
                "src/module{i}.ts({},9): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
                i + 3
            )
        })
        .collect();
    lines.extend(strs(&[
        "",
        "Found 40 errors in 12 files.",
        "",
        "Errors  Files",
    ]));
    for i in 0..12 {
        lines.push(format!("     {}  src/module{i}.ts:{}", i + 1, i + 3));
    }
    let f = run("tsc --noEmit", &lines);
    expect_compressed(&f, "lint-output");
    assert!(f.content.contains("Found 40 errors in 12 files."));
    for i in 0..40 {
        assert!(
            f.content
                .contains(&format!("src/module{i}.ts({},9): error TS2345:", i + 3))
        );
    }
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn verbatim_eslint_stylish_output_with_a_parenthesised_breakdown_compresses() {
    let mut lines = strs(&["/work/packages/gateway/src/index.ts"]);
    for i in 0..34 {
        lines.push(format!(
            "  {}:11  warning  'unused{i}' is defined but never used  @typescript-eslint/no-unused-vars",
            i + 4
        ));
    }
    lines.extend(strs(&[
        "  91:1  error  Unexpected console statement  no-console",
        "",
        "✖ 35 problems (1 error, 34 warnings)",
        "  0 errors and 34 warnings potentially fixable with the `--fix` option.",
        "",
    ]));
    let f = run("eslint .", &lines);
    expect_compressed(&f, "lint-output");
    assert!(f.content.contains("✖ 35 problems (1 error, 34 warnings)"));
    assert!(
        f.content
            .contains("  91:1  error  Unexpected console statement  no-console")
    );
    assert!(f.content.contains("... 14 warnings omitted ..."));
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}
