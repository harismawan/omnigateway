import { expect, test } from "bun:test";
import { maskBody, maskHeader } from "./masks.ts";

const id = "req_0164c263-e96d-46ab-8b45-01206f479f32";
const now = () => Math.floor(Date.now() / 1000);

test("ids and instants are masked only where the protocol puts them", () => {
  const body = JSON.stringify({
    id,
    created: now(),
    choices: [{ message: { content: `see ${id}`, created: 5 } }],
  });
  expect(maskBody(body, "application/json")).toBe(
    JSON.stringify({
      id: "req_<id>",
      created: "<t>",
      choices: [{ message: { content: `see ${id}`, created: 5 } }],
    }),
  );
});

test("values of the wrong shape are left for the comparison to see", () => {
  const body = JSON.stringify({ id: "req_not-a-uuid", created: now() - 100_000 });
  expect(maskBody(body, "application/json")).toBe(body);
  expect(maskHeader("retry-after", "9999")).toBe("9999");
  expect(maskHeader("x-ratelimit-reset-requests", "soon")).toBe("soon");
  expect(maskHeader("anthropic-ratelimit-requests-reset", "1999-01-01T00:00:00Z")).toBe(
    "1999-01-01T00:00:00Z",
  );
  expect(maskHeader("date", "Mon, 01 Jan 2001 00:00:00 GMT")).toBe("Mon, 01 Jan 2001 00:00:00 GMT");
});

test("SSE data lines are masked frame by frame; other lines are untouched", () => {
  const sse = `event: message_start\ndata: {"type":"message_start","message":{"id":"${id}"}}\n\n: keepalive ${id}\n\n`;
  expect(maskBody(sse, "text/event-stream; charset=utf-8")).toBe(
    `event: message_start\ndata: {"type":"message_start","message":{"id":"req_<id>"}}\n\n: keepalive ${id}\n\n`,
  );
});

test("Responses item ids keep their index", () => {
  const body = JSON.stringify({ item_id: `msg_${id}_3`, response: { id: `resp_${id}` } });
  expect(maskBody(body, "application/json")).toBe(
    JSON.stringify({ item_id: "msg_req_<id>_3", response: { id: "resp_req_<id>" } }),
  );
});
