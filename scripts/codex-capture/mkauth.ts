#!/usr/bin/env bun
/**
 * Writes a synthetic ChatGPT login and a config pointing Codex at the capture
 * server, into a throwaway `CODEX_HOME`.
 *
 * No real credential is involved: the tokens are unsigned JWTs with a
 * far-future expiry, so Codex never tries to refresh them, and the account id
 * is a fixed placeholder that `capture.ts` echoes back from `/accounts/check`.
 *
 *   bun scripts/codex-capture/mkauth.ts <codex-home> <port>
 */
import { mkdirSync, writeFileSync } from "node:fs";

const home = process.argv[2];
const port = process.argv[3] ?? "18765";
if (home === undefined) {
  console.error("usage: mkauth.ts <codex-home> <port>");
  process.exit(2);
}
mkdirSync(home, { recursive: true });

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 30 * 86_400;
const claims = {
  chatgpt_plan_type: "pro",
  chatgpt_account_id: "00000000-0000-4000-8000-000000000001",
  chatgpt_user_id: "user-capture",
  user_id: "user-capture",
};
const jwt = (payload: object): string => `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;

writeFileSync(
  `${home}/auth.json`,
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        email: "capture@example.invalid",
        exp,
        "https://api.openai.com/auth": claims,
      }),
      access_token: jwt({ exp, "https://api.openai.com/auth": claims }),
      refresh_token: "rt-capture",
      account_id: claims.chatgpt_account_id,
    },
    last_refresh: new Date().toISOString(),
  }),
);
writeFileSync(
  `${home}/config.toml`,
  [
    `openai_base_url = "https://localhost:${port}/backend-api/codex"`,
    `chatgpt_base_url = "https://localhost:${port}/backend-api/"`,
    "check_for_update_on_startup = false",
    "[analytics]",
    "enabled = false",
    "",
  ].join("\n"),
);
