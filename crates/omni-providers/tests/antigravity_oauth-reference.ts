import { createHash } from "node:crypto";
import { antigravityOAuthFlow } from "../../../packages/providers/src/antigravity/oauth.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const rows = [];
for (const refreshToken of ["", "refresh", "a +&=🙂"]) {
  const flow = antigravityOAuthFlow.refresh({
    refreshToken,
    providerData: {},
    fail: (code, message) => ({ code, message }),
    now: () => 1234,
  });
  const step = await flow.next();
  if (step.done || typeof step.value.body !== "string") throw Error("missing refresh request");
  const req = step.value;
  const fields = new URLSearchParams(req.body);
  rows.push({
    kind: "request",
    refreshToken,
    expected: { ...req, body: hash(req.body) },
    clientId: hash(requiredField(fields, "client_id")),
    clientSecret: hash(requiredField(fields, "client_secret")),
  });
}
function requiredField(fields: URLSearchParams, name: string): string {
  const value = fields.get(name);
  if (value === null) throw Error(`missing ${name}`);
  return value;
}
const bodies = [
  "",
  "not json",
  "null",
  "[]",
  "{}",
  '{"access_token":1}',
  '{"access_token":""}',
  '{"access_token":"token"}',
  '{"access_token":"a\\ud800","refresh_token":"r\\udfff"}',
  ...[null, 1, -1, 0, 0.5, "10", true, {}, [], 1e308].map((expires_in) =>
    JSON.stringify({ access_token: "a", refresh_token: 17, expires_in }),
  ),
  ...["", null, "rotated", [], {}].map((refresh_token) =>
    JSON.stringify({ access_token: "a", refresh_token, expires_in: 60 }),
  ),
  '{"error":"invalid_grant"}',
  '{"error":{"code":400,"message":"private"}}',
  '{"error":"bad value"}',
];
for (const status of [200, 201, 299, 300, 400, 401, 403, 429, 500, 503])
  for (const body of bodies) {
    const providerData = { projectId: "keep", tier: "legacy", nested: { a: [1, null] } };
    const flow = antigravityOAuthFlow.refresh({
      refreshToken: "fallback",
      providerData,
      fail: (code, message) => ({ code, message }),
      now: () => 1234,
    });
    await flow.next();
    try {
      rows.push({
        kind: "result",
        status,
        body,
        providerData,
        expected: JSON.stringify((await flow.next({ status, body, headers: new Headers() })).value),
      });
    } catch (error) {
      rows.push({ kind: "result", status, body, providerData, error });
    }
  }
console.log(JSON.stringify(rows));
