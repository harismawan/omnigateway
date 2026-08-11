import { type BoundedText, MAX_OUTPUT, renderSelection } from "./shared.ts";

// One anchor grammar per Git family, shared by the unknown-origin detector and the line retainer.
// They were duplicated before, with the retainer's copy strictly narrower, so rename pairs, binary
// markers, mode/index rows and `--format=fuller` trailers counted as Git evidence during detection
// and were then silently dropped during retention. Every fragment below appears in exactly one
// place; the detector's evidence probes are built from the same strings.
// Plain `git diff` emits COMBINED-diff grammar, not two-way grammar, for every unmerged path — so
// this is the shape of the working tree during any conflicted merge, rebase, cherry-pick or revert,
// not an exotic mode. Measured from a real 12-file conflicted merge (`git merge`, then `git diff`):
//
//     diff --cc c1.txt
//     index 78bce4f,45d5605..0000000
//     --- a/c1.txt
//     +++ b/c1.txt
//     @@@ -1,3 -1,3 +1,9 @@@
//     ++<<<<<<< HEAD
//      +OURS-1-alpha
//     ++=======
//     + THEIRS-1-alpha
//     ++>>>>>>> theirs
//
// `--- `/`+++ ` matched already, so the pair probe fired and the block routed here — and then the
// retainer dropped 10/12 `diff --cc` headers, 9/12 `@@@` hunk headers, 10/12 combined `index` rows
// and 30/36 OURS-side rows while keeping 36/36 THEIRS-side rows, because ` +OURS` leads with a space
// and `+ THEIRS` does not. One side of every conflict survived and the other did not, with no
// `diff --cc` header left to say the hunk was ever a conflict: the result read as a coherent,
// resolved, one-sided patch. Omission counts stayed exact, so the accounting invariant saw nothing.
//
// A combined diff for N parents prints exactly N prefix columns on every content row, each ` `, `-`
// or `+`, and N+1 `@` characters on the hunk header. Those two counts are NOT the same number, and
// conflating them is what produced an off-by-one here: a bound sized for the `@` run rejects the
// last content column. Measured by building real octopus merges with `git commit-tree -p …` and
// reading `git diff -c HEAD^!`:
//
//     3 parents: `@@@@ … @@@@`      ` - SHARED`   `  -ONLY-IN-LAST`   `+ +TIP-1`
//     5 parents: `@@@@@@ … @@@@@@`  ` --- SHARED` `    -ONLY-IN-LAST` `+ +++TIP-1`
//     6 parents: `@@@@@@@ … @@@@@@@` ` ---- SHARED` `     -ONLY-IN-LAST` `++++ +TIP-4`
//
// So the `@` run is N+1 and generalized (`@@+ `), while the content run is exactly N — a different
// number, and sizing one from the other is what produced the original off-by-one. Since N is a
// property of the merge and not of this file, the content run is generalized too, not bounded at any
// particular N. The old four-column bound dropped every content row whose first `-`/`+` sat in
// column five or later: on a real 6-parent merge, 35 of 40 such rows,
// including both sides of the same hunk (`     -ONLY-IN-LAST-10` and ` ---- SHARED-BY-EARLY-0`),
// leaving the hunk header alone to describe a change with no rows. Omission counts stayed exact, so
// the accounting invariant saw nothing. This is not an exotic path: `command.ts` classifies on the
// `diff` subcommand alone, so `git diff -c <merge>` and `git diff --cc <merge>` route here.
//
// The content column run is therefore UNBOUNDED (`[ +-]*[-+]`). Two earlier rounds picked a bound —
// first four columns, then sixteen — and each time the bound did not fix the defect, it relocated it
// to the first parent count above the bound. Measured on a real 17-parent merge built with
// `git commit-tree -p …` and read through `git diff -c HEAD^!`, the sixteen-column form dropped six
// marker rows (`                -TIP-16` and its per-file siblings) while every hunk header claiming
// them survived and the omission marker stated a generic, exactly-correct count. Do not re-derive a
// bound from anything written here: git imposes no parent limit, so any finite width has a merge
// that defeats it, and the rows lost are the only evidence that a given parent differs at all.
//
// A bound was never buying safety. Unknown-origin detection reads only DIFF_HEADER_ROW and
// DIFF_PAIR_ROW, and classification owns the family when a command is correlated, so the content
// column never participates in deciding whether a document is a Git diff — widening it cannot pull a
// new document into this family, at any width. Measured: a 300-row document of
// `               - deeply indented prose bullet N` classifies as `numbered-read` under a shell
// command and is not compressed at all with unknown origin. Tab-indented prose (Makefile recipes, Go
// source, TSV) is excluded at any width because `\t` is not in `[ +-]`. The only effect of the width
// is compression ratio on documents already routed here, and the acceptance guard already rejects a
// candidate that is not strictly shorter.
const DIFF_HEADER_ROW = "diff --(?:git|cc|combined) ";
const DIFF_PAIR_ROW = "(?:--- |\\+\\+\\+ |@@+ )";
// `GIT binary patch` and its `literal N`/`delta N` size rows are the only statement a `--binary`
// patch makes that a binary file changed at all; the base85 payload under them is genuine bulk and
// stays collapsible. Measured before this change on a real `git diff --binary` with three changed
// blobs: 2 of 3 `GIT binary patch` markers and 5 of 6 `literal` rows were dropped, so the output
// described a text change and silently omitted every binary one.
const DIFF_DETAIL_ROW =
  "(?:index [0-9a-f][0-9a-f,]*\\.\\.|(?:old|new|new file|deleted file) mode |mode [0-7][0-7,]*\\.\\.|(?:similarity|dissimilarity) index |(?:rename|copy) (?:from|to) |Binary files |GIT binary patch$|(?:literal|delta) \\d+$|\\\\ No newline|[ +-]*[-+]| .+files? changed)";
