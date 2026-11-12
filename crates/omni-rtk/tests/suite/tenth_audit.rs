//! `packages/rtk/test/tenth-audit.test.ts`.

use super::common::*;

fn tree_rows() -> Vec<String> {
    let mut lines = strs(&["project"]);
    for d in 0..42 {
        let connector = if d == 41 { "└── " } else { "├── " };
        lines.push(format!("{connector}dir-{d}/"));
        lines.push(format!("│   └── child-{d}.ts"));
    }
    lines.push("42 directories, 42 files".to_owned());
    lines
}

#[test]
fn tree_never_retains_a_child_without_its_directory_ancestor() {
    let f = run("tree -F", &tree_rows());
    assert!(has(&f.report, "tree-output"));
    for d in 0..42 {
        let child = format!("child-{d}.ts");
        if let Some(child_at) = f.content.find(&child) {
            let ancestor = format!("{}dir-{d}/", if d == 41 { "└── " } else { "├── " });
            let at = f.content.find(&ancestor).expect("ancestor retained");
            assert!(at < child_at);
        }
    }
}

#[test]
fn listing_group_marker_stays_between_complete_group_fragments() {
    let mut lines = Vec::new();
    for g in 0..42 {
        lines.push(format!("./dir-{g}:"));
        for e in 0..15 {
            lines.push(format!("file-{g}-{e}.ts"));
        }
    }
    let content = run("ls -R .", &lines).content;
    let marker = content
        .find("directories omitted containing")
        .expect("marker");
    assert!(marker > content.find("./dir-19:").expect("19"));
    assert!(marker < content.find("./dir-22:").expect("22"));
}

#[test]
fn grep_range_markers_stay_between_complete_file_fragments() {
    let mut lines = Vec::new();
    for file in 0..42 {
        for m in 0..15 {
            lines.push(format!(
                "src/file-{file}.ts:{}:{}{file}-{m}",
                m + 1,
                "detail-".repeat(3)
            ));
        }
    }
    let content = run("rg -n pattern src", &lines).content;
    let marker = content.find("files omitted containing").expect("marker");
    assert!(marker > content.find("src/file-19.ts:15:").expect("19"));
    assert!(marker < content.find("src/file-22.ts:1:").expect("22"));
}

#[test]
fn grep_exceptions_retain_input_order_and_split_omitted_ranges() {
    let mut lines = Vec::new();
    for file in 0..44 {
        let count = if file == 21 { 1 } else { 2 };
        for m in 0..count {
            lines.push(format!(
                "src/file-{file}.ts:{}:{}{file}-{m}",
                m + 1,
                "matched-detail-".repeat(2)
            ));
        }
    }
    let content = run("rg -n pattern src", &lines).content;
    let at = |s: &str| content.find(s).expect(s);
    assert!(at("src/file-19.ts:1:") < at("src/file-21.ts:1:"));
    assert!(at("src/file-21.ts:1:") < at("src/file-24.ts:1:"));
    assert!(!content.contains("src/file-20.ts:1:"));
    assert!(!content.contains("src/file-22.ts:1:"));
    // `/files? omitted containing/g`: "files omitted containing" also
    // contains "s omitted containing", so the two counts are disjoint.
    let markers = content.matches("file omitted containing").count()
        + content.matches("files omitted containing").count();
    assert_eq!(markers, 2);
}

#[test]
fn package_warning_marker_precedes_final_manager_summary() {
    let mut lines = gen_lines(25, |i| {
        format!("npm warn warning-{i}-{}", "diagnostic-detail-".repeat(2))
    });
    lines.push("added 25 packages in 2s".to_owned());
    let content = run("npm install", &lines).content;
    assert!(content.contains("... 5 warnings omitted ..."));
    assert!(content.ends_with("added 25 packages in 2s"));
}
