/**
 * The console's copy of the gateway's password rule.
 *
 * A plain `.ts` module rather than a constant inside `AccessPanel.tsx`, so the
 * mirror test can import it without rendering a component.
 */

/**
 * The shortest password the form will submit.
 *
 * Restated from `MIN_PASSWORD_LENGTH` in
 * `crates/omni-control/src/admin_password.rs`. The server checks it too — this
 * is a courtesy so the form can say it before the round trip, never the guard.
 * `test/api/rustMirrors.test.ts` keeps the two equal.
 */
export const MIN_PASSWORD_LENGTH = 12;
