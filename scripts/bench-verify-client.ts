import { matrixSmoke } from "./bench-matrix";

export function runVerifier(
  request: () => Promise<{ classification: string; reason: string }>,
  clock = {
    now: () => performance.now(),
    schedule: (tick: () => void) => {
      const timer = setInterval(tick, 250);
      return () => clearInterval(timer);
    },
  },
) {
  const epoch = clock.now();
  let started = 0,
    completed = 0,
    skippedTicks = 0;
  let stopped = false;
  let pending: Promise<void> | undefined;
  const errors: string[] = [];
  const tick = () => {
    if (stopped) return;
    if (pending) {
      skippedTicks++;
      return;
    }
    started++;
    pending = (async () => {
      try {
        const verdict = await request();
        if (verdict.classification !== "supported") errors.push(verdict.reason);
      } catch (error) {
        errors.push(String(error));
      }
      completed++;
    })().finally(() => {
      pending = undefined;
    });
  };
  const cancel = clock.schedule(tick);
  tick();
  return {
    async stop() {
      stopped = true;
      cancel();
      await pending;
      return {
        started,
        completed,
        skippedTicks,
        violations: errors.length,
        requests: completed,
        errors,
        rate: 4,
        actualRate: started / ((clock.now() - epoch) / 1000),
      };
    },
  };
}

if (import.meta.main) {
  const config = await Bun.file(process.argv[2] as string).json();
  const run = runVerifier(() => matrixSmoke(config.base, config.key, config.scenario));
  process.once("SIGTERM", async () => console.log(JSON.stringify(await run.stop())));
}
