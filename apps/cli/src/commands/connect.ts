import { type ConnectFlows, OAUTH_PROVIDER_IDS } from "@omni/control";
import { requirePositional, stringFlag, UsageError } from "../args.ts";
import type { Command } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, note } from "../output.ts";

/** How long a device-code flow is polled before giving up on the operator. */
const DEVICE_TIMEOUT_MS = 600_000;

export const connect: Command = {
  usage: "connect <provider> [--label L]",
  summary: "Authorize a provider account from the terminal",
  options: { label: { type: "string" } },
  async run(args, { ctx, writer, prompt, connect: connectFlows }) {
    const providerId = requirePositional(args, 0, "provider");
    // The connectable set, not every provider that exists: `custom` is a
    // provider and has no authorization to start, so accepting it here would
    // only defer the refusal to `start` with a worse message.
    if (!(OAUTH_PROVIDER_IDS as readonly string[]).includes(providerId)) {
      throw new UsageError(`provider must be one of ${OAUTH_PROVIDER_IDS.join(", ")}`);
    }

    const flows = connectFlows(await ctx.store());

    const start = await flows.start(providerId, stringFlag(args.values, "label"));

    // Printed rather than opened: this command is run over SSH as often as not,
    // and a browser launched on the wrong machine helps nobody.
    //
    // Written straight to stderr rather than through `note`, because this is
    // the instruction the operator must act on, not progress chatter — a
    // `--json` run that swallowed it would leave them waiting on a URL they
    // were never shown. stdout stays clean either way.
    writer.err("");
    writer.err(`Open this URL to authorize ${providerId}:`);
    writer.err(`  ${start.authorizeUrl}`);
    if (start.userCode !== null) {
      writer.err("");
      writer.err(`Then enter the code: ${start.userCode}`);
    }
    writer.err("");

    const created =
      start.kind === "device"
        ? await pollUntilAuthorized(flows, start, {
            sleep: (ms: number) => Bun.sleep(ms),
            now: ctx.now,
            onWait: () => note(ctx, writer, "waiting for approval…"),
          })
        : await flows.finish(start.flowId, await prompt.secret("Paste the code or callback URL: "));

    emit(
      ctx,
      writer,
      { id: created.id, provider: providerId },
      () => `connected ${providerId} as ${created.id}`,
    );
  },
};

/**
 * Polls a device-code flow until the operator approves it.
 *
 * The interval is the provider's own: polling faster is what makes a provider
 * start answering `slow_down`, and the gateway has no reason to argue with it.
 */
async function pollUntilAuthorized(
  flows: ConnectFlows,
  start: { flowId: string; pollIntervalMs: number },
  deps: { sleep: (ms: number) => Promise<unknown>; now: () => number; onWait: () => void },
): Promise<{ id: string }> {
  const deadline = deps.now() + DEVICE_TIMEOUT_MS;
  let announced = false;

  for (;;) {
    const outcome = await flows.poll(start.flowId);
    if (outcome.status === "complete") return { id: outcome.id };

    if (!announced) {
      deps.onWait();
      announced = true;
    }
    if (deps.now() >= deadline) throw new CliError("authorization timed out");
    await deps.sleep(start.pollIntervalMs);
  }
}
