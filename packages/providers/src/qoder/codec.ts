import type { ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../headers.ts";
import type { HeaderPair } from "../types.ts";
import { parseCredential } from "./credential.ts";
import { signAuth } from "./crypto.ts";
import { decodeQoder } from "./decode.ts";
import { QODER_VERSION, qoderProfile } from "./profile.ts";
import { encodeBody } from "./protocol.ts";
import { toQoderWire } from "./wire.ts";

const PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const qoderCodec: ProviderCodec = {
  buildRequest(input) {
    let bundle: ReturnType<typeof parseCredential>;
    try {
      bundle = parseCredential(input.credentials.accessToken ?? "");
    } catch {
      throw input.fail("AUTH", "Invalid Qoder credential; reconnect required");
    }
    const wire = toQoderWire(input, bundle);
    const body = encodeBody(JSON.stringify(wire.body));
    const date = String(Math.floor((input.requestStartedAt ?? bundle.issuedAt) / 1000));
    const authBase64 = Buffer.from(
      JSON.stringify({
        version: "v1",
        requestId: wire.body.request_id,
        info: bundle.encryptUserInfo,
        cosyVersion: QODER_VERSION,
        ideVersion: "",
      }),
    ).toString("base64");
    const headers: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["Accept", "text/event-stream"],
      [
        "Authorization",
        `Bearer COSY.${authBase64}.${signAuth({ authBase64, key: bundle.key, date, body, path: PATH })}`,
      ],
      ["Cosy-Key", bundle.key],
      ["Cosy-Date", date],
      ["Cosy-User", bundle.uid],
      ["Cosy-Version", QODER_VERSION],
      ["Cosy-MachineId", bundle.machineId],
      ["Cosy-MachineToken", bundle.machineId],
      ["Cosy-ClientIp", bundle.machineId],
      ["Cosy-ClientType", "5"],
      ["Cosy-MachineType", "5"],
      ["Cosy-Business-Product", "cli"],
      ["Cosy-Business-Type", "agent"],
      ["Cosy-Scene", "assistant"],
      ["Cosy-Data-Policy", "disagree"],
      ["Login-Version", "v2"],
    ];
    return {
      request: {
        url: `${bundle.origin}/algo${PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
        method: "POST",
        headers: orderHeaders(mergeHeaders(qoderProfile.headers, headers), qoderProfile.order),
        body,
      },
      degradations: wire.degradations,
    };
  },
  decode(input) {
    return decodeQoder(input);
  },
};
