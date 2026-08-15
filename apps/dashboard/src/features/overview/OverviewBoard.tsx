import {
  useCredentialHealth,
  useCredentials,
  useLogs,
  useModels,
  useSettings,
  useUsage,
} from "../../api/queries.ts";
import { PageHead } from "../../components/Rack.tsx";
import { credentialStatus, groupBy } from "../../lib/vitals.ts";
import { useLive } from "../../session/live.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Grid, Stack } from "../../ui/primitives.ts";
import { Failure } from "../../ui/States.tsx";
import { AccountRack } from "./AccountRack.tsx";
import { ActivityTail } from "./ActivityTail.tsx";
import { ModelTraffic } from "./ModelTraffic.tsx";
import { VitalsRow } from "./VitalsRow.tsx";

/** The log tail reliably covers the recent past; one hour is what it is read for. */
const WINDOW_MS = 3_600_000;

/**
 * One screen that answers the only question worth asking on arrival: is
 * anything wrong, and if so, where. Faults sort to the top of the account list,
 * so a healthy gateway reads as a quiet page rather than as a wall of green.
 */
export function OverviewBoard() {
  const { cadence } = useLive();
  const credentials = useCredentials();
  const health = useCredentialHealth(cadence(10_000));
  const models = useModels();
  const logs = useLogs(500, cadence(10_000));
  const settings = useSettings();

  const now = Date.now();
  const since = Math.floor((now - WINDOW_MS) / 60_000) * 60_000;
  const usage = useUsage({ groupBy: "credential", since }, cadence(60_000));

  const rows = credentials.data ?? [];
  const healthByCredential = groupBy(health.data?.health ?? [], (row) => row.credentialId);
  const faults = rows.filter(
    (credential) =>
      credentialStatus(
        healthByCredential.get(credential.id) ?? [],
        now,
        credential.enabled,
        credential.disabledReason,
      ).state === "down",
  );

  const summary =
    credentials.isLoading || logs.isLoading
      ? "Reading the gateway…"
      : rows.length === 0
        ? "No accounts are connected, so every request fails at the router."
        : faults.length > 0
          ? // "Out of rotation" covers both faults now: an open breaker and a
            // credential the provider repudiated. The row itself says which.
            `${faults.length} account${faults.length === 1 ? " is" : "s are"} out of rotation.`
          : `All ${rows.length} accounts are answering. Nothing needs attention.`;

  return (
    <>
      <PageHead legend="Rack" title="Gateway" summary={summary} />

      {logs.isError ? (
        <Module legend="Traffic">
          <Failure
            legend="The gateway did not answer"
            error={logs.error}
            onRetry={() => void logs.refetch()}
          />
        </Module>
      ) : (
        <Stack $gap={4}>
          <VitalsRow logs={logs.data ?? []} windowMs={WINDOW_MS} now={now} />

          <AccountRack
            credentials={rows}
            health={health.data?.health ?? []}
            quota={health.data?.quota ?? []}
            burn={health.data?.burn ?? []}
            usage={usage.data ?? []}
            quotaPollIntervalMs={settings.data?.quotaPollIntervalMs ?? 300_000}
            now={now}
          />

          <Grid $min="340px" $gap={4}>
            <ModelTraffic models={models.data ?? []} logs={logs.data ?? []} />
            <ActivityTail logs={logs.data ?? []} />
          </Grid>
        </Stack>
      )}
    </>
  );
}
