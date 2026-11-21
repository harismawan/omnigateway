import { expect, test } from "bun:test";
import { oauthRaceVerdict, type RaceObservation } from "./oauth-race-accepted.ts";

const reply = (status: number, body: unknown) => ({
  status,
  body,
  type: "application/json;charset=utf-8",
  cookie: null,
});
const pollOk = reply(200, { status: "complete", id: "<credential-id>" });
const finishOk = reply(200, { id: "<credential-id>" });
const gone = reply(400, {
  error: { code: "BAD_REQUEST", message: "unknown or expired authorization" },
});
const frozen: RaceObservation = {
  start: { flowId: "<flow>" },
  poll: pollOk,
  finish: finishOk,
  followUp: gone,
  exchanges: [
    { leg: "poll", request: { path: "/token" } },
    { leg: "finish", request: { path: "/token" } },
  ],
  credentials: [
    { leg: "poll", row: { access_token: "fixture" } },
    { leg: "finish", row: { access_token: "fixture" } },
  ],
};
const rust: RaceObservation = {
  ...frozen,
  finish: gone,
  exchanges: frozen.exchanges.slice(0, 1),
  credentials: frozen.credentials.slice(0, 1),
};

test("only the two named mixed races may lose exactly one redemption, regardless of winner", () => {
  for (const row of ["anthropic/mixed-poll-finish", "openai/mixed-poll-finish"]) {
    expect(oauthRaceVerdict(row, frozen, rust)).toBe("rust-oauth-redeem-once");
    expect(
      oauthRaceVerdict(row, frozen, {
        ...rust,
        poll: gone,
        finish: finishOk,
        exchanges: frozen.exchanges.slice(1),
        credentials: frozen.credentials.slice(1),
      }),
    ).toBe("rust-oauth-redeem-once");
  }
  for (const row of ["kimi/mixed-poll-finish", "openai/poll-poll", "constructor"])
    expect(oauthRaceVerdict(row, frozen, rust)).toBeNull();
});

test("does not hide changed bodies, extra exchanges, or different credential contents", () => {
  const row = "anthropic/mixed-poll-finish";
  const mutations: Partial<RaceObservation>[] = [
    { poll: reply(200, { status: "complete", id: "<credential-id>", extra: true }) },
    { poll: finishOk },
    { finish: reply(409, gone.body) },
    { finish: reply(400, { error: { code: "BAD_REQUEST", message: "expired" } }) },
    { finish: { ...gone, cookie: "unexpected" } },
    { followUp: pollOk },
    { start: { flowId: "changed" } },
    { exchanges: frozen.exchanges },
    { exchanges: [{ leg: "poll", request: { path: "/changed" } }] },
    { credentials: [] },
    { credentials: frozen.credentials },
    { credentials: [{ leg: "finish", row: { access_token: "fixture" } }] },
    { credentials: [{ leg: "poll", row: { access_token: "changed" } }] },
  ];
  for (const mutation of mutations)
    expect(oauthRaceVerdict(row, frozen, { ...rust, ...mutation })).toBeNull();
  expect(oauthRaceVerdict(row, { ...frozen, finish: gone }, rust)).toBeNull();
  expect(
    oauthRaceVerdict(
      row,
      {
        ...frozen,
        credentials: [
          { leg: "poll", row: { access_token: "fixture" } },
          { leg: "finish", row: { access_token: "changed" } },
        ],
      },
      rust,
    ),
  ).toBeNull();
  expect(oauthRaceVerdict(row, frozen, frozen)).toBeNull();
});
