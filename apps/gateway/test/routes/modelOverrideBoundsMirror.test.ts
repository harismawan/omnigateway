/**
 * The console's bounds on per-model overrides, pinned to the schema's.
 *
 * `apps/dashboard/src/features/keys/limits.ts` declares `MAX_MODEL_OVERRIDES`
 * and `MAX_MODEL_NAME_LENGTH` itself rather than importing them: boundary rule
 * 12 keeps `@omni/ratelimit` out of the console, and its catalog would bring zod
 * into the browser with it. The copy is deliberate; this file keeps it honest.
 *
 * Here because this is the one place that may import both, the same shape as
 * `passwordPolicyMirror.test.ts`. `@omni/ratelimit/catalog` is the source of
 * truth — it is the one that refuses — so a failure means the console's copy is
 * stale and the fix is to move the copy.
 *
 * Both directions of drift are silent. Raise the schema's bound alone and the
 * dialog refuses a key the gateway would store; lower it alone and the dialog
 * sends one the gateway refuses, naming a JSON path instead of the row.
 */

import { describe, expect, test } from "bun:test";
import { MAX_MODEL_NAME_LENGTH, MAX_MODEL_OVERRIDES } from "@omni/ratelimit/catalog";
import {
  MAX_MODEL_NAME_LENGTH as CONSOLE_NAME_LENGTH,
  MAX_MODEL_OVERRIDES as CONSOLE_OVERRIDES,
} from "../../../dashboard/src/features/keys/limits.ts";

describe("the console's per-model override bounds", () => {
  test("are the bounds the schema enforces", () => {
    expect(CONSOLE_OVERRIDES).toBe(MAX_MODEL_OVERRIDES);
    expect(CONSOLE_NAME_LENGTH).toBe(MAX_MODEL_NAME_LENGTH);
  });

  test("are real bounds, not disabled ones", () => {
    // A mirror passes trivially if both sides drift to zero together.
    expect(MAX_MODEL_OVERRIDES).toBeGreaterThan(0);
    expect(MAX_MODEL_NAME_LENGTH).toBeGreaterThan(0);
  });
});
