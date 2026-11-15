import { consoleWriter } from "../../apps/cli/src/output.ts";
import { run } from "../../apps/cli/src/run.ts";

const answers: string[] = JSON.parse(process.env.PTY_ANSWERS ?? "[]");
process.exitCode = await run(process.argv.slice(2), consoleWriter, {
  prompt: {
    isTty: true,
    secret: async (question) => {
      consoleWriter.err(question);
      consoleWriter.err("");
      return (answers.shift() ?? "").trim();
    },
    confirm: async () => false,
  },
});
