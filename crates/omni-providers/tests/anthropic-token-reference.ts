import { anthropicOAuthFlow } from "../../../packages/providers/src/anthropic/oauth.ts";

const payloads = [
  '{"access_token":"a\\ud800","refresh_token":123,"account":{"email_address":false}}',
  '{"access_token":"a","refresh_token":"\\udfff","account":{"email_address":"x\\ud800"}}',
  '{"access_token":"a","extra":"\\ud800","refresh_token":null}',
];
const out = [];
for (const body of payloads) {
  const step = anthropicOAuthFlow.refresh({
    refreshToken: "old",
    providerData: {},
    now: () => 1000,
    fail: (c, m) => {
      throw Error(c + ":" + m);
    },
  });
  await step.next();
  const result = await step.next({ status: 200, headers: new Headers(), body });
  if (!result.done) throw Error("refresh did not complete after its token response");
  const { secrets, accountEmail } = result.value;
  out.push({
    body,
    access: [...secrets.accessToken].flatMap((c) =>
      Array.from({ length: c.length }, (_, i) => c.charCodeAt(i)),
    ),
    refresh: JSON.stringify(secrets.refreshToken),
    email: JSON.stringify(accountEmail),
  });
}
console.log(JSON.stringify(out));
