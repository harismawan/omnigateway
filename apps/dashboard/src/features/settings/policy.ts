/**
 * The console's copy of the gateway's password rule.
 *
 * A plain `.ts` module rather than a constant inside `AccessPanel.tsx` for the
 * same reason `theme/tokens.ts` is one: the test that pins this mirror lives in
 * `apps/gateway`, which is the only place that may import both sides, and that
 * package's tsconfig does not set `--jsx`. A constant only reachable through a
 * component file is a constant no mirror test can hold.
 */

/**
 * The shortest password the form will submit.
 *
 * Restated from `MIN_PASSWORD_LENGTH` in `@omni/control`, which the console
 * cannot import under boundary rule 12. The server checks it too — this is a
 * courtesy so the form can say it before the round trip, never the guard.
 * `apps/gateway/test/routes/passwordPolicyMirror.test.ts` keeps the two equal.
 */
export const MIN_PASSWORD_LENGTH = 12;
