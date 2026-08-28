import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { get } from "../api/client.ts";
import { queryKeys } from "../api/queries.ts";
import type { StatusResponse } from "../api/types.ts";

/**
 * The session gate, shared by both branches.
 *
 * Named with a leading `-` so TanStack's file-based router ignores it: every
 * other file in this directory is a route, and one that is not would otherwise
 * be generated into the tree as a route exporting nothing.
 */

/**
 * Reads the session once, for whichever branch is being entered.
 *
 * `/api/status` is the one control route that answers without a session, so the
 * guard asks it before a shell renders rather than letting each panel discover
 * an expired cookie on its own.
 */
export async function readStatus(context: { queryClient: QueryClient }): Promise<StatusResponse> {
  return context.queryClient.ensureQueryData({
    queryKey: queryKeys.status,
    queryFn: () => get<StatusResponse>("/api/status"),
    revalidateIfStale: true,
  });
}

/**
 * Sends a session to the branch it belongs to.
 *
 * A wrong-branch session is not a permission problem — the guards on the server
 * already refuse it — but every panel on the wrong branch would render an empty
 * shell built from 401s, which reads as a broken gateway rather than as a
 * console the session is not for. Redirecting is the honest answer.
 *
 * The two branches redirect at each other, so this is the one place that decides
 * which way. Split across the two route files, the pair would eventually
 * disagree and bounce a session between them forever.
 */
export function homeFor(status: StatusResponse): "/" | "/client" | "/login" {
  // `== null` rather than `=== null`, and that is the one place in this file
  // loose equality is right. `get<StatusResponse>()` casts unvalidated JSON, so
  // the field is *typed* as nullable but can arrive **absent** — from an older
  // gateway, a proxy that strips fields, or a partial response. `undefined ===
  // null` is false, so the strict check fell through to `status.principal.kind`
  // and threw a TypeError inside `beforeLoad`, giving a white error boundary
  // where the login screen belongs.
  const principal = status.principal;
  if (status.authenticated !== true || principal == null) return "/login";
  // An unrecognised kind is also not a console session. A gateway newer than
  // this bundle can name a principal it has never heard of, and guessing "/"
  // for it would put an unknown session in front of the operator's console.
  return principal.kind === "client"
    ? "/client"
    : principal.kind === "admin" || principal.kind === "viewer"
      ? "/"
      : "/login";
}

/** Throws the redirect a console route needs, or returns for an allowed session. */
export function requireConsole(status: StatusResponse, href: string): void {
  const home = homeFor(status);
  if (home === "/login") throw redirect({ to: "/login", search: { next: href } });
  // A client session on `/app/*`: its own branch, not the login screen. Sending
  // it to `/login` would ask it to authenticate again while it already is.
  if (home !== "/") throw redirect({ to: home });
}

/** The same, for the client branch. */
export function requireClient(status: StatusResponse, href: string): void {
  const home = homeFor(status);
  if (home === "/login") throw redirect({ to: "/login", search: { next: href } });
  if (home !== "/client") throw redirect({ to: home });
}
