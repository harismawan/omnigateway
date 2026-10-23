import type { StreamEvent } from "@omni/ir";
import type { DispatchOutcome } from "../dispatch/index.ts";

/**
 * A rerouted dispatch, said the way the client and the row need it.
 *
 * - **The response names the configured local model.** Every `start` event's
 *   `model` becomes `localModel`, rather than whatever the upstream called
 *   itself (`llama3:8b`, or `""`). The three stream encoders read it from that
 *   event and the non-streaming bodies from `collect()`, which reads the same
 *   event — one rewrite, every surface, both response kinds.
 * - **The row keeps the client's model.** Dispatch builds its log with
 *   `requestedModel` = the model it was handed, which here is the local one.
 *   The completion upsert overwrites `requested_model` with it and `finishLog`
 *   debits against it, so without this the row would name a model the client
 *   never asked for and the debit would miss the subject admission charged.
 */
export function relabel(
  outcome: DispatchOutcome,
  opts: { clientModel: string; localModel: string },
): DispatchOutcome {
  async function* events(): AsyncGenerator<StreamEvent, void, undefined> {
    for await (const event of outcome.events) {
      yield event.type === "start" ? { ...event, model: opts.localModel } : event;
    }
  }
  return {
    events: events(),
    log: () => {
      const log = outcome.log();
      log.requestedModel = opts.clientModel;
      return log;
    },
  };
}
