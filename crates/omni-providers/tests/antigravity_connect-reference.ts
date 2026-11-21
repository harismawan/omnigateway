import { createHash } from "node:crypto";
import { antigravityOAuthFlow as flow } from "../../../packages/providers/src/antigravity/oauth.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const pending = {
  verifier: "verifier +🙂",
  challenge: "challenge",
  state: "state",
  redirectUri: "https://antigravity.google/oauth-callback",
};
const helpers = { fail: (code: string, message: string) => ({ code, message }), now: () => 1234 };
const start = (
  await flow
    .start({
      ...helpers,
      redirectUri: pending.redirectUri,
      randomState: () => pending.state,
      pkce: () => pending,
    })
    .next()
).value;
const rows: unknown[] = [{ kind: "start", expected: start }];
const reply = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) });
const token = reply(200, { access_token: "access", refresh_token: "refresh", expires_in: 60 });
const emails = [
  reply(200, { email: " user@example.test " }),
  reply(503, {}),
  reply(200, { email: "  " }),
  reply(200, { email: 1 }),
];
const projects = [
  [reply(200, { cloudaicompanionProject: " project ", currentTier: { id: "current" } })],
  [
    reply(200, {
      cloudaicompanionProject: { id: " nested " },
      allowedTiers: [
        { id: "first", isDefault: true },
        { id: "second", isDefault: true },
      ],
    }),
  ],
  [reply(200, {}), reply(200, { response: { cloudaicompanionProject: "new" } })],
  [reply(200, {}), reply(200, { done: false })],
  [reply(200, {}), reply(503, {})],
  [reply(503, {}), reply(200, { response: { cloudaicompanionProject: { id: "created" } } })],
  [
    reply(200, { allowedTiers: [{ id: "chosen", isDefault: true }] }),
    reply(200, { response: { cloudaicompanionProject: "new" } }),
  ],
];
const cases = emails.flatMap((email) =>
  projects.map((project) => ({
    code: " code #state#ignored",
    responses: [token, email, ...project],
  })),
);
for (const status of [200, 201, 299, 300, 400, 401, 403, 429, 500, 503])
  for (const body of ["{}", '{"error":"invalid_grant"}', '{"access_token":1}', "not json"])
    cases.push({ code: "code", responses: [{ status, body }] });
cases.push({ code: "code#wrong", responses: [] });
for (const test of cases) {
  const generator = flow.exchange({ ...helpers, pending, code: test.code });
  const requests = [];
  let i = 0;
  try {
    let step = await generator.next();
    while (!step.done) {
      const request = step.value;
      if (typeof request.body !== "string") throw Error("missing scripted request body");
      requests.push({ ...request, body: hash(request.body) });
      const response = test.responses[i++];
      if (!response) throw new Error("missing scripted response");
      step = await generator.next({ ...response, headers: new Headers() });
    }
    rows.push({ kind: "exchange", ...test, requests, result: step.value });
  } catch (error) {
    rows.push({ kind: "exchange", ...test, requests, error });
  }
}
console.log(JSON.stringify(rows));
