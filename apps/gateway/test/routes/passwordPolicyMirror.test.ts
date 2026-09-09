/**
 * The console's minimum password length, pinned to the gateway's.
 *
 * `apps/dashboard/src/features/settings/policy.ts` declares
 * `MIN_PASSWORD_LENGTH` itself rather than importing it. It has to: boundary
 * rule 12 forbids the console importing `@omni/control`. The copy is
 * deliberate. This file is what keeps it honest.
 *
 * The console's copy sits in a `.ts` module rather than in `AccessPanel.tsx`
 * because this package's tsconfig does not set `--jsx`, so a constant reachable
 * only through a component file is one no test here could import.
 *
 * It lives in `apps/gateway` because this is the only place that may import
 * both, the same reason and the same shape as `providerIdMirror.test.ts` and
 * `plugins/limitVocabulary.test.ts`.
 *
 * Direction matters. `@omni/control` is the source of truth: it is the only one
 * of the two that can refuse anything. A failure here means the console's mirror
 * is stale, and the fix is to move the mirror, never to move the server's rule
 * to match a form.
 *
 * Both directions of drift are silent, which is why this is worth a file. Raise
 * the server's minimum alone and the form keeps accepting a password the server
 * rejects, so the operator is told "12 characters" by the screen and refused by
 * the gateway. Lower the server's alone and the form refuses what would have
 * been accepted, which nobody ever reports because it reads as the rule working.
 */

import { describe, expect, test } from "bun:test";
import { MIN_PASSWORD_LENGTH } from "@omni/control";
import { MIN_PASSWORD_LENGTH as CONSOLE_MIN } from "../../../dashboard/src/features/settings/policy.ts";

describe("the console's password policy", () => {
  test("is the length the gateway actually enforces", () => {
    expect(CONSOLE_MIN).toBe(MIN_PASSWORD_LENGTH);
  });

  test("is a real bound, not a disabled one", () => {
    // A mirror test passes trivially if both sides drift to zero together, which
    // is the one way this file could hold while the rule underneath it is gone.
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });
});
