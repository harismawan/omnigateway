import { matrixSmoke } from "./bench-matrix";

const config = await Bun.file(process.argv[2] as string).json();
let stop = false;
process.on("SIGTERM", () => {
  stop = true;
});
let requests = 0;
const started = performance.now();
const errors: string[] = [];
while (!stop) {
  const verdict = await matrixSmoke(config.base, config.key, config.scenario);
  requests++;
  if (verdict.classification !== "supported") errors.push(verdict.reason);
  await Bun.sleep(250);
}
console.log(
  JSON.stringify({
    requests,
    errors,
    rate: 4,
    actualRate: requests / ((performance.now() - started) / 1000),
  }),
);
