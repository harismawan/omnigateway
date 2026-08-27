import {
  createFileRoute,
  type ErrorComponentProps,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { get } from "../api/client.ts";
import { catalogQuery, queryKeys, useProviderCatalog } from "../api/queries.ts";
import type { StatusResponse } from "../api/types.ts";
import { Rack } from "../components/Rack.tsx";
import { StreamedLiveProvider, StreamProvider } from "../session/stream.tsx";
import { ProviderPalette } from "../theme/GlobalStyle.ts";
import { Module } from "../ui/Panel.tsx";
import { Failure, SkeletonRows } from "../ui/States.tsx";

/**
 * The gate in front of every console screen.
 *
 * `/api/status` is the one control route that answers without a session, so the
 * guard asks it before the shell renders rather than letting each panel discover
 * the expired cookie on its own.
 *
 * The provider catalog is awaited here too, and after the session check rather
 * than beside it. `/api/catalog` is admin-gated, so asking for it in parallel
 * would put a request that can only 401 on the one path that has no session;
 * sequenced, the unauthenticated visitor is redirected before it is ever sent.
 *
 * Waiting on it at all is what lets `--p-<id>` exist at the first paint of
 * anything provider-coloured, and what lets the model editor read prices
 * without a loading state. The cost is stated plainly: this makes provider data
 * load-bearing for screens that have nothing to do with providers, which is why
 * `errorComponent` below is a real error with a retry rather than a spinner.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: queryKeys.status,
      queryFn: () => get<StatusResponse>("/api/status"),
      revalidateIfStale: true,
    });

    if (!status.authenticated) {
      throw redirect({ to: "/login", search: { next: location.href } });
    }

    await context.queryClient.ensureQueryData(catalogQuery);
  },
  pendingComponent: GatePending,
  // How long the console may stay blank before it says something.
  //
  // Stated, because the router's default is 1000ms and a `pendingComponent`
  // alone would therefore have left the first second exactly as it was: the
  // match is not even committed until this elapses, so nothing renders at all.
  // Not zero either — a gateway on the same machine answers both of these in
  // single-digit milliseconds, and a skeleton shown for every load of a console
  // that is never slow is its own kind of lie, held for `pendingMinMs` after it
  // appears. 200ms is under the threshold where a person reads a delay as a
  // fault, and over the time this takes when nothing is wrong.
  pendingMs: 200,
  errorComponent: GateFailure,
  component: AppShell,
});

/**
 * What the console looks like while the gate is still asking.
 *
 * Without one, `document.body` is *empty* for as long as the two requests take
 * — and on a gateway that is refusing rather than hanging, that is three
 * attempts and their backoff before the error screen appears. A blank page is
 * the one thing the design for this gate ruled out, alongside a permanent
 * spinner, and it was what shipped first: the error screen was written and the
 * state in front of it was not.
 *
 * Deliberately the same treatment every board already uses for the same
 * question — a legend and shimmer rows, no spinner, nothing that claims to know
 * how long this will take. `SkeletonRows` is `aria-hidden`, so what a screen
 * reader is told is the legend alone.
 */
function GatePending() {
  return (
    <Module legend="Console">
      <SkeletonRows rows={6} />
    </Module>
  );
}

/**
 * What a failed gate looks like.
 *
 * A `redirect` never arrives here — the router resolves one as a navigation
 * rather than as an error — so this only ever renders a real failure, and it
 * must not try to tell the two apart. The retry re-runs the load: `invalidate`
 * re-runs `beforeLoad`, whose `ensureQueryData` refetches a query that holds no
 * data.
 *
 * `reset` is deliberately **not** called, and the omission is the interesting
 * part. The router keys this boundary on the match object itself
 * (`getResetKey: () => match`), so a successful invalidation clears the error by
 * handing the boundary a new one. Calling `reset` first only empties the
 * boundary for the render in between, which immediately rethrows the same error
 * out of the still-failed match — so it did nothing except look like the thing
 * that made the retry work.
 */
function GateFailure({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <Module legend="Console unavailable">
      <Failure
        legend="The gateway did not answer"
        error={error}
        onRetry={() => void router.invalidate()}
      />
    </Module>
  );
}

/**
 * The shell, and the palette that colours it.
 *
 * Exported so a test can mount it and read what it actually renders. It used to
 * be private, and the only instrument on the palette mount was a regular
 * expression over this file's source — which is satisfied by text that no
 * longer runs. Replacing `component` above with a shell of its own leaves this
 * function here, unreferenced and still matching.
 *
 * `ProviderPalette` is mounted here rather than beside `GlobalStyle` because
 * its values are gateway state: the login screen must render before there is a
 * session to read them with, and every provider-coloured element is inside this
 * shell. `beforeLoad` has already resolved the catalog, so the custom
 * properties go in on the same commit as the first element that uses one.
 *
 * The socket is mounted above the LIVE switch, not beside it: the switch now
 * reads transport state, so the provider that owns the transport has to be the
 * outer one. Reversed, every board polls forever and nothing says so.
 */
export function AppShell() {
  const catalog = useProviderCatalog().data ?? [];
  return (
    <StreamProvider>
      <StreamedLiveProvider>
        <ProviderPalette $providers={catalog} />
        <Rack>
          <Outlet />
        </Rack>
      </StreamedLiveProvider>
    </StreamProvider>
  );
}
