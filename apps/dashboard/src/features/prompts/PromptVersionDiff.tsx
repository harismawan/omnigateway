import styled from "styled-components";
import type { PromptView } from "../../api/types.ts";

const Diff = styled.pre`
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  ins, del { display: block; text-decoration: none; }
  ins { background: ${({ theme }) => theme.color.accentWash}; }
  del { color: ${({ theme }) => theme.color.down}; }
`;

/** Bounded line diff: retain common prefix/suffix, mark changed middle lines. */
export function PromptVersionDiff({
  version,
  versions,
}: {
  version: PromptView["versions"][number];
  versions: PromptView["versions"];
}) {
  if (typeof version.version !== "number") return <p>Pinned built-in version</p>;
  const previous = versions.find((v) => v.version === Number(version.version) - 1);
  if (!previous && version.version > 1) return <p>Previous version unavailable (pruned)</p>;
  const before = previous?.text.split("\n") ?? [];
  const after = version.text.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return (
    <Diff aria-label={`Changes in version ${version.version}`}>
      <span>
        {after
          .slice(0, start)
          .map((line) => `  ${line}\n`)
          .join("")}
      </span>
      <del>
        {before
          .slice(start, before.length - end)
          .map((line) => `− ${line}\n`)
          .join("")}
      </del>
      <ins>
        {after
          .slice(start, after.length - end)
          .map((line) => `+ ${line}\n`)
          .join("")}
      </ins>
      {end > 0 ? (
        <span>
          {after
            .slice(after.length - end)
            .map((line) => `  ${line}\n`)
            .join("")}
        </span>
      ) : null}
    </Diff>
  );
}
