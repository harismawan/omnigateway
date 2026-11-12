/**
 * The frozen TS `ApiKeyRateLimiter` over the frozen `redisCoord`, driven
 * over JSON lines by the Rust tests: the oracle every cluster-limit decision
 * is compared against, on the same Redis server.
 *
 * It also owns the one store both sides read (TS seeds and `oldestSince`
 * from it directly; the Rust limiter's `UsageSource` asks through
 * `usage.*`), so both judge the same rows.
 *
 * Request: `{"id": n, "op": "...", "args": [...]}`. Reply: `{"id": n, "ok":
 * true, "value": ...}` or `{"id": n, "ok": false, "error": "..."}`. Requests
 * are handled concurrently (a reply may overtake an earlier one).
 *
 * Nothing in the frozen tree is modified; this file only imports it.
 */
import { ApiKeyRateLimiter, type Admission } from "../../../../apps/gateway/src/auth/rateLimit.ts";
import { redisCoord } from "../../../../apps/gateway/src/coord/redis.ts";
import { memoryStore, requestLog, seedApiKey } from "../../../../packages/testkit/src/index.ts";

const url = process.argv[2];
if (url === undefined) throw new Error("usage: limiter.ts <redis-url>");

let clock = 0;
const now = (): number => clock;
const coord = redisCoord({ url, now });
type Store = Awaited<ReturnType<typeof memoryStore>>;
let store: Store = await memoryStore();
let limiter = new ApiKeyRateLimiter({ store, now, coord });
const held = new Map<number, Admission>();
let rows = 0;
/** Every row this agent appended (it is the store's only writer). */
let appended: Array<{ key: string; model: string; at: number }> = [];

const write = (line: unknown): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/** A round trip behind every command this process queued: they have run. */
const sync = async (): Promise<void> => {
  await coord.gauge.read("__sync__");
};

type Args = unknown[];
const s = (v: unknown): string => v as string;
const n = (v: unknown): number => v as number;

const refused = (e: unknown): unknown => {
  const err = e as { code?: string; retryAfterMs?: number; headroom?: unknown };
  if (err.code !== "RATE_LIMIT") throw e;
  return { refused: { retryAfterMs: err.retryAfterMs, headroom: err.headroom ?? {} } };
};

async function run(op: string, a: Args): Promise<unknown> {
  switch (op) {
    case "healthy":
      return coord.healthy();
    case "reset": {
      // A fresh store with key `a[0]`, and a fresh limiter (its limits map).
      store.close();
      store = await memoryStore();
      await seedApiKey(store, { id: s(a[0]) });
      limiter = new ApiKeyRateLimiter({ store, now, coord });
      held.clear();
      rows = 0;
      appended = [];
      return null;
    }
    case "clock":
      clock = n(a[0]);
      return null;
    case "row": {
      // [keyId, at, model, tokens, cost]
      appended.push({ key: s(a[0]), model: s(a[2]), at: n(a[1]) });
      await store.usage.append(
        requestLog({
          id: `r${rows++}`,
          apiKeyId: s(a[0]),
          requestedModel: s(a[2]),
          at: n(a[1]),
          inputTokens: n(a[3]),
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: n(a[4]),
        }),
      );
      return null;
    }
    case "admit": {
      // [handle, keyId, limits, model]
      try {
        const adm = await limiter.admit(s(a[1]), a[2] as never, s(a[3]));
        held.set(n(a[0]), adm);
        return { ok: adm.headroom };
      } catch (e) {
        return refused(e);
      }
    }
    case "consume": {
      try {
        await limiter.consume(s(a[0]), a[1] as never, s(a[2]));
        return { ok: {} };
      } catch (e) {
        return refused(e);
      }
    }
    case "release": {
      held.get(n(a[0]))?.release();
      held.delete(n(a[0]));
      await sync();
      return null;
    }
    case "debit": {
      // [keyId, model, tokens, cost]
      limiter.debit(s(a[0]), s(a[1]), { tokens: n(a[2]), costUsd: n(a[3]) });
      await sync();
      return null;
    }
    case "sync":
      await sync();
      return null;
    case "usage.sumBuckets": {
      const out = await store.usage.sumBuckets(
        s(a[0]),
        n(a[1]),
        n(a[2]),
        a[3] === null ? undefined : s(a[3]),
      );
      return out.map(([start, c]) => [start, c.requests, c.tokens, c.costUsd]);
    }
    case "usage.rowRanges": {
      // [keyId, sinceMs, grainMs, model|null]: per grain bucket of the row's
      // own `at`, the least and greatest `at` of done rows at or after since.
      const g = n(a[2]);
      const by = new Map<number, [number, number]>();
      for (const r of appended) {
        if (r.key !== s(a[0]) || r.at < n(a[1])) continue;
        if (a[3] !== null && r.model !== s(a[3])) continue;
        const b = Math.floor(r.at / g) * g;
        const was = by.get(b);
        by.set(b, was === undefined ? [r.at, r.at] : [Math.min(was[0], r.at), Math.max(was[1], r.at)]);
      }
      return [...by].map(([b, [lo, hi]]) => [b, lo, hi]);
    }
    case "usage.oldestSince":
      return await store.usage.oldestSince(s(a[0]), n(a[1]), a[2] === null ? undefined : s(a[2]));
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
    run(req.op, req.args).then(
      (value) => write({ id: req.id, ok: true, value: value ?? null }),
      (error: unknown) => write({ id: req.id, ok: false, error: String(error) }),
    );
  }
}
