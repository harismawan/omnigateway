import { type ClientProfile, env, envOrder } from "../headers.ts";

const KILO_CLI_VERSION = env("OMNI_KILO_CLI_VERSION", "4.140.0");

// No traffic capture exists for the Kilo Code extension either. This profile is
// constructed to be plausible, not verified — the same weaker guarantee the
// kimi profile above carries.
//
// `X-KILOCODE-EDITORNAME` is the one header the gateway is documented to
// require, and it names the editor hosting the extension rather than the
// machine it runs on: there is no device fingerprint to mint here. It reads
// from the environment so a value Kilo starts rejecting is an operator fix
// rather than a release.
export const kiloProfile: ClientProfile = {
  headers: [
    ["User-Agent", env("OMNI_UA_KILO", `Kilo-Code/${KILO_CLI_VERSION}`)],
    ["X-KILOCODE-EDITORNAME", env("OMNI_KILO_EDITOR_NAME", "vscode")],
    ["Accept", "text/event-stream"],
  ],
  // `X-Kilocode-OrganizationID` sits with `Authorization` because it qualifies
  // it. A header the adapter does not send is simply skipped, so listing it
  // costs nothing on a credential with no organization.
  // The operator override is applied here rather than where the table is
  // assembled. An adapter reads this value directly, so a table that applied
  // something the direct read did not would differ only on installations that
  // set the variable — which is the shape of bug this repository keeps finding.
  order: envOrder("OMNI_ORDER_KILO", [
    "Host",
    "Content-Type",
    "Authorization",
    "X-Kilocode-OrganizationID",
    "X-KILOCODE-EDITORNAME",
    "User-Agent",
    "Accept",
    "Accept-Encoding",
    "Content-Length",
  ]),
};

// Constructed, not captured, like the kimi profile. `reasoning` is
// OpenRouter's field, which Kilo's surface takes; `stream_options` is absent
// for the same reason it is absent above.
export const kiloBodyOrder: readonly string[] = [
  "model",
  "messages",
  "tools",
  "tool_choice",
  "max_tokens",
  "temperature",
  "reasoning",
  "stream",
];
