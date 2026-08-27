import {
  createFileRoute,
  type ErrorComponentProps,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import { catalogQuery, useProviderCatalog } from "../api/queries.ts";
import { Rack } from "../components/Rack.tsx";
import { StreamedLiveProvider, StreamProvider } from "../session/stream.tsx";
import { ProviderPalette } from "../theme/GlobalStyle.ts";
import { Module } from "../ui/Panel.tsx";
import { Failure } from "../ui/States.tsx";
import { readStatus, requireConsole } from "./-gate.ts";

/**
 * The gate in front of every console screen.
 *
 * Admits the operator and the read-only administrator. A client session is sent
 * to its own branch rather than to the login screen: it is authenticated, and
 * asking it to sign in again would be a lie about why it cannot be here.
 * `requireConsole` reads `/api/status`, the one control route that answers
 * without a session, so the guard decides before the shell renders rather than
 * letting each panel discover the expired cookie on its own.
 *
 * The provider catalog is awaited here too, and **after** the session check
 * rather than beside it. `/api/catalog` is admin-gated, so asking for it in
 * parallel would put a request that can only 401 on the one path that has no
 * session; sequenced, the unauthenticated visitor is redirected before it is
 * ever sent. `requireConsole` throws the redirect, so the ordering is enforced
 * by the throw rather than by a comment.
 *
 * Waiting on it at all is what lets `--p-<id>` exist at the first paint of
 * anything provider-coloured, and what lets the model editor read prices
 * without a loading state. The cost is stated plainly: this makes provider data
 * load-bearing for screens that have nothing to do with providers, which is why
 * `errorComponent` below is a real error with a retry rather than a spinner.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    requireConsole(await readStatus(context), location.href);
    await context.queryClient.ensureQueryData(catalogQuery);
  },
  errorComponent: GateFailure,
  component: AppShell,
});

/**
 * What a failed gate looks like.
 *
 * A `redirect` never arrives here — the router resolves one as a navigation
 * rather than as an error — so this only ever renders a real failure, and it
 * must not try to tell the two apart. The retry re-runs the load: `reset`
 * clears the boundary and `invalidate` re-runs `beforeLoad`, whose
 * `ensureQueryData` refetches a query that holds no data.
 */
function GateFailure({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <Module legend="Console unavailable">
      <Failure
        legend="The gateway did not answer"
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </Module>
  );
}

/**
 * The shell, and the palette that colours it.
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
function AppShell() {
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
