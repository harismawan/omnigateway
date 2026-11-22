//! The Git anchor grammar shared by the
//! unknown-origin detector and the line retainer, and the operation filter.
//!
//! The fragments are kept verbatim. Combined-diff content columns
//! are unbounded on purpose (`[ +-]*[-+]`): a combined diff for N parents
//! prints N prefix columns per content row (and N+1 `@` on the hunk header),
//! and git imposes no parent limit, so every finite bound has a merge whose
//! marker rows it drops while the hunk headers and omission counts survive.
//! Measured on real octopus merges (`git commit-tree -p …`, `git diff -c
//! HEAD^!`): a four-column bound lost 35 of 40 rows at 6 parents, a sixteen-
//! column one lost rows at 17. The width never decides whether a document is
//! a Git diff (detection reads only the header and pair rows), so widening it
//! cannot pull a new document into this family.

use super::shared::{BoundedText, capped, plain_edges, render_selection};
use crate::jsre::{JsRegex, compile, js_regex};
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::sync::LazyLock;

const DIFF_HEADER_ROW: &str = "diff --(?:git|cc|combined) ";
const DIFF_PAIR_ROW: &str = r"(?:--- |\+\+\+ |@@+ )";
const DIFF_DETAIL_ROW: &str = r"(?:index [0-9a-f][0-9a-f,]*\.\.|(?:old|new|new file|deleted file) mode |mode [0-7][0-7,]*\.\.|(?:similarity|dissimilarity) index |(?:rename|copy) (?:from|to) |Binary files |GIT binary patch$|(?:literal|delta) \d+$|\\ No newline|[ +-]*[-+]| .+files? changed)";
const LOG_COMMIT_ROW: &str = r"commit [0-9a-f]{4,}(?: \(|$)";
const LOG_BODY_ROW: &str = r"(?:Author:|Date:| {4}[ \t]*\S)";
const LOG_DETAIL_ROW: &str =
    r"(?:Merge: |AuthorDate:|Commit:|CommitDate:|Reflog:|Tag:| \S.*\|\s+\d+| .+files? changed)";
const LOG_SEPARATOR_ROW: &str = r"\s*$";

/// `GIT_DIFF_ANCHOR`.
pub(crate) static GIT_DIFF_ANCHOR: LazyLock<JsRegex> = LazyLock::new(|| {
    compile(
        &format!("^(?:{DIFF_HEADER_ROW}|{DIFF_PAIR_ROW}|{DIFF_DETAIL_ROW})"),
        "",
    )
});
/// `GIT_LOG_ANCHOR`.
pub(crate) static GIT_LOG_ANCHOR: LazyLock<JsRegex> = LazyLock::new(|| {
    compile(
        &format!("^(?:{LOG_COMMIT_ROW}|{LOG_BODY_ROW}|{LOG_DETAIL_ROW}|{LOG_SEPARATOR_ROW})"),
        "",
    )
});
/// The `m`-flag evidence probes; callers pass terminator-normalized text.
pub(crate) static GIT_DIFF_EVIDENCE_HEADER: LazyLock<JsRegex> =
    LazyLock::new(|| compile(&format!("^{DIFF_HEADER_ROW}"), "m"));
pub(crate) static GIT_DIFF_EVIDENCE_PAIR: LazyLock<JsRegex> =
    LazyLock::new(|| compile(&format!("^{DIFF_PAIR_ROW}"), "m"));
pub(crate) static GIT_LOG_EVIDENCE_COMMIT: LazyLock<JsRegex> =
    LazyLock::new(|| compile(&format!("^{LOG_COMMIT_ROW}"), "m"));
pub(crate) static GIT_LOG_EVIDENCE_BODY: LazyLock<JsRegex> =
    LazyLock::new(|| compile(&format!("^{LOG_BODY_ROW}"), "m"));

js_regex!(
    SEMANTIC = r"^(?:\* |\+ | {2}|Already on|Switched to|Your branch|HEAD is now|From |To |!?\s*\[| \* | - |error:|fatal:|CONFLICT|Everything up-to-date|Updating |Fast-forward|remote:|## |On branch|rebase |merge |cherry-pick |revert |bisect |[0-9a-f]+\.\.[0-9a-f]+\s+\S+\s+->\s+\S+|\s+\S.+\|\s+\d+|\s+\d+ files? changed|Automatic merge failed|\s+(?:modified|deleted|new file|renamed|copied):)"
);
js_regex!(
    PROGRESS = r"^(?:remote: )?(?:Enumerating|Counting|Compressing|Receiving|Resolving|Writing) objects|^(?:remote: )?Total \d+|^\s*\d+% \(|^(?:remote )?progress \d+$"
);

/// `compressGitOperation`.
pub fn compress_git_operation<'a>(input: &BoundedText<'a>) -> Cow<'a, str> {
    let mut selected = BTreeSet::new();
    for (index, line) in input.lines.iter().enumerate() {
        if line.is_empty() || PROGRESS.test(line) {
            continue;
        }
        if !SEMANTIC.test(line) {
            return input.unchanged();
        }
        selected.insert(index);
    }
    if selected.is_empty() {
        return input.unchanged();
    }
    let Some(rendered) = render_selection(input, &selected, "lines") else {
        return input.unchanged();
    };
    capped(input, plain_edges(input, &selected, rendered))
}
