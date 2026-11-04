import { expect, test } from "bun:test";
import { parsePublicModelCatalog } from "../src/accountCatalog.ts";

test("public account catalog strips secrets, invalid rows and nonpositive limits", () => {
  expect(
    parsePublicModelCatalog({
      version: 1,
      token: "secret",
      models: [
        {
          id: "synthetic",
          name: "Synthetic",
          api_key: "secret",
          pricing: null,
          limits: { contextWindow: 1234, maxOutputTokens: -1 },
          url: "https://evil.test",
        },
      ],
    }),
  ).toEqual({
    version: 1,
    models: [
      { id: "synthetic", name: "Synthetic", pricing: null, limits: { contextWindow: 1234 } },
    ],
  });
  for (const bad of [null, {}, { version: 2, models: [] }])
    expect(parsePublicModelCatalog(bad)).toBeNull();
});
