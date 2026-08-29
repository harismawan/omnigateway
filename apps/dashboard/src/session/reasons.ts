/**
 * Why the console sent the operator back to the login screen.
 *
 * A closed set of codes rather than a message, mapped to a fixed sentence on
 * arrival. The value travels in a query parameter, and a login screen that
 * printed whatever text a URL handed it would be a phishing surface even though
 * React escapes it — the code is the only thing that crosses, and an unknown one
 * shows nothing at all.
 */
const LOGIN_REASONS = {
  "admin-password-changed":
    "The restored database carries a different admin password, so every session ended. Sign in with the password that database was saved with.",
  "password-changed":
    "The admin password was changed, so every session ended. Sign in with the new password.",
} as const;

export type LoginReason = keyof typeof LOGIN_REASONS;

/** The sentence for a reason code, or null for anything not on the list. */
export function describeLoginReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  return Object.hasOwn(LOGIN_REASONS, reason) ? LOGIN_REASONS[reason as LoginReason] : null;
}

/**
 * Leaves the console for the login screen the long way round.
 *
 * A full page load rather than a router navigation, because the session this
 * process was built around no longer exists: the cookie is dead and every cached
 * query holds rows from a database that has been replaced. Reloading is the only
 * way to be sure nothing stale survives into the next sign-in.
 */
export function endAdminSession(reason: LoginReason): void {
  window.location.assign(`/login?reason=${reason}`);
}
