/**
 * The frozen TS coordinator, driven over JSON lines by `tests/compat.rs`.
 *
 * Runs `redisCoord` from `apps/gateway/src/coord/redis.ts` and the two
 * consumers whose Redis state outlives a restart — `createAdminAuth`
 * (sessions) and `createPendingFlows` (OAuth pending state) — against the
 * server the Rust coordinator uses, so every cross-runtime assertion is made
 * against the real TS code rather than a re-encoding of its formats.
 *
 * Request: `{"id": n, "op": "...", "args": [...]}`. Reply: `{"id": n, "ok":
 * true, "value": ...}` or `{"id": n, "ok": false, "error": "..."}`. A
 * subscription delivers `{"event": "message", "sub": n, "topic", "payload"}`.
 *
 * Nothing in the frozen tree is modified; this file only imports it.
 */
import { createAdminAuth } from "../../../../packages/control/src/adminAuth.ts";
import { createPendingFlows } from "../../../../packages/control/src/oauth/pending.ts";
import { memoryStore } from "../../../../packages/testkit/src/index.ts";
import { redisCoord } from "../../../../apps/gateway/src/coord/redis.ts";

const url = process.argv[2];
if (url === undefined) throw new Error("usage: agent.ts <redis-url>");

const coord = redisCoord({ url });
const store = await memoryStore();
const auth = createAdminAuth(store, { now: () => Date.now(), sessionTtlMs: 3_600_000, coord });
const flows = createPendingFlows({ now: () => Date.now(), ttlMs: 600_000, coord });

const holders = new Map<number, () => void>();
const subs = new Map<number, () => void>();

const write = (line: unknown): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

type Args = unknown[];
const s = (v: unknown): string => v as string;
const n = (v: unknown): number => v as number;

async function run(op: string, a: Args): Promise<unknown> {
  switch (op) {
    case "healthy":
      return coord.healthy();
    case "window.claim":
      return await coord.window.claim(s(a[0]), n(a[1]), n(a[2]));
    case "window.rollback":
      return await coord.window.rollback(s(a[0]), n(a[1]));
    case "gauge.acquire":
      return await coord.gauge.acquire(s(a[0]), n(a[1]), a[2] === null ? undefined : s(a[2]));
    case "gauge.renew":
      return await coord.gauge.renew(s(a[0]), s(a[1]), n(a[2]));
    case "gauge.release":
      return await coord.gauge.release(s(a[0]), a[1] === null ? undefined : s(a[1]));
    case "gauge.read":
      return await coord.gauge.read(s(a[0]));
    case "gauge.snapshot":
      return Object.fromEntries(await coord.gauge.snapshot(s(a[0])));
    case "buckets.add":
      return await coord.buckets.add(
        s(a[0]),
        n(a[1]),
        n(a[2]),
        n(a[3]),
        a[4] as { requests: number; tokens: number; costUsd: number },
      );
    case "buckets.sum":
      return await coord.buckets.sum(s(a[0]), n(a[1]), n(a[2]), n(a[3]));
    case "buckets.seed":
      return await coord.buckets.seed(
        s(a[0]),
        n(a[1]),
        n(a[2]),
        n(a[3]),
        a[4] as Array<[number, { requests: number; tokens: number; costUsd: number }]>,
      );
    case "lease.acquire":
      return await coord.lease.acquire(s(a[0]), s(a[1]), n(a[2]));
    case "lease.release":
      return await coord.lease.release(s(a[0]), s(a[1]));
    case "mutex.hold": {
      // Answers once the lock is held; the body waits for `mutex.release`.
      const handle = n(a[3]);
      let entered: () => void = () => {};
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const done = coord.mutex.withLock(s(a[0]), n(a[1]), n(a[2]), async () => {
        entered();
        await new Promise<void>((resolve) => holders.set(handle, resolve));
      });
      await Promise.race([inside, done]);
      return "held";
    }
    case "mutex.release": {
      const release = holders.get(n(a[0]));
      holders.delete(n(a[0]));
      release?.();
      // Let the lock's own release reach the server before answering.
      await Bun.sleep(20);
      return null;
    }
    case "pubsub.publish":
      return await coord.pubsub.publish(s(a[0]), s(a[1]));
    case "pubsub.publishSequenced":
      return await coord.pubsub.publishSequenced(s(a[0]), s(a[1]), s(a[2]));
    case "pubsub.subscribe": {
      const sub = n(a[1]);
      subs.set(
        sub,
        coord.pubsub.subscribe(s(a[0]), (topic, payload) =>
          write({ event: "message", sub, topic, payload }),
        ),
      );
      return null;
    }
    case "incr":
      return await coord.incr(s(a[0]));
    case "kv.set":
      return await coord.kv.set(s(a[0]), s(a[1]), n(a[2]));
    case "kv.get":
      return await coord.kv.get(s(a[0]));
    case "kv.del":
      return await coord.kv.del(s(a[0]));
    case "kv.delPrefix":
      return await coord.kv.delPrefix(s(a[0]));
    case "auth.setPassword":
      return await auth.setPassword(s(a[0]));
    case "auth.login":
      return await auth.login(s(a[0]));
    case "auth.verify":
      return await auth.verify(s(a[0]));
    case "auth.logout":
      return await auth.logout(s(a[0]));
    case "auth.invalidateSessions":
      return await auth.invalidateSessions();
    case "auth.invalidateKind":
      return await auth.invalidateKind(a[0] as "admin" | "viewer" | "client");
    case "flows.put":
      return await flows.put(a[0] as Parameters<typeof flows.put>[0]);
    case "flows.take":
      return await flows.take(s(a[0]));
    case "flows.peek":
      return await flows.peek(s(a[0]));
    case "close":
      coord.close();
      store.close();
      setTimeout(() => process.exit(0), 10);
      return null;
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  for (;;) {
    const nl = buffered.indexOf("\n");
    if (nl === -1) break;
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (line.trim() === "") continue;
    const req = JSON.parse(line) as { id: number; op: string; args: Args };
    // Not awaited: a held mutex must not block the next request.
    run(req.op, req.args).then(
      (value) => write({ id: req.id, ok: true, value: value ?? null }),
      (error: unknown) => write({ id: req.id, ok: false, error: String(error) }),
    );
  }
}
