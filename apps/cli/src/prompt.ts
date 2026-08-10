import { CliError, type Context } from "./context.ts";
import type { Writer } from "./output.ts";

export type Prompt = {
  /** Reads ordinary text from a terminal. */
  input?: (question: string) => Promise<string>;
  /** Reads a secret without echoing it, or from stdin when piped. */
  secret: (question: string) => Promise<string>;
  /** Asks a yes/no question. */
  confirm: (question: string) => Promise<boolean>;
  isTty: boolean;
};

async function readAllStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads one line with the terminal's echo turned off.
 *
 * Secrets never reach argv or the environment, so this and a pipe are the only
 * two ways one enters the CLI. Raw mode is restored on every path, including
 * the one where the operator interrupts.
 */
async function readHidden(): Promise<string> {
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();

  try {
    const decoder = new TextDecoder();
    let line = "";
    for await (const chunk of stdin) {
      const text = decoder.decode(chunk as Uint8Array, { stream: true });
      for (const char of text) {
        if (char === "\r" || char === "\n") return line;
        if (char === "\u0003") throw new CliError("cancelled", 1);
        if (char === "\u007f" || char === "\b") {
          line = line.slice(0, -1);
          continue;
        }
        line += char;
      }
    }
    return line;
  } finally {
    stdin.setRawMode?.(false);
    stdin.pause();
  }
}

async function readLine(): Promise<string> {
  const decoder = new TextDecoder();
  let line = "";
  for await (const chunk of process.stdin) {
    const text = decoder.decode(chunk as Uint8Array, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) return line + text.slice(0, newline);
    line += text;
  }
  return line;
}

export function createPrompt(ctx: Context, writer: Writer): Prompt {
  const isTty = process.stdin.isTTY === true;

  return {
    isTty,

    async input(question) {
      if (!isTty) throw new CliError(`${question} — refusing without a terminal`);
      writer.err(question);
      return (await readLine()).trim();
    },

    async secret(question) {
      if (!isTty) return (await readAllStdin()).trim();
      writer.err(question);
      const value = await readHidden();
      writer.err("");
      return value.trim();
    },

    async confirm(question) {
      // Without a terminal there is nobody to ask, so the decision must have
      // been made on the command line.
      if (ctx.assumeYes) return true;
      if (!isTty) throw new CliError(`${question} — refusing without --yes`);

      writer.err(`${question} [y/N] `);
      const answer = (await readLine()).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
  };
}
