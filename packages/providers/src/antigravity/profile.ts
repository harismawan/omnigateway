import { type ClientProfile, env, envOrder } from "../headers.ts";

/**
 * Linux x86_64 App 2.34.0 Hub agent turn, captured here on 2026-11-21 from the
 * official Google release. See `scripts/antigravity-capture/README.md` and the
 * sanitized fixture `antigravity-2.34.0.json`. This is not a CLI or Mac capture.
 * omniroute reported that Google refused a non-Mac identity. This offline
 * capture neither confirms nor disproves that secondhand report; live
 * acceptance of the Linux Hub default is untested. Set OMNI_UA_ANTIGRAVITY to
 * `antigravity/ide/2.12.2 darwin/arm64` to restore the old UA only, not the old
 * header order, framing, or envelope.
 * Keep helpers imported from `headers.ts` to avoid a profile initialization cycle.
 */
const HUB_VERSION = env("OMNI_ANTIGRAVITY_IDE_VERSION", "2.34.0");
export const antigravityHost = "daily-cloudcode-pa.googleapis.com";

export const antigravityInferenceProfile: ClientProfile = {
  headers: [
    ["Host", antigravityHost],
    [
      "User-Agent",
      env(
        "OMNI_UA_ANTIGRAVITY",
        `antigravity/hub/${HUB_VERSION} (aidev_client; os_type=linux; arch=amd64; cl=1026637980)`,
      ),
    ],
    ["Transfer-Encoding", "chunked"],
    ["Content-Type", "application/json"],
  ],
  order: envOrder("OMNI_ORDER_ANTIGRAVITY", [
    "Host",
    "User-Agent",
    "Transfer-Encoding",
    "Authorization",
    "Content-Type",
  ]),
};

/**
 * Bootstrap (`loadCodeAssist`, `onboardUser`) as the **App 2.34** recording
 * sent it on 2026-11-21: on `daily-cloudcode-pa`, the Hub UA, and
 * `Host, User-Agent, Content-Length, Authorization, Content-Type,
 * Accept-Encoding`. No `Accept` or `X-Goog-Api-Client`; `Accept-Encoding: gzip`
 * is not adopted (the readers do not decompress it), and the shared transport
 * adds `Connection: keep-alive`, which the capture did not show. The quota RPC
 * (`retrieveUserQuotaSummary`) was seen only from the CLI 1.5.13; sending it
 * with this App profile is the gateway's choice. The request builder
 * (`antigravityBootstrapRequest`) lists every header in this order itself and
 * supplies `Host`/`Content-Length`, as Rust's `bootstrap_headers` does.
 * Offline capture only: live acceptance is not yet measured.
 */
export const antigravityBootstrapUserAgent = env(
  "OMNI_UA_ANTIGRAVITY",
  `antigravity/hub/${HUB_VERSION} (aidev_client; os_type=linux; arch=amd64; cl=1026637980)`,
);
export const antigravityBootstrapOrder: readonly string[] = envOrder("OMNI_ORDER_ANTIGRAVITY", [
  "Host",
  "User-Agent",
  "Content-Length",
  "Authorization",
  "Content-Type",
  "Accept-Encoding",
]);

/**
 * Token exchange and userinfo: not in the 2026-11-21 capture (the recorder
 * answered them with a stub), so they keep the omniroute 3.8.49 identity.
 */
export const antigravityProfile: ClientProfile = {
  headers: [
    [
      "User-Agent",
      env(
        "OMNI_UA_ANTIGRAVITY",
        `antigravity/ide/${env("OMNI_ANTIGRAVITY_IDE_VERSION", "2.12.2")} darwin/arm64`,
      ),
    ],
    ["Content-Type", "application/json"],
    ["Accept", "text/event-stream"],
  ],
  order: envOrder("OMNI_ORDER_ANTIGRAVITY", [
    "Host",
    "Content-Type",
    "Authorization",
    "User-Agent",
    "X-Goog-Api-Client",
    "Accept",
    "Accept-Encoding",
    "Content-Length",
  ]),
};

/**
 * The Cloud Code envelope's key order.
 *
 * Google refuses an unknown top-level key outright — `Invalid JSON payload
 * received. Unknown name "…"` — so this list is closed in a way the other
 * providers' are not: it is the whole set of keys the envelope may carry, and
 * anything a caller adds beside them fails the request rather than being
 * ignored. `orderFields` does not enforce that; `wire.ts` does, by building the
 * envelope explicitly and merging vendor passthrough into `request` instead.
 */
export const antigravityBodyOrder: readonly string[] = [
  "project",
  "requestId",
  "request",
  "model",
  "userAgent",
  "requestType",
];
