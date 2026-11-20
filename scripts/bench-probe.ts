/** One deadline covers connection, response headers and body consumption. */
export async function probeText(url: string, init: RequestInit, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: await response.text(),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function setupViaApi(
  base: string,
  password: string,
  credential: unknown,
  models: Record<string, unknown>,
  limits: unknown,
) {
  const call = async (path: string, body: unknown, cookie?: string, method = "POST") => {
    const res = await probeText(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${res.text}`);
    return { res, json: res.text.length === 0 ? null : JSON.parse(res.text) };
  };
  const { res } = await call("/api/setup", { password });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  await call("/api/credentials", credential, cookie);
  for (const [id, model] of Object.entries(models))
    await call(`/api/models/${id}`, model, cookie, "PUT");
  const plain = await call("/api/keys", { label: "bench plain" }, cookie);
  const limited = await call("/api/keys", { label: "bench limited", limits }, cookie);
  return { plain: plain.json.key as string, limited: limited.json.key as string };
}

export async function smoke(
  base: string,
  key: string,
  cases: [string, string][],
  timeoutMs = 10_000,
) {
  for (const [path, body] of cases) {
    const res = await probeText(
      `${base}${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body,
      },
      timeoutMs,
    );
    if (res.status !== 200 || !res.text.includes("lorem ipsum")) {
      throw new Error(`smoke ${path} failed: ${res.status} ${res.text.slice(0, 400)}`);
    }
  }
}

export type RecoverySample = { deadlineMs: number; elapsedMs: number; rssMb: number | null };
// Scheduling allowance, not an extension of the recovery target. Preserve
// actual elapsed time and refuse to classify observations beyond this window.
export const RECOVERY_LATENESS_MS = 25;
export async function sampleRecovery(
  origin: number,
  now: () => number,
  sleep: (ms: number) => Promise<unknown>,
  rss: () => number | null,
): Promise<RecoverySample[]> {
  const samples: RecoverySample[] = [];
  for (const deadlineMs of [5000, 10000]) {
    await sleep(Math.max(0, origin + deadlineMs - now()));
    const rssMb = rss();
    samples.push({ deadlineMs, elapsedMs: now() - origin, rssMb });
  }
  return samples;
}
export function recoveryVerdict(
  start: number | null,
  samples: RecoverySample[],
  crashed: number,
): "pass" | "miss" | "inconclusive" {
  if (crashed > 0) return "miss";
  const sample = samples.find((s) => s.deadlineMs === 10_000);
  if (
    start === null ||
    !Number.isFinite(start) ||
    !sample ||
    sample.rssMb === null ||
    !Number.isFinite(sample.rssMb) ||
    !Number.isFinite(sample.elapsedMs) ||
    sample.elapsedMs < 10_000 ||
    sample.elapsedMs > 10_000 + RECOVERY_LATENESS_MS
  )
    return "inconclusive";
  return sample.rssMb - start <= 20 ? "pass" : "miss";
}