// The hash length floor git actually honours is 4, not 7: `--abbrev=4`, `--abbrev=5`, `--abbrev=6`
// and `core.abbrev=4` all print `commit 9f37` in `--pretty=medium`. A `{7,}` floor dropped every
// header of such a log while `Author:` still supplied body evidence, so the block routed to the log
// retainer and then lost the hashes — it described N commits and named none. The length floor was
// standing in for prose exclusion ("commit a change to the parser"); the row tail does that job
// properly instead. `--decorate` appends ` (HEAD -> main, tag: v1)`, so ` (` must be permitted.
const LOG_COMMIT_ROW = "commit [0-9a-f]{4,}(?: \\(|$)";
// Git indents commit bodies by exactly four spaces, and the body's own indentation is additive: a
// bullet lands at six, a code snippet at eight, so ` {4}\S` kept the heading and dropped the content
// under it. The prefix stays a literal four spaces — that is what excludes tab-indented Makefile
// recipes, Go source and TSV rows, which begin with a tab and never with a space. `[ \t]*` then
// absorbs both deeper space indentation and git's `--no-expand-tabs` rendering of a tab-indented
// body line (four spaces followed by the tab). It is deliberately not `\s*`: `\s` matches a newline,
// and these fragments are also compiled with `m` for detection, where a four-space blank line would
// then reach across into the next row and count as body evidence.
const LOG_BODY_ROW = "(?:Author:|Date:| {4}[ \\t]*\\S)";
// ` \S.*\|\s+\d+` is the per-file `--stat` row (` path/to/file.ts | 42 ++++---`). Without it the
// roll-up ` 2 files changed, …` survived while every file it counts was dropped, so a `git log
// --stat` block stated a file count and named no file.
const LOG_DETAIL_ROW =
  "(?:Merge: |AuthorDate:|Commit:|CommitDate:|Reflog:|Tag:| \\S.*\\|\\s+\\d+| .+files? changed)";
