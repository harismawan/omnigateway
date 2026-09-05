import { Power, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import styled from "styled-components";
import { useLifecycle, useRestart, useShutdown } from "../api/queries.ts";
import type { Supervisor } from "../api/types.ts";
import { Button } from "../ui/Button.tsx";
import { Legend, pulsing, Spacer, Stack } from "../ui/primitives.ts";
import { describeError } from "../ui/States.tsx";
import { Confirm } from "./Confirm.tsx";

/**
 * What is watching this process, in the operator's terms rather than a flag.
 *
 * The rail has no room to print any of these, so they are the section's title:
 * the sentence is still one hover away from the control it qualifies, and the
 * confirm dialog repeats whichever part of it decides what a click does.
 */
const SUPERVISOR_BLURB: Record<Supervisor, string> = {
  systemd:
    "systemd is capturing this process, so a restart asks the manager to bring the unit back rather than signalling the gateway itself.",
  container:
    "This gateway is running in a container, so a restart is an exit and the container's restart policy decides what happens next.",
  none: "Nothing is supervising this process. It was started directly, and whatever stops it leaves it stopped.",
};

const Rule = styled.hr`
  flex: none;
  border: 0;
  margin: 0;
  height: 1px;
  align-self: stretch;
  background: ${({ theme }) => theme.color.rule};

  /* The rail turns on its side below 720px, and so does the rule that closes it. */
  @media (max-width: 720px) {
    height: auto;
    width: 1px;
    margin-left: ${({ theme }) => theme.space(2)};
  }
`;

/**
 * The foot of the rail: two controls that act on the process rather than
 * navigate within it, held apart from the links above by a spacer and a rule.
 *
 * Across the shell rather than on one screen because stopping the gateway is
 * not a database operation — it was only ever filed next to snapshots because
 * that page had room for it.
 */
const Foot = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: ${({ theme }) => theme.space(2)};

  @media (max-width: 720px) {
    padding-top: 0;
    padding-left: ${({ theme }) => theme.space(2)};
    flex-direction: row;
    align-items: center;
  }
`;

/**
 * The rail is 168px wide, so these wrap rather than run past its edge. The
 * accessible name stays the full "Restart gateway" — a button reading "Restart"
 * alone is ambiguous to anyone who arrives at it without the rail's context.
 */
const RailButton = styled(Button)`
  justify-content: flex-start;
  width: 100%;

  @media (max-width: 720px) {
    width: auto;
  }
`;

const Note = styled.p`
  font-size: 10.5px;
  line-height: 1.3;
  color: ${({ theme }) => theme.color.warn};
`;

const Problem = styled.p`
  font-size: 10.5px;
  line-height: 1.3;
  color: ${({ theme }) => theme.color.down};
`;

const Watching = styled.p`
  font-size: 10.5px;
  line-height: 1.3;
  color: ${({ theme }) => theme.color.inkDim};
  ${pulsing}
`;

/** Sits on the rule that closes the rail, so it reads as the rail's colophon. */
const Version = styled.span`
  flex: none;
  font-size: 10.5px;
  line-height: 1.3;
  color: ${({ theme }) => theme.color.inkFaint};
  padding: 0 ${({ theme }) => theme.space(2)} 6px;

  @media (max-width: 720px) {
    padding: 0 ${({ theme }) => theme.space(2)};
  }
`;

const Stopped = styled.p`
  font-size: 10.5px;
  line-height: 1.3;
  color: ${({ theme }) => theme.color.inkDim};
`;

/** How often the liveness probe is repeated while a restart is in progress. */
export const RESTART_POLL_MS = 750;

/** How long a restart is given before the console stops claiming it is coming. */
const RESTART_DEADLINE_MS = 90_000;

/**
 * Where a restart has got to.
 *
 * `leaving` and `returning` are separate states rather than one "restarting",
 * because a gateway that is still answering has not gone yet and one that has
 * gone is not ready to be reloaded into. A console that could not tell them
 * apart would have to guess with a timer.
 */
type Phase = "idle" | "leaving" | "returning" | "lost";

/**
 * Whether the gateway is answering, as a boolean and never as an exception.
 *
 * `/health` is the gateway's own unauthenticated liveness route, and it is the
 * one thing this console reads outside `/api/*`: during a restart there is no
 * session to authenticate with and no route to authenticate against, which is
 * exactly the state being measured. A refused connection is the expected answer
 * here, not a failure.
 */
async function answering(): Promise<boolean> {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stopping and starting the process, from the console it is serving.
 *
 * The two controls are not variants of each other. A restart is expected back
 * and the console waits for it; a shutdown is not, and the console says so and
 * stops. That asymmetry is the whole of this component.
 */
export function LifecycleControls({ pollMs = RESTART_POLL_MS }: { pollMs?: number }) {
  const lifecycle = useLifecycle();
  const restart = useRestart();
  const shutdown = useShutdown();
  const [asking, setAsking] = useState<"restart" | "shutdown" | null>(null);
  const [watching, setWatching] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");

  const capability = lifecycle.data;

  /**
   * The wait, in two stages, ending in a reload.
   *
   * Nothing here is a fixed delay. The console watches the gateway stop
   * answering, then watches it answer again, and only then reloads — a page
   * that reloaded on a timer would land either before the process went or while
   * it was still starting, and both look to an operator like a failed restart.
   *
   * Which stage the wait is in lives in a local rather than in `phase`, so that
   * reaching the second one does not re-run this effect and forget that the
   * gateway had already gone.
   */
  useEffect(() => {
    if (!watching) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    let attempts = 0;
    const limit = Math.max(1, Math.ceil(RESTART_DEADLINE_MS / pollMs));

    const tick = async (): Promise<void> => {
      const up = await answering();
      if (cancelled) return;

      if (!gone && !up) {
        gone = true;
        setPhase("returning");
      } else if (gone && up) {
        window.location.reload();
        return;
      }

      attempts += 1;
      if (attempts >= limit) {
        setPhase("lost");
        setWatching(false);
        return;
      }
      timer = setTimeout(() => void tick(), pollMs);
    };

    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [watching, pollMs]);

  const beginRestart = () => {
    setPhase("leaving");
    restart.mutate(undefined, {
      onSuccess: () => setWatching(true),
      // A refused restart is an ordinary error from a gateway that is still
      // running, so there is nothing to wait for.
      onError: () => setPhase("idle"),
    });
  };

  /**
   * The end of the console, not a state it recovers from.
   *
   * A restart has a second half this console can watch; a shutdown does not.
   * Leaving the controls in the rail would offer an operator a restart button
   * that has nothing left to talk to.
   */
  if (stopped) {
    return (
      <>
        <Spacer />
        {capability === undefined ? null : <Version>omnigateway v{capability.version}</Version>}
        <Rule />
        <Foot>
          <Stack $gap={1}>
            <Legend>Gateway stopped</Legend>
            <Stopped>
              Nothing on this screen will update again, and nothing here can start it: that needs{" "}
              {capability?.supervisor === "container"
                ? "the host that runs this container"
                : "a shell on the machine it runs on"}
              .
            </Stopped>
          </Stack>
        </Foot>
      </>
    );
  }

  return (
    <>
      <Spacer />
      {capability === undefined ? null : <Version>omnigateway v{capability.version}</Version>}
      <Rule />
      <Foot title={capability === undefined ? undefined : SUPERVISOR_BLURB[capability.supervisor]}>
        <RailButton
          type="button"
          $size="sm"
          aria-label="Restart gateway"
          disabled={
            capability === undefined || !capability.canRestart || restart.isPending || watching
          }
          onClick={() => setAsking("restart")}
        >
          <RotateCw />
          Restart
        </RailButton>
        <RailButton
          type="button"
          $size="sm"
          $variant="danger"
          aria-label="Shut down gateway"
          disabled={
            capability === undefined || !capability.canShutdown || shutdown.isPending || watching
          }
          onClick={() => setAsking("shutdown")}
        >
          <Power />
          Shut down
        </RailButton>

        {capability?.note === undefined ? null : <Note>{capability.note}</Note>}

        {phase === "leaving" ? (
          <Watching role="status">Restarting. Waiting for the gateway to stop answering.</Watching>
        ) : phase === "returning" ? (
          <Watching role="status">
            The gateway has stopped answering. Waiting for it to come back, then this page reloads.
          </Watching>
        ) : phase === "lost" ? (
          <Problem role="alert">
            The gateway has not come back. Reload this page once it is running again, or check the
            machine it runs on.
          </Problem>
        ) : null}

        {restart.isError ? <Problem role="alert">{describeError(restart.error)}</Problem> : null}
        {shutdown.isError ? <Problem role="alert">{describeError(shutdown.error)}</Problem> : null}
      </Foot>

      <Confirm
        open={asking === "restart"}
        onOpenChange={(next) => {
          if (!next) setAsking(null);
        }}
        title="Restart gateway"
        body={`${capability === undefined ? "" : `${SUPERVISOR_BLURB[capability.supervisor]} `}Requests in flight are dropped when the process goes. This console waits for the gateway to stop answering and to answer again, then reloads itself.`}
        confirmLabel="Restart now"
        busy={restart.isPending}
        onConfirm={() => {
          setAsking(null);
          beginRestart();
        }}
      />

      <Confirm
        open={asking === "shutdown"}
        onOpenChange={(next) => {
          if (!next) setAsking(null);
        }}
        title="Shut down gateway"
        body={
          capability?.supervisor === "container"
            ? "Stopping the only process in this container takes this dashboard with it, and the dashboard is what would have restarted the gateway. Unless the container's restart policy brings it back, getting it running again needs access to the host."
            : "The gateway stops serving and stays stopped. This console goes with it, so starting the gateway again needs a shell on the machine it runs on."
        }
        confirmLabel="Shut down now"
        busy={shutdown.isPending}
        onConfirm={() => {
          setAsking(null);
          shutdown.mutate(undefined, { onSuccess: () => setStopped(true) });
        }}
      />
    </>
  );
}
