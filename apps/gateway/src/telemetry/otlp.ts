import type { Logger } from "@omni/ir";
import { encodeTrace, type TraceRecord } from "./spans.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

import type { MetricRegistry } from "./registry.ts";

export type OtlpExporter = {
  enqueue(trace: TraceRecord): void;
  flush(): Promise<void>;
  queued(): number;
  stop(): void;
};

type Schedule = (run: () => void, ms: number) => () => void;

export function createOtlpExporter(opts: {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  capacity: number;
  batchMax: number;
  intervalMs: number;
  registry: MetricRegistry;
  fetch?: Fetch;
  schedule?: Schedule;
  logger?: Logger;
  version?: string;
}): OtlpExporter {
  const queue: string[] = [];
  const send = opts.fetch ?? fetch;
  const schedule =
    opts.schedule ??
    ((run, ms) => {
      const timer = setInterval(run, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  let reporting = false;

  const exporter: OtlpExporter = {
    enqueue(trace) {
      try {
        const encoded = JSON.stringify(encodeTrace(trace, opts.version ?? "unknown"));
        if (queue.length >= opts.capacity) {
          opts.registry.add("omni_otlp_spans_dropped_total", { reason: "queue_full" });
          return;
        }
        queue.push(encoded);
      } catch {
        opts.registry.add("omni_otlp_spans_dropped_total", { reason: "encode" });
      }
    },
    async flush() {
      if (queue.length === 0) return;
      const encoded = queue.splice(0, opts.batchMax);
      try {
        const bodies = encoded.map((body) => JSON.parse(body) as { resourceSpans: unknown[] });
        const resourceSpans = bodies.flatMap((body) => body.resourceSpans);
        const response = await send(`${opts.endpoint.replace(/\/+$/, "")}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/json", ...opts.headers },
          body: JSON.stringify({ resourceSpans }),
        });
        if (!response.ok) throw new Error(`collector returned ${response.status}`);
        reporting = false;
      } catch {
        if (!reporting)
          opts.logger?.warn("trace export failed", { reason: "collector unavailable" });
        reporting = true;
      }
    },
    queued: () => queue.length,
    stop() {
      cancel();
    },
  };
  const cancel = schedule(() => void exporter.flush(), opts.intervalMs);
  return exporter;
}
