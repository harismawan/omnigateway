import { withQuery } from "../../api/client.ts";
import { Chip } from "../../ui/Chip.tsx";
import { Row } from "../../ui/primitives.ts";

/** Persisted IDs only. A malformed historical value stays inert, never a route target. */
export function AppliedPromptChips({
  prompts,
  operator,
}: {
  prompts: string[];
  operator: boolean;
}) {
  return (
    <Row $gap={1} $wrap>
      {[...new Set(prompts)].map((prompt) => {
        const match = /^([a-z0-9-]{1,40})@([1-9][0-9]*|v4\.9\.0)$/.exec(prompt);
        const id = match?.[1];
        const version = match?.[2];
        return (
          <Chip key={prompt}>
            {operator && id && version ? (
              <a href={withQuery("/prompts", { id, version })}>{prompt}</a>
            ) : (
              prompt
            )}
          </Chip>
        );
      })}
    </Row>
  );
}
