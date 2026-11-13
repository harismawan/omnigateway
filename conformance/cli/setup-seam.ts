// Only replace the broken multi-read stdin adapter; generators, context, file
// writes and error handling all remain the frozen implementation.

import { consoleWriter } from "../../apps/cli/src/output.ts";
import { run } from "../../apps/cli/src/run.ts";

const answers: string[] = JSON.parse(process.env.PTY_ANSWERS ?? "[]");
process.exitCode = await run(process.argv.slice(2), consoleWriter, {
  prompt: {
    isTty: true,
    input: async (question) => {
      consoleWriter.err(question);
      return answers.shift() ?? "";
    },
    secret: async () => {
      throw new Error("unexpected secret prompt");
    },
    confirm: async () => {
      throw new Error("unexpected confirmation");
    },
  },
});
