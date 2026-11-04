import { type ClientProfile, env, envOrder } from "../headers.ts";

export const QODER_VERSION = env("OMNI_QODER_CLI_VERSION", "1.1.82");
export const qoderBodyOrder: readonly string[] = [
  "request_id",
  "chat_record_id",
  "request_set_id",
  "session_id",
  "stream",
  "chat_task",
  "is_reply",
  "is_retry",
  "source",
  "version",
  "agent_id",
  "aliyun_user_type",
  "chat_context",
  "session_type",
  "task_id",
  "system",
  "messages",
  "tools",
  "parameters",
  "model_config",
];
/** Constructed from shipped CLI code, not captured live traffic. */
export const qoderProfile: ClientProfile = {
  headers: [
    ["User-Agent", `qoder/${QODER_VERSION}`],
    ["Accept", "application/json"],
  ],
  order: envOrder("OMNI_ORDER_QODER", [
    "Host",
    "Content-Type",
    "Authorization",
    "Accept",
    "User-Agent",
    "Content-Length",
  ]),
};
