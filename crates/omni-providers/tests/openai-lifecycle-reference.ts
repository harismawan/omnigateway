import { openaiOAuthFlow as flow } from "../../../packages/providers/src/openai/oauth.ts";

const helpers = {
  fail: (code: string, message: string) => Object.assign(new Error(message), { code }),
  now: () => 1000,
};
const pending = {
  verifier: "v",
  challenge: "c",
  state: "s",
  redirectUri: "http://localhost/callback",
};
const valid = {
  installationId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  idSalt: "ab".repeat(32),
  accountId: "prior",
  extra: true,
};
const jwt = (v: unknown) => `h.${Buffer.from(JSON.stringify(v)).toString("base64url")}.s`;
const rows = [];
for (const prior of [
  valid,
  {},
  { installationId: valid.installationId, idSalt: "BAD" },
  { installationId: false, idSalt: valid.idSalt },
  { accountId: "  " },
]) {
  for (const mode of ["exchange", "refresh"]) {
    for (const [status, body] of [
      [
        200,
        {
          access_token: "new",
          refresh_token: "rotation",
          expires_in: 12,
          id_token: jwt({
            email: "mail",
            "https://api.openai.com/auth": { chatgpt_account_id: "new-account" },
          }),
        },
      ],
      [200, { access_token: "", refresh_token: 42, id_token: "bad" }],
      [200, { access_token: "a" }],
      [200, {}],
      [400, { error: "invalid_grant" }],
      [429, { error: "busy" }],
      [503, { error: "bad secret!" }],
    ] as const) {
      const step =
        mode === "exchange"
          ? flow.exchange({ ...helpers, code: " code #s", pending, providerData: prior })
          : flow.refresh({ ...helpers, refreshToken: "old", providerData: prior });
      const request = (await step.next()).value;
      try {
        const result = (await step.next({ status, body: JSON.stringify(body) })).value;
        rows.push({ prior, mode, status, body: JSON.stringify(body), request, result });
      } catch (e) {
        rows.push({
          prior,
          mode,
          status,
          body: JSON.stringify(body),
          request,
          error: { code: e.code, message: e.message },
        });
      }
    }
  }
}
for (const id_token of [
  "h.eyJlbWFpbCI6Im1haWwifQ.s",
  "h.eyJlbWFpbCI6Im1haWwifQ==.s",
  "h.e yJlbWFpbCI6Im1haWwifQ!A.s",
  "h.eyJlbWFpbCI6Im1haWwifR.s",
  "h.e30.s",
  "h.bnVsbA.s",
  "h.W10.s",
  "h.!.s",
  "h..s",
  "a.b.c.d",
]) {
  const body = JSON.stringify({ access_token: "a", id_token });
  const step = flow.refresh({ ...helpers, refreshToken: "old", providerData: valid });
  const request = (await step.next()).value;
  const result = (await step.next({ status: 200, body })).value;
  rows.push({ prior: valid, mode: "refresh", status: 200, body, request, result });
}
for (const depth of [126, 129, 1000, 10000, 40000, 100000]) {
  const deep = "[".repeat(depth) + "0" + "]".repeat(depth);
  for (const mode of ["exchange", "reconnect", "refresh"]) {
    for (const payload of [
      `{"email":"mail","https://api.openai.com/auth":{"chatgpt_account_id":"acct"},"extra":${deep}}`,
      deep,
      `{"email":"mail","https://api.openai.com/auth":${deep}}`,
      `{"email":42,"https://api.openai.com/auth":{"chatgpt_account_id":"  "},"extra":${deep}}`,
    ]) {
      const prior = mode === "exchange" ? {} : valid;
      const body = JSON.stringify({
        access_token: "a",
        id_token: `h.${Buffer.from(payload).toString("base64url")}.s`,
      });
      const step =
        mode === "refresh"
          ? flow.refresh({ ...helpers, refreshToken: "old", providerData: prior })
          : flow.exchange({ ...helpers, code: " code #s", pending, providerData: prior });
      const request = (await step.next()).value;
      const result = (await step.next({ status: 200, body })).value;
      rows.push({ prior, mode, status: 200, body, request, result });
    }
  }
}
console.log(JSON.stringify(rows));