// A log is blank-separated: header, blank, indented body, blank, stat rows, blank. Retaining the
// content rows without the separators leaves a one-row hole between almost every pair of kept rows,
// and each hole costs a ~26-character omission marker in place of a zero-length line — the rendered
// candidate then grows past the original and the acceptance guard rejects the whole block. Keeping
// blanks is what makes retaining the surrounding rows possible at all.
const LOG_SEPARATOR_ROW = "\\s*$";

/** Rows a `git-diff` retainer must keep; also the detector's definition of diff evidence. */
export const GIT_DIFF_ANCHOR = new RegExp(
  `^(?:${DIFF_HEADER_ROW}|${DIFF_PAIR_ROW}|${DIFF_DETAIL_ROW})`,
);
// Deliberate, stated trade — do not "fix" this by merging the diff fragments in. `git log -p` emits
// both grammars but classifies as `git-log` (command.ts), so it is retained by the log anchor alone
// and its patch hunks are collapsed: measured on a 30-commit `git log -p`, 27 of 30 changed rows and
// 28 of 30 `diff --git` headers are dropped at ratio 0.481. That loss is accounted for — every
// dropped row is covered by an omission marker — and the spec's priority list gives one family per
// command, so a block cannot be retained under two. Widening the log anchor with diff grammar would
// also widen unknown-origin log detection into ordinary patch text. The omission is correct and
// stated; only the ordering is unstated, and it is recorded here.
/** Rows a `git-log` retainer must keep; also the detector's definition of log evidence. */
export const GIT_LOG_ANCHOR = new RegExp(
  `^(?:${LOG_COMMIT_ROW}|${LOG_BODY_ROW}|${LOG_DETAIL_ROW}|${LOG_SEPARATOR_ROW})`,
);
export const GIT_DIFF_EVIDENCE_HEADER = new RegExp(`^${DIFF_HEADER_ROW}`, "m");
export const GIT_DIFF_EVIDENCE_PAIR = new RegExp(`^${DIFF_PAIR_ROW}`, "m");
export const GIT_LOG_EVIDENCE_COMMIT = new RegExp(`^${LOG_COMMIT_ROW}`, "m");
export const GIT_LOG_EVIDENCE_BODY = new RegExp(`^${LOG_BODY_ROW}`, "m");

const SEMANTIC =
  /^(?:\* |\+ | {2}|Already on|Switched to|Your branch|HEAD is now|From |To |!?\s*\[| \* | - |error:|fatal:|CONFLICT|Everything up-to-date|Updating |Fast-forward|remote:|## |On branch|rebase |merge |cherry-pick |revert |bisect |[0-9a-f]+\.\.[0-9a-f]+\s+\S+\s+->\s+\S+|\s+\S.+\|\s+\d+|\s+\d+ files? changed|Automatic merge failed|\s+(?:modified|deleted|new file|renamed|copied):)/;
const PROGRESS =
  /^(?:remote: )?(?:Enumerating|Counting|Compressing|Receiving|Resolving|Writing) objects|^(?:remote: )?Total \d+|^\s*\d+% \(|^(?:remote )?progress \d+$/;

export function compressGitOperation(input: BoundedText): string {
  const { text, lines } = input;
  const selected = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.length === 0 || PROGRESS.test(line)) continue;
    if (!SEMANTIC.test(line)) return text;
    selected.add(index);
  }
  if (selected.size === 0) return text;
  let rendered = renderSelection(input, selected);
  if (rendered === undefined) return text;
  // Transfer progress rows leading or trailing the semantic range never reach a gap. Collapsing them
  // is permitted, dropping them unstated is not.
  const indexes = [...selected];
  const leading = Math.min(...indexes);
  const trailing = lines.length - 1 - Math.max(...indexes);
  if (leading > 0) rendered = `... ${leading} lines omitted ...\n${rendered}`;
  if (trailing > 0) rendered = `${rendered}\n... ${trailing} lines omitted ...`;
  return rendered.length <= MAX_OUTPUT ? rendered : text;
}
