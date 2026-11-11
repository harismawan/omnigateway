//! `packages/rtk/src/filters/docker.ts`.

use super::shared::{BoundedText, capped, plain_edges, render_selection};
use crate::jsre::js_regex;
use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};

js_regex!(
    SEMANTIC = r"^(?:#\d+\s+(?:\[[^\]]+\].*(?:FROM|RUN|COPY|ADD|load build definition)|(?:\d+(?:\.\d+)?\s+)?(?:Dockerfile:|ERROR|error|warning|caused|Caused|failed|exit code|exporting|naming|writing|DONE|CACHED|command:|digest:|manifest|provenance))|Dockerfile:\d+|naming to |digest:|manifest |provenance |image id |Step \d+\/\d+|Successfully built|Successfully tagged|ERROR|failed to solve)"
);
js_regex!(
    CONTINUATION = r"^(?:#\d+\s+(?:\d+(?:\.\d+)?\s+)?\s+(?:command:|caused by|Caused by:|at\s)|\s+(?:command:|caused by|Caused by:|at\s)|Dockerfile:\d+)"
);
js_regex!(
    PROGRESS = r"^(?:#\d+\s+\d+(?:\.\d+)?\s+)(?:\d+% transferring|\d+(?:\.\d+)?s$)|^#\d+\s+(?:transferring|extracting|downloading)\b",
    "i"
);
js_regex!(CACHED_WORD = r"\bCACHED\b");
js_regex!(CACHED_TIMING = r"\s+\d+(?:\.\d+)?s$");

/// `compressDocker`.
pub fn compress_docker<'a>(input: &BoundedText<'a>) -> Cow<'a, str> {
    let mut selected = BTreeSet::new();
    let mut cached = HashSet::new();
    for (index, line) in input.lines.iter().enumerate() {
        if line.is_empty() || PROGRESS.test(line) {
            continue;
        }
        if CONTINUATION.test(line) {
            if selected.is_empty() {
                return input.unchanged();
            }
            selected.insert(index);
            continue;
        }
        if !SEMANTIC.test(line) {
            return input.unchanged();
        }
        if CACHED_WORD.test(line) && !cached.insert(CACHED_TIMING.replace_first(line, "")) {
            continue;
        }
        if !input.budget.charge_records(1) {
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
