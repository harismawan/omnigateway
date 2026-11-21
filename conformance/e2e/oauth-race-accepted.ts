import { isDeepStrictEqual } from "node:util";

export type Leg = "poll" | "finish";
export type Reply = { status: number; body: unknown; type: string | null; cookie: string | null };
export type RaceObservation = {
  start: unknown;
  poll: Reply;
  finish: Reply;
  followUp: Reply;
  exchanges: { leg: Leg; request: unknown }[];
  credentials: { leg: Leg; row: unknown }[];
};

// Nov 21 user ruling: frozen double redemption was an inherited bug. D4
// (`7c2d7adc`, crates/omni-gateway/src/connect.rs) takes the flow under the
// coordinator lock before exchange in both modes. Accept only the missing
// duplicate exchange and credential in these two single-mode mixed races.
const accepted = {
  id: "rust-oauth-redeem-once",
  rows: ["anthropic/mixed-poll-finish", "openai/mixed-poll-finish"],
  success: {
    poll: {
      status: 200,
      type: "application/json;charset=utf-8",
      cookie: null,
      body: { status: "complete", id: "<credential-id>" },
    },
    finish: {
      status: 200,
      type: "application/json;charset=utf-8",
      cookie: null,
      body: { id: "<credential-id>" },
    },
  },
  consumed: {
    status: 400,
    type: "application/json;charset=utf-8",
    cookie: null,
    body: { error: { code: "BAD_REQUEST", message: "unknown or expired authorization" } },
  },
} as const;

/** Inputs have already validated random values, PKCE, and persistence. */
export function oauthRaceVerdict(name: string, frozen: RaceObservation, rust: RaceObservation) {
  if (!accepted.rows.some((row) => row === name)) return null;
  if (
    !isDeepStrictEqual(frozen.poll, accepted.success.poll) ||
    !isDeepStrictEqual(frozen.finish, accepted.success.finish) ||
    !isDeepStrictEqual(frozen.followUp, accepted.consumed) ||
    !isDeepStrictEqual(
      frozen.exchanges.map((e) => e.leg),
      ["poll", "finish"],
    ) ||
    !isDeepStrictEqual(
      frozen.credentials.map((e) => e.leg),
      ["poll", "finish"],
    ) ||
    !isDeepStrictEqual(frozen.credentials[0]?.row, frozen.credentials[1]?.row)
  )
    return null;

  for (const winner of ["poll", "finish"] as const) {
    const loser = winner === "poll" ? "finish" : "poll";
    if (
      isDeepStrictEqual(rust, {
        ...frozen,
        [loser]: accepted.consumed,
        exchanges: frozen.exchanges.filter((e) => e.leg === winner),
        credentials: frozen.credentials.filter((e) => e.leg === winner),
      })
    )
      return accepted.id;
  }
  return null;
}
