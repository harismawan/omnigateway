import { type BoundedText, MAX_OUTPUT, renderSelection } from "./shared.ts";

const SEMANTIC =
  /^(?:#\d+\s+(?:\[[^\]]+\].*(?:FROM|RUN|COPY|ADD|load build definition)|(?:\d+(?:\.\d+)?\s+)?(?:Dockerfile:|ERROR|error|warning|caused|Caused|failed|exit code|exporting|naming|writing|DONE|CACHED|command:|digest:|manifest|provenance))|Dockerfile:\d+|naming to |digest:|manifest |provenance |image id |Step \d+\/\d+|Successfully built|Successfully tagged|ERROR|failed to solve)/;
const CONTINUATION =
  /^(?:#\d+\s+(?:\d+(?:\.\d+)?\s+)?\s+(?:command:|caused by|Caused by:|at\s)|\s+(?:command:|caused by|Caused by:|at\s)|Dockerfile:\d+)/;
const PROGRESS =
  /^(?:#\d+\s+\d+(?:\.\d+)?\s+)(?:\d+% transferring|\d+(?:\.\d+)?s$)|^#\d+\s+(?:transferring|extracting|downloading)\b/i;

export function compressDocker(input: BoundedText): string {
  const { text, lines } = input;
  const selected = new Set<number>();
  const cached = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.length === 0 || PROGRESS.test(line)) continue;
    if (CONTINUATION.test(line)) {
      if (selected.size === 0) return text;
      selected.add(index);
      continue;
    }
    if (!SEMANTIC.test(line)) return text;
    if (/\bCACHED\b/.test(line)) {
      const key = line.replace(/\s+\d+(?:\.\d+)?s$/, "");
      if (cached.has(key)) continue;
      cached.add(key);
    }
    if (!input.budget.chargeRecords(1)) return text;
    selected.add(index);
  }
  if (selected.size === 0) return text;
  let rendered = renderSelection(input, selected);
  if (rendered === undefined) return text;
  // Progress redraws leading or trailing the semantic range never reach a gap. Collapsing them is
  // permitted, dropping them unstated is not.
  const indexes = [...selected];
  const leading = Math.min(...indexes);
  const trailing = lines.length - 1 - Math.max(...indexes);
  if (leading > 0) rendered = `... ${leading} lines omitted ...\n${rendered}`;
  if (trailing > 0) rendered = `${rendered}\n... ${trailing} lines omitted ...`;
  return rendered.length <= MAX_OUTPUT ? rendered : text;
}
