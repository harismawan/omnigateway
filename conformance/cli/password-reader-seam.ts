import { consoleWriter } from "../../apps/cli/src/output.ts";
import { createPrompt } from "../../apps/cli/src/prompt.ts";
import { run } from "../../apps/cli/src/run.ts";

// Exercise the frozen actual hidden reader once, then reuse the answer solely
// to avoid its destroyed-stream second-read defect.
const prompt = createPrompt({ assumeYes: false } as never, consoleWriter);
let first: string | undefined;
process.exitCode = await run(process.argv.slice(2), consoleWriter, {
  prompt: {
    ...prompt,
    secret: async (question) => {
      if (first === undefined) {
        first = await prompt.secret(question);
        return first;
      }
      consoleWriter.err(question);
      consoleWriter.err("");
      return process.env.READER_CONFIRM === undefined
        ? first
        : JSON.parse(process.env.READER_CONFIRM);
    },
  },
});
