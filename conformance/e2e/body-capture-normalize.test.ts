import { expect, test } from "bun:test";
import { canonical } from "./body-capture-normalize.ts";

const id = "req_11111111-1111-4111-8111-111111111111";
const sample = (request: unknown) => ({
  typedRows: [{ at: 1, request_id: id }],
  artifacts: [
    {
      at: 1,
      client: {
        request,
        response: { object: "chat.completion", created: 1, id } as Record<string, unknown>,
      },
    },
  ],
  routes: [],
  layout: [id + ".json.enc"],
  client: JSON.stringify({ object: "chat.completion", created: 1, id }),
});

test("changed client timestamps and literal UUIDs remain detectable", () => {
  for (const [a, b] of [
    [{ at: 1 }, { at: 2 }],
    [{ created: 1 }, { created: 2 }],
    [{ created_at: 1 }, { created_at: 2 }],
    [
      { text: "22222222-2222-4222-8222-222222222222" },
      { text: "33333333-3333-4333-8333-333333333333" },
    ],
  ])
    expect(canonical(sample(a), id)).not.toEqual(canonical(sample(b), id));
});

test("only known generated fields and minted IDs vary", () => {
  const a = sample({ at: 42 });
  const otherId = "req_44444444-4444-4444-8444-444444444444";
  const b = JSON.parse(JSON.stringify(a).replaceAll(id, otherId));
  b.typedRows[0].at = 99;
  b.artifacts[0].at = 99;
  b.artifacts[0].client.response.created = 99;
  b.client = JSON.stringify({ object: "chat.completion", created: 99, id: otherId });
  expect(canonical(a, id)).toEqual(canonical(b, otherId));
});

test("response payload fields and SSE client literals are not timestamps or IDs", () => {
  const a = sample({});
  const b = sample({});
  a.artifacts[0].client.response = {
    ...a.artifacts[0].client.response,
    client: { created: 1 },
  };
  b.artifacts[0].client.response = {
    ...b.artifacts[0].client.response,
    client: { created: 2 },
  };
  expect(canonical(a, id)).not.toEqual(canonical(b, id));
  a.client =
    'data: {"object":"chat.completion.chunk","created":1,"choices":[{"delta":{"content":"22222222-2222-4222-8222-222222222222"}}]}\n\n';
  b.client = a.client.replaceAll(
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  );
  b.artifacts = a.artifacts;
  expect(canonical(a, id)).not.toEqual(canonical(b, id));
});
