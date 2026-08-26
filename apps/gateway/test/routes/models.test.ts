import { expect, test } from "bun:test";
import { target, virtualModel } from "@omni/testkit";
import { describeModel, modelListBody } from "../../src/routes/models.ts";

test("reports the catalog's window for a target the catalog lists", () => {
  const described = describeModel(
    virtualModel({
      id: "opus",
      targets: [target({ provider: "anthropic", model: "claude-opus-5" })],
    }),
    [
      {
        id: "anthropic-oauth",
        provider: "anthropic",
        authType: "oauth",
        enabled: true,
        providerData: {},
      },
    ],
  );

  expect(described.max_input_tokens).toBe(1_000_000);
  expect(described.max_tokens).toBe(128_000);
  expect(described.display_name).toBe("Claude Opus 5");
});

test("a target's own figures outrank the catalog's", () => {
  const described = describeModel(
    virtualModel({
      id: "opus",
      targets: [
        target({
          provider: "anthropic",
          model: "claude-opus-5",
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        }),
      ],
    }),
    [
      {
        id: "anthropic-oauth",
        provider: "anthropic",
        authType: "oauth",
        enabled: true,
        providerData: {},
      },
    ],
  );

  expect(described.max_input_tokens).toBe(200_000);
  expect(described.max_tokens).toBe(32_000);
});

test("an OpenAI target served by OAuth reports the Codex window, not the API's", () => {
  const model = virtualModel({
    id: "gpt",
    targets: [target({ provider: "openai", model: "gpt-5.6" })],
  });

  expect(
    describeModel(model, [
      {
        id: "openai-apiKey",
        provider: "openai",
        authType: "apiKey",
        enabled: true,
        providerData: {},
      },
    ]).max_input_tokens,
  ).toBe(922_000);
  // An OAuth credential is routed to Codex, which caps the window at 272K.
  expect(
    describeModel(model, [
      {
        id: "openai-oauth",
        provider: "openai",
        authType: "oauth",
        enabled: true,
        providerData: {},
      },
    ]).max_input_tokens,
  ).toBe(272_000);
  // Either could serve the request, so the client is told what both can take.
  expect(
    describeModel(model, [
      {
        id: "openai-apiKey",
        provider: "openai",
        authType: "apiKey",
        enabled: true,
        providerData: {},
      },
      {
        id: "openai-oauth",
        provider: "openai",
        authType: "oauth",
        enabled: true,
        providerData: {},
      },
    ]).max_input_tokens,
  ).toBe(272_000);
});

test("a disabled credential does not narrow the window it can no longer serve", () => {
  const described = describeModel(
    virtualModel({ id: "gpt", targets: [target({ provider: "openai", model: "gpt-5.6" })] }),
    [
      {
        id: "openai-apiKey",
        provider: "openai",
        authType: "apiKey",
        enabled: true,
        providerData: {},
      },
      {
        id: "openai-oauth",
        provider: "openai",
        authType: "oauth",
        enabled: false,
        providerData: {},
      },
    ],
  );

  expect(described.max_input_tokens).toBe(922_000);
});

test("another provider's credentials say nothing about this one", () => {
  const described = describeModel(
    virtualModel({ id: "gpt", targets: [target({ provider: "openai", model: "gpt-5.6" })] }),
    [
      {
        id: "anthropic-oauth",
        provider: "anthropic",
        authType: "oauth",
        enabled: true,
        providerData: {},
      },
    ],
  );

  expect(described.max_input_tokens).toBe(922_000);
});

test("a pool advertises the smallest window any of its targets can hold", () => {
  // Failover can land on either target, so a request sized to the 1M primary
  // would fail on the 200K fallback if the pool advertised the larger figure.
  const described = describeModel(
    virtualModel({
      id: "mixed",
      targets: [
        target({ provider: "anthropic", model: "claude-opus-5" }),
        target({ provider: "anthropic", model: "claude-haiku-4-5" }),
      ],
    }),
    [
      {
        id: "anthropic-apiKey",
        provider: "anthropic",
        authType: "apiKey",
        enabled: true,
        providerData: {},
      },
    ],
  );

  expect(described.max_input_tokens).toBe(200_000);
  expect(described.max_tokens).toBe(64_000);
});

test("a pool of several targets keeps the operator's own name", () => {
  const described = describeModel(
    virtualModel({
      id: "mixed",
      targets: [
        target({ provider: "anthropic", model: "claude-opus-5" }),
        target({ provider: "anthropic", model: "claude-haiku-4-5" }),
      ],
    }),
    [],
  );

  // "Claude Opus 5" would describe one of the two upstreams and misdescribe the
  // request that fails over to the other.
  expect(described.display_name).toBe("mixed");
});

test("says nothing about a model nobody has described", () => {
  const described = describeModel(
    virtualModel({ id: "mystery", targets: [target({ model: "some-unlisted-model" })] }),
    [],
  );

  expect(described).not.toHaveProperty("max_input_tokens");
  expect(described).not.toHaveProperty("max_tokens");
  // Falling back to the operator's own id: no catalog entry names this model.
  expect(described.display_name).toBe("mystery");
});

test("carries both dialects of the same entry", () => {
  const body = modelListBody(
    [
      virtualModel({
        id: "fast",
        targets: [target({ provider: "anthropic", model: "claude-opus-5" })],
      }),
    ],
    [],
  );

  expect(body.object).toBe("list");
  expect(body.first_id).toBe("fast");
  expect(body.last_id).toBe("fast");
  expect(body.has_more).toBe(false);
  expect(body.data[0]).toMatchObject({
    id: "fast",
    object: "model",
    type: "model",
    owned_by: "omnigateway",
    created: 0,
    created_at: "1970-01-01T00:00:00.000Z",
  });
});

test("an empty listing has no cursors to follow", () => {
  const body = modelListBody([], []);

  expect(body.data).toEqual([]);
  expect(body.first_id).toBeNull();
  expect(body.last_id).toBeNull();
});

test("lists a pool whose id begins with claude/ like any other", () => {
  // `claude/` was once reserved for discovery mirrors. The mirrors are gone, so
  // the prefix is an ordinary part of a pool's name and must list unchanged.
  const body = modelListBody(
    [virtualModel({ id: "claude/opus", targets: [target({ provider: "anthropic" })] })],
    [
      {
        id: "anthropic-oauth",
        provider: "anthropic",
        authType: "oauth",
        enabled: true,
        providerData: {},
      },
    ],
  );
  expect(body.data.map((entry) => entry.id)).toEqual(["claude/opus"]);
  expect(body.data[0]?.root).toBeUndefined();
  expect(body.last_id).toBe("claude/opus");
});
