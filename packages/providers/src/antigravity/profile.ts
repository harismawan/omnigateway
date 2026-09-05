import { type ClientProfile, env, envOrder } from "../headers.ts";

/**
 * Antigravity's client identity.
 *
 * **Constructed from omniroute 3.8.49's captured header set, not captured here**
 * — the same standing this file's kimi and grok siblings declare. What omniroute
 * records is that its own values came off both official clients, and the two
 * facts worth repeating are the ones that look like mistakes:
 *
 * The platform token is pinned to `darwin/arm64` regardless of what this gateway
 * runs on. Antigravity's backend expects the Mac desktop build, and omniroute
 * pins it for that reason after seeing the alternative refused. A Linux gateway
 * reporting `linux/x64` here is the honest answer to a question nobody asked and
 * the wrong one for the only party reading it.
 *
 * The version is the weakest constant, as it is for grok: it gates nothing this
 * repository has observed — a live matrix on 2026-09-05 got identical answers
 * from `2.0.0`, `2.1.1` and a CLI identity — but it is the field an upstream
 * would gate on first, so it sits behind `env()` and a stale value is an
 * operator fix rather than a release.
 *
 * **Do not read it back from the auto-updater feed.** omniroute resolves it from
 * `antigravity-auto-updater-…/releases`, which on that date reported `2.0.0` as
 * its newest entry while the actually-shipping build was `2.12.2` — so the feed
 * is either a different channel or behind. The number here is the one an
 * operator reported from an installed client, which is the only source that has
 * been right so far.
 *
 * Helpers come from `headers.ts` and not from `profile.ts`. Importing them from
 * there closes a module-initialisation cycle whose only symptom is a gateway
 * that will not boot, and only on installations that set an `OMNI_ORDER_*`
 * variable.
 */
const ANTIGRAVITY_IDE_VERSION = env("OMNI_ANTIGRAVITY_IDE_VERSION", "2.12.2");

/** The backend expects the Mac build; see the note above. */
const PLATFORM = "darwin/arm64";

export const antigravityProfile: ClientProfile = {
  headers: [
    [
      "User-Agent",
      env("OMNI_UA_ANTIGRAVITY", `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} ${PLATFORM}`),
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
  "model",
  "userAgent",
  "requestType",
  "request",
];
