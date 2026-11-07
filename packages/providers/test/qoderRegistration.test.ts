import { expect, test } from "bun:test";
import { BODY_ORDER } from "../src/body.ts";
import { builtinOAuthFlows } from "../src/builtinOAuth.ts";
import { PROVIDER_MODEL_CATALOG } from "../src/catalog.ts";
import { PROVIDER_DESCRIPTORS } from "../src/descriptors.ts";
import { PROFILES } from "../src/profile.ts";
import { PROVIDERS } from "../src/registry.ts";

test("Qoder registers OAuth-only without invented models or model prefixes", () => {
  expect(PROVIDERS.qoder).toBeDefined();
  expect(PROVIDER_DESCRIPTORS.qoder?.modelPrefixes).toEqual([]);
  expect(PROVIDER_DESCRIPTORS.qoder?.presentation.label).toBe("Qoder");
  expect(PROVIDER_MODEL_CATALOG.qoder).toMatchObject({
    models: [],
    defaultModel: "",
    authTypes: ["oauth"],
  });
  expect(BODY_ORDER.qoder).toContain("model_config");
  expect(PROFILES.qoder).toBeDefined();
  expect(builtinOAuthFlows().at(-1)?.[0]).toBe("qoder");
});
