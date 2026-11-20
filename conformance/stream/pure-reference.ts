// These imports are byte-identical to frozen 1780bb39.

import { authorised } from "../../apps/gateway/src/routes/stream.ts";
import { createCoalescer } from "../../apps/gateway/src/stream/coalescer.ts";
import { parseClientFrame, topicClass } from "../../apps/gateway/src/stream/protocol.ts";
import { createRing } from "../../apps/gateway/src/stream/ring.ts";

const input = JSON.parse(await Bun.stdin.text());
const output: string[] = [];
const record = (value: unknown) => output.push(JSON.stringify(value));
for (const raw of input.frames) record(parseClientFrame(raw));
for (const topic of input.topics) {
  record(topicClass(topic));
  for (const kind of ["admin", "viewer", "client", "machine"]) {
    record(
      authorised(
        { opened: () => false } as Parameters<typeof authorised>[0],
        { kind, pluginId: "p" } as Parameters<typeof authorised>[1],
        topic,
      ),
    );
  }
}
const ring = createRing(input.limits);
for (const op of input.ring) {
  if (op[0] === "push") record(ring.push(op[1], op[2], op[3]));
  if (op[0] === "since") record(ring.since(op[1], op[2]));
  if (op[0] === "head") record(ring.head(op[1]));
  if (op[0] === "reset") ring.reset(op[1]);
  if (op[0] === "drop") ring.drop(op[1]);
}
let now = 0;
const timers = new Map<number, { at: number; run: () => void }>();
let next = 0;
const coalescer = createCoalescer({
  floors: { "res:quota": 5000 },
  defaultFloorMs: 1000,
  now: () => now,
  sink: (topic, payload) => record({ at: now, topic, payload }),
  schedule: (run, ms) => {
    const id = next++;
    timers.set(id, { at: now + ms, run });
    return () => {
      timers.delete(id);
    };
  },
});
for (const op of input.coalescer) {
  if (op[0] === "emit") coalescer.emit(op[1], op[2]);
  if (op[0] === "flush") coalescer.flush();
  if (op[0] === "stop") coalescer.stop();
  if (op[0] === "advance") {
    const end = op[1];
    now = end;
    while (true) {
      const first = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      timers.delete(first[0]);
      first[1].run();
    }
    now = end;
  }
}
console.log(JSON.stringify(output));
