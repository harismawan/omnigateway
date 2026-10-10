#!/usr/bin/env bun
/**
 * Measures the three body-artifact envelopes against one synthetic corpus:
 * `legacy` (`enc:v1:` hex, today's writer), `binary-raw` and `binary-auto`
 * (the `OGBA` envelope, without and with the gzip policy).
 *
 * Every mode seals the same `prepareArtifact` output — masking, bounding and the
 * omission budget run unchanged — so only the envelope differs. `binary-raw` is
 * forced through `sealBinaryArtifact`'s `compress` seam with a compressor that
 * returns its input: the saving is zero, under the policy's minimum, so the
 * production policy itself picks the raw codec. Production code has no other
 * way to ask for raw above the size cutoff.
 *
 * Synthetic only. The corpus is generated from fixed seeds, no provider is
 * called, and the field key is derived from a benchmark-only secret. Payload
 * bytes never reach the output, which is sizes, timings, and counts.
 *
 *   bun scripts/bench-body-artifacts.ts --mode legacy --iterations 1000 --concurrency 1
 *   bun scripts/bench-body-artifacts.ts --mode binary-auto --iterations 10000 --concurrency 16 --postgres
 *   bun scripts/bench-body-artifacts.ts --verify-restored
 *
 * Also: `--repeats` (default 5), `--warmup`, `--variants` (distinct inputs per
 * class), `--cohort all|representative`, `--gzip-level` (binary-auto only,
 * through the same seam), `--out <file>` for the JSON written to stdout.
 *
 * `--postgres` and `--verify-restored` read `OMNI_TEST_DATABASE_URL`, refuse a
 * non-loopback host, and never drop or truncate anything: `--postgres` refuses a
 * `request_bodies` table that already holds rows, and `--verify-restored` runs
 * on one read-only session. Run each mode in its own process and its own fresh
 * database. Results: docs/superpowers/plans/2026-10-10-body-artifact-storage-benchmark.md.
 */
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs, promisify } from "node:util";
import { gzip } from "node:zlib";
import { SQL } from "bun";
import {
  decodeArtifact,
  MAX_ARTIFACT_BYTES,
  prepareArtifact,
  relPathFor,
  sealArtifact,
  sealBinaryArtifact,
} from "../packages/store/src/bodies/artifact.ts";
import { deriveKey } from "../packages/store/src/encryption.ts";
import { openPg, type Rows } from "../packages/store/src/postgres/db.ts";
import type { BodyArtifact, BodyAttempt } from "../packages/store/src/types.ts";

// ---------------------------------------------------------------------------
// Arguments

const MODES = ["legacy", "binary-raw", "binary-auto"] as const;
type Mode = (typeof MODES)[number];

const { values: args } = parseArgs({
  options: {
    mode: { type: "string" },
    iterations: { type: "string", default: "1000" },
    concurrency: { type: "string", default: "1" },
    repeats: { type: "string", default: "5" },
    warmup: { type: "string", default: "200" },
    cohort: { type: "string", default: "all" },
    variants: { type: "string", default: "24" },
    postgres: { type: "boolean", default: false },
    "verify-restored": { type: "boolean", default: false },
    out: { type: "string" },
    "gzip-level": { type: "string" },
  },
  strict: true,
});

function positive(name: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

// ---------------------------------------------------------------------------
// Deterministic synthetic corpus

type Rng = () => number;

/** mulberry32: small, fast, and identical on every run for one seed. */
function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
/** Zipf-like: low indices dominate, the tail still appears. */
const zipf = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(xs.length * r() ** 3)] as T;
const hex = (r: Rng, n: number): string =>
  Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");
const bytesOf = (s: string): number => Buffer.byteLength(s);

function words(seed: number, size: number, syllables: readonly string[]): string[] {
  const r = rng(seed);
  return Array.from({ length: size }, () =>
    Array.from({ length: int(r, 1, 4) }, () => pick(r, syllables)).join(""),
  );
}

const FUNCTION_WORDS = ["the", "of", "and", "to", "in", "is", "that", "for", "it", "with", "as"];
const LATIN = words(
  11,
  4000,
  "ka ri to men sa lo ver an de po sti que ra ul bri on ex tal mi gor ne fa zu pel ci dro im va ho len ste ar".split(
    " ",
  ),
);
const CYRILLIC = words(
  12,
  1500,
  "ка ро сти не ла мо вер да по ну ски ли ть ра за об ен".split(" "),
);
const ARABIC = words(13, 1500, "ال م ن ب ت ك س ر ي و ح ق ل ع".split(" "));
const DEVANAGARI = words(14, 1500, "क र म न स त ल प ह द ग ा ि ी े".split(" "));
const EMOJI = ["\u{1F600}", "\u{1F680}", "\u{1F525}", "\u{2705}", "\u{1F914}", "\u{1F4A1}"];

/** Text whose UTF-8 length reaches `target`, built a sentence at a time. */
function grow(target: number, sentence: () => string): string {
  const parts: string[] = [];
  let size = 0;
  while (size < target) {
    const s = sentence();
    parts.push(s);
    size += bytesOf(s);
  }
  return parts.join("");
}

function prose(r: Rng, target: number): string {
  return grow(target, () => {
    const n = int(r, 6, 20);
    const ws = Array.from({ length: n }, () =>
      r() < 0.3 ? pick(r, FUNCTION_WORDS) : zipf(r, LATIN),
    );
    if (r() < 0.1) ws.push(`src/${zipf(r, LATIN)}/${zipf(r, LATIN)}.ts`);
    if (r() < 0.1) ws.push(String(int(r, 0, 99999)));
    const first = ws[0] ?? "";
    ws[0] = first.charAt(0).toUpperCase() + first.slice(1);
    return `${ws.join(" ")}${pick(r, [". ", ". ", "? ", ".\n\n"])}`;
  });
}

function code(r: Rng, target: number): string {
  const id = () => `${zipf(r, LATIN)}${zipf(r, LATIN).replace(/^./, (c) => c.toUpperCase())}`;
  const types = ["string", "number", "boolean", "Request", "Promise<void>", "Uint8Array"];
  return grow(target, () => {
    const indent = "  ".repeat(int(r, 0, 3));
    switch (int(r, 0, 5)) {
      case 0:
        return `${indent}const ${id()} = await ${id()}.${id()}(${id()}, ${int(r, 0, 4096)});\n`;
      case 1:
        return `${indent}if (${id()} === "${zipf(r, LATIN)}") {\n${indent}  return ${id()};\n${indent}}\n`;
      case 2:
        return `${indent}return { ${id()}: ${id()}, ${id()} };\n`;
      case 3:
        return `${indent}// ${prose(r, 40).trim()}\n`;
      case 4:
        return `export function ${id()}(${id()}: ${pick(r, types)}): ${pick(r, types)} {\n`;
      default:
        return `${indent}${id()}.push(${id()}[${int(r, 0, 64)}]);\n`;
    }
  });
}

function logs(r: Rng, target: number): string {
  const levels = ["INFO", "INFO", "INFO", "WARN", "DEBUG", "ERROR"];
  return grow(target, () => {
    const t = `2026-10-0${int(r, 1, 9)}T${String(int(r, 0, 23)).padStart(2, "0")}:${String(int(r, 0, 59)).padStart(2, "0")}:${String(int(r, 0, 59)).padStart(2, "0")}.${String(int(r, 0, 999)).padStart(3, "0")}Z`;
    // `req_<uuid>` is forty characters, which the masking length rule keeps.
    const req = `req_${hex(r, 8)}-${hex(r, 4)}-${hex(r, 4)}-${hex(r, 4)}-${hex(r, 12)}`;
    return `${t} ${pick(r, levels)} [${zipf(r, LATIN)}] ${prose(r, int(r, 20, 90)).trim()} path=/var/lib/${zipf(r, LATIN)}/${zipf(r, LATIN)}.db latency_ms=${int(r, 1, 9000)} ${req}\n`;
  });
}

function multilingual(r: Rng, target: number): string {
  return grow(target, () => {
    const n = int(r, 5, 18);
    switch (int(r, 0, 5)) {
      case 0: // CJK ideographs, Zipf over a common block
        return `${Array.from({ length: n * 2 }, () => String.fromCodePoint(0x4e00 + Math.floor(3000 * r() ** 2))).join("")}。`;
      case 1: // Japanese kana mixed with ideographs
        return `${Array.from({ length: n * 2 }, () => String.fromCodePoint(r() < 0.6 ? 0x3041 + int(r, 0, 82) : 0x4e00 + int(r, 0, 2000))).join("")}。`;
      case 2:
        return `${Array.from({ length: n }, () => zipf(r, CYRILLIC)).join(" ")}. `;
      case 3:
        return `${Array.from({ length: n }, () => zipf(r, ARABIC)).join(" ")}. `;
      case 4:
        return `${Array.from({ length: n }, () => zipf(r, DEVANAGARI)).join(" ")}। `;
      default:
        return `${prose(r, 60).trim()} ${pick(r, EMOJI)} `;
    }
  });
}

/**
 * Printable ASCII with no structure — the synthetic worst case for gzip that
 * masking leaves alone. Quote and backslash are excluded so JSON escaping does
 * not inflate it, and no run of the masking token class reaches forty-one
 * characters, so the length rule never fires: what is stored is what was made.
 */
function highEntropy(r: Rng, target: number): string {
  const out: string[] = [];
  let run = 0;
  for (let i = 0; i < target; i++) {
    let c = String.fromCharCode(int(r, 0x20, 0x7e));
    if (c === '"' || c === "\\") c = "~";
    run = /[A-Za-z0-9_-]/.test(c) ? run + 1 : 0;
    if (run > 32) {
      c = ".";
      run = 0;
    }
    out.push(c);
  }
  return out.join("");
}

function base64Bytes(r: Rng, n: number): string {
  return Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256))).toString("base64");
}

const CLASSES = [
  "tiny-empty",
  "short-chat",
  "tool-schema",
  "tool-result",
  "multilingual",
  "many-attempts",
  "sse-frames",
  "omission-marker",
  "near-cap-varied",
  "near-cap-repetitive",
  "high-entropy",
  "masked-base64",
] as const;
type FixtureClass = (typeof CLASSES)[number];

/**
 * The representative compressible cohort the auto-compression and PostgreSQL
 * thresholds are judged on, fixed before any measurement. Excluded: tiny and
 * omission artifacts (no savings required), the labelled synthetic best and
 * worst cases (`near-cap-repetitive`, `high-entropy`), and `masked-base64`,
 * whose stored form is shaped mostly by the sanitizer.
 */
const REPRESENTATIVE: readonly FixtureClass[] = [
  "short-chat",
  "tool-schema",
  "tool-result",
  "multilingual",
  "many-attempts",
  "sse-frames",
  "near-cap-varied",
];

const PROVIDERS = ["anthropic", "openai", "kimi", "grok", "antigravity"];
const MODEL = "claude-sonnet-4-5";

function attempt(
  n: number,
  provider: string,
  request: unknown,
  response: unknown,
  streamChunks: string[] | null = null,
): BodyAttempt {
  return { attempt: n, provider, request, response, streamChunks, truncated: false };
}

function reply(r: Rng, content: unknown[]): Record<string, unknown> {
  return {
    id: `msg_${hex(r, 24)}`,
    type: "message",
    role: "assistant",
    model: MODEL,
    content,
    stop_reason: "end_turn",
    usage: { input_tokens: int(r, 10, 200000), output_tokens: int(r, 1, 8000) },
  };
}

const textReply = (r: Rng, text: string) => reply(r, [{ type: "text", text }]);

function request(r: Rng, messages: unknown[], extra: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    max_tokens: pick(r, [1024, 4096, 8192, 32000]),
    system: prose(r, int(r, 40, 400)),
    messages,
    stream: false,
    ...extra,
  };
}

/** Client and the single attempt carry the same pair, as a passthrough does. */
function mirrored(request: unknown, response: unknown): Pick<BodyArtifact, "client" | "attempts"> {
  return {
    client: { request, response, truncated: false },
    attempts: [attempt(1, "anthropic", request, response)],
  };
}

/** Four large messages and a reply, sized by `scale` so the artifact fits the cap. */
function nearCap(r: Rng, scale: number, text: (r: Rng, n: number) => string) {
  const messages = Array.from({ length: 4 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: text(r, Math.floor(int(r, 52_000, 60_000) * scale)),
  }));
  return mirrored(request(r, messages), textReply(r, text(r, int(r, 4_000, 16_000))));
}

function mixedText(r: Rng, n: number): string {
  return pick(r, [prose, code, logs])(r, n);
}

function repetitiveText(r: Rng, n: number): string {
  const paragraph = prose(r, 2_000);
  return paragraph.repeat(Math.ceil(n / paragraph.length)).slice(0, n);
}

function body(
  cls: FixtureClass,
  r: Rng,
  scale: number,
): Pick<BodyArtifact, "client" | "attempts" | "error"> {
  switch (cls) {
    case "tiny-empty":
      return r() < 0.5
        ? { client: { request: null, response: null, truncated: false }, attempts: [], error: null }
        : { ...mirrored({}, {}), error: null };
    case "short-chat": {
      const req = request(r, [{ role: "user", content: prose(r, int(r, 80, 700)) }]);
      return { ...mirrored(req, textReply(r, prose(r, int(r, 150, 1600)))), error: null };
    }
    case "tool-schema": {
      const tools = Array.from({ length: int(r, 8, 40) }, () => {
        const props = Object.fromEntries(
          Array.from({ length: int(r, 2, 8) }, () => [
            zipf(r, LATIN),
            {
              type: pick(r, ["string", "integer", "boolean", "array"]),
              description: prose(r, int(r, 20, 120)).trim(),
              ...(r() < 0.2 ? { enum: [zipf(r, LATIN), zipf(r, LATIN), zipf(r, LATIN)] } : {}),
            },
          ]),
        );
        return {
          name: `${zipf(r, LATIN)}_${zipf(r, LATIN)}`,
          description: prose(r, int(r, 80, 400)).trim(),
          input_schema: {
            type: "object",
            properties: props,
            required: Object.keys(props).slice(0, 2),
          },
        };
      });
      const req = request(r, [{ role: "user", content: prose(r, int(r, 100, 800)) }], { tools });
      const res = reply(r, [
        { type: "text", text: prose(r, int(r, 40, 300)) },
        {
          type: "tool_use",
          id: `toolu_${hex(r, 24)}`,
          name: tools[0]?.name,
          input: { path: "src/a.ts" },
        },
      ]);
      return { ...mirrored(req, res), error: null };
    }
    case "tool-result": {
      const messages: unknown[] = [{ role: "user", content: prose(r, int(r, 100, 600)) }];
      for (let i = int(r, 2, 6); i > 0; i--) {
        const id = `toolu_${hex(r, 24)}`;
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id,
              name: "bash",
              input: { command: `cat src/${zipf(r, LATIN)}.ts` },
            },
          ],
        });
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: pick(r, [code, logs])(r, int(r, 2_000, 20_000)),
            },
          ],
        });
      }
      return {
        ...mirrored(request(r, messages), textReply(r, prose(r, int(r, 200, 3000)))),
        error: null,
      };
    }
    case "multilingual": {
      const messages = Array.from({ length: int(r, 2, 8) }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: multilingual(r, int(r, 300, 3000)),
      }));
      return {
        ...mirrored(request(r, messages), textReply(r, multilingual(r, int(r, 300, 3000)))),
        error: null,
      };
    }
    case "many-attempts": {
      const req = request(r, [{ role: "user", content: prose(r, int(r, 1_000, 6_000)) }]);
      const n = int(r, 3, 8);
      const failure = () => ({
        type: "error",
        error: {
          type: pick(r, ["rate_limit_error", "overloaded_error", "api_error"]),
          message: prose(r, int(r, 40, 300)).trim(),
        },
      });
      const succeeded = r() < 0.6;
      const attempts = Array.from({ length: n }, (_, i) =>
        attempt(
          i + 1,
          PROVIDERS[i % PROVIDERS.length] ?? "anthropic",
          req,
          i === n - 1 && succeeded ? textReply(r, prose(r, int(r, 200, 3000))) : failure(),
        ),
      );
      const last = attempts[n - 1]?.response ?? null;
      return {
        client: { request: req, response: last, truncated: false },
        attempts,
        error: succeeded ? null : { code: "UPSTREAM", message: prose(r, 120).trim(), attempts: n },
      };
    }
    case "sse-frames": {
      const req = {
        ...request(r, [{ role: "user", content: prose(r, int(r, 200, 2_000)) }]),
        stream: true,
      };
      const deltas = Array.from({ length: int(r, 30, 400) }, () => prose(r, int(r, 10, 400)));
      const frame = (type: string, data: unknown) =>
        `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      const chunks = [
        frame("message_start", { type: "message_start", message: reply(r, []) }),
        ...deltas.map((text) =>
          frame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          }),
        ),
        frame("message_stop", { type: "message_stop" }),
      ];
      const final = textReply(r, deltas.join(""));
      return {
        client: { request: req, response: final, truncated: false },
        attempts: [attempt(1, "anthropic", req, null, chunks)],
        error: null,
      };
    }
    case "omission-marker": {
      // Every string fits its own bound and the sum does not fit the artifact's.
      const big = prose(r, 60_000);
      const messages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: big,
      }));
      return { ...mirrored(request(r, messages), textReply(r, prose(r, 2_000))), error: null };
    }
    case "near-cap-varied":
      return { ...nearCap(r, scale, mixedText), error: null };
    case "near-cap-repetitive":
      return { ...nearCap(r, scale, repetitiveText), error: null };
    case "high-entropy":
      return { ...nearCap(r, scale, highEntropy), error: null };
    case "masked-base64": {
      const content = [
        { type: "text", text: prose(r, int(r, 100, 600)) },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: base64Bytes(r, int(r, 20_000, 48_000)),
          },
        },
      ];
      return {
        ...mirrored(request(r, [{ role: "user", content }]), textReply(r, prose(r, 400))),
        error: null,
      };
    }
  }
}

const BASE_AT = Date.UTC(2026, 9, 1, 0, 0, 0);
const NEAR_CAP: ReadonlySet<FixtureClass> = new Set([
  "near-cap-varied",
  "near-cap-repetitive",
  "high-entropy",
]);

const inputCache = new Map<string, BodyArtifact>();

/**
 * The pre-mask input for one class and variant, the same in every process.
 * Near-cap classes shrink in steps until the bounded artifact fits under the
 * budget, so they stay near the cap instead of tipping into an omission.
 */
function inputFor(cls: FixtureClass, variant: number): BodyArtifact {
  const cacheKey = `${cls}/${variant}`;
  const cached = inputCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const seed = (CLASSES.indexOf(cls) + 1) * 100_003 + variant;
  let built: BodyArtifact | undefined;
  for (let scale = 1; scale > 0.5; scale -= 0.05) {
    built = {
      schemaVersion: 1,
      requestId: `bench-${cls}-${variant}-0`,
      at: BASE_AT,
      ...body(cls, rng(seed), scale),
    };
    if (!NEAR_CAP.has(cls) || !prepareArtifact(built).json.includes('"omitted":true')) break;
  }
  if (built === undefined) throw new Error("unreachable");
  inputCache.set(cacheKey, built);
  return built;
}

const rowId = (cls: FixtureClass, variant: number, row: number): string =>
  `bench-${cls}-${variant}-${row}`;

// ---------------------------------------------------------------------------
// Envelopes

type Sealed = { bytes: Uint8Array; sha256: string };
type Sealer = (key: CryptoKey, json: string) => Promise<Sealed>;

/** Saves nothing, so the policy's own minimum-saving rule selects the raw codec. */
const keepRaw = async (plain: Uint8Array): Promise<Uint8Array> => plain;

/**
 * `--gzip-level` swaps only the compressor, through the same seam, so a level
 * other than the policy's can be measured under the policy's cutoff and
 * minimum saving. Absent, `binary-auto` is the production policy untouched.
 */
const GZIP_LEVEL = args["gzip-level"] === undefined ? undefined : Number(args["gzip-level"]);
const gzipAsync = promisify(gzip);

const SEALERS: Record<Mode, Sealer> = {
  legacy: (key, json) => sealArtifact(key, json),
  "binary-raw": (key, json) => sealBinaryArtifact(key, json, keepRaw),
  "binary-auto": (key, json) =>
    GZIP_LEVEL === undefined
      ? sealBinaryArtifact(key, json)
      : sealBinaryArtifact(key, json, (plain) => gzipAsync(plain, { level: GZIP_LEVEL })),
};

const OGBA = "OGBA";
function formatOf(bytes: Uint8Array): string {
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic === OGBA)
    return bytes[5] === 1 ? "binary-gzip" : bytes[5] === 0 ? "binary-raw" : "binary-unknown";
  return new TextDecoder().decode(bytes.subarray(0, 7)) === "enc:v1:" ? "legacy" : "unknown";
}

// ---------------------------------------------------------------------------
// Statistics

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN
  );
}

const round = (n: number, places = 3): number => Number(n.toFixed(places));

function summary(samples: readonly number[]) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    median: round(quantile(s, 0.5)),
    p95: round(quantile(s, 0.95)),
    max: round(s.at(-1) ?? Number.NaN),
  };
}

const MiB = 1024 * 1024;

/** Peak memory while a phase runs, sampled every 5 ms off the event loop's timer. */
function memorySampler() {
  const peak = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  const sample = () => {
    const m = process.memoryUsage();
    peak.rss = Math.max(peak.rss, m.rss);
    peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed);
    peak.external = Math.max(peak.external, m.external);
    peak.arrayBuffers = Math.max(peak.arrayBuffers, m.arrayBuffers);
  };
  const timer = setInterval(sample, 5);
  return () => {
    clearInterval(timer);
    sample();
    return {
      rssMiB: round(peak.rss / MiB, 1),
      heapUsedMiB: round(peak.heapUsed / MiB, 1),
      externalMiB: round(peak.external / MiB, 1),
      arrayBuffersMiB: round(peak.arrayBuffers / MiB, 1),
    };
  };
}

async function inParallel(
  n: number,
  concurrency: number,
  op: (i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < n) {
      const i = next++;
      await op(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
}

/** Wall time, process CPU (every thread, so native zlib work counts), and event-loop delay. */
async function phase(n: number, concurrency: number, op: (i: number) => Promise<void>) {
  const eld = monitorEventLoopDelay({ resolution: 1 });
  eld.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await inParallel(n, concurrency, op);
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  eld.disable();
  return {
    ops: n,
    wallMs: round(wallMs, 1),
    opsPerSec: round(n / (wallMs / 1000), 1),
    cpuMsPerOp: round((cpu.user + cpu.system) / 1000 / n),
    eventLoopDelayMs: {
      p50: round(eld.percentile(50) / 1e6),
      p95: round(eld.percentile(95) / 1e6),
      p99: round(eld.percentile(99) / 1e6),
      max: round(eld.max / 1e6),
    },
  };
}

// ---------------------------------------------------------------------------
// Runs

const SECRET = "omnigateway-body-artifact-benchmark-synthetic-secret";

function databaseUrl(): string {
  const url = process.env.OMNI_TEST_DATABASE_URL;
  if (url === undefined || url === "") throw new Error("OMNI_TEST_DATABASE_URL is required");
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error(
      "refusing a non-loopback database: this harness is for disposable servers only",
    );
  }
  return url;
}

type Prepared = {
  cls: FixtureClass;
  variant: number;
  json: string;
  plainBytes: number;
  preMaskBytes: number;
};

function corpus(classes: readonly FixtureClass[], variants: number): Prepared[] {
  const out: Prepared[] = [];
  for (let v = 0; v < variants; v++) {
    for (const cls of classes) {
      const input = inputFor(cls, v);
      const json = prepareArtifact(input).json;
      out.push({
        cls,
        variant: v,
        json,
        plainBytes: bytesOf(json),
        preMaskBytes: bytesOf(JSON.stringify(input)),
      });
    }
  }
  return out;
}

/**
 * Every fixture sealed in all three envelopes and decoded back, outside any
 * timing: the exact-size rules, auto never above raw, and round-trip equality.
 */
async function census(key: CryptoKey, fixtures: readonly Prepared[]) {
  const violations: string[] = [];
  const perClass = new Map<
    FixtureClass,
    {
      n: number;
      plain: number[];
      preMask: number;
      legacy: number;
      raw: number;
      auto: number;
      gzip: number;
      rawCut45: number;
      atLeast1KiB: number;
    }
  >();
  for (const f of fixtures) {
    const legacy = await SEALERS.legacy(key, f.json);
    const raw = await SEALERS["binary-raw"](key, f.json);
    const auto = await SEALERS["binary-auto"](key, f.json);
    const where = `${f.cls}/${f.variant}`;
    if (legacy.bytes.length !== 2 * f.plainBytes + 65)
      violations.push(`${where}: legacy is not 2N+65`);
    if (raw.bytes.length !== f.plainBytes + 38) violations.push(`${where}: raw is not N+38`);
    if (formatOf(raw.bytes) !== "binary-raw")
      violations.push(`${where}: forced raw used another codec`);
    if (auto.bytes.length > raw.bytes.length) violations.push(`${where}: auto larger than raw`);
    for (const sealed of [legacy, raw, auto]) {
      const read = await decodeArtifact(key, sealed.bytes, sealed.sha256);
      if (!read.ok || JSON.stringify(read.artifact) !== f.json)
        violations.push(`${where}: round trip failed`);
    }
    const c = perClass.get(f.cls) ?? {
      n: 0,
      plain: [],
      preMask: 0,
      legacy: 0,
      raw: 0,
      auto: 0,
      gzip: 0,
      rawCut45: 0,
      atLeast1KiB: 0,
    };
    c.n++;
    c.plain.push(f.plainBytes);
    c.preMask += f.preMaskBytes;
    c.legacy += legacy.bytes.length;
    c.raw += raw.bytes.length;
    c.auto += auto.bytes.length;
    if (formatOf(auto.bytes) === "binary-gzip") c.gzip++;
    if (f.plainBytes >= 1024) {
      c.atLeast1KiB++;
      if (1 - raw.bytes.length / legacy.bytes.length >= 0.45) c.rawCut45++;
    }
    perClass.set(f.cls, c);
  }
  const classes = Object.fromEntries(
    [...perClass].map(([cls, c]) => {
      const plain = [...c.plain].sort((a, b) => a - b);
      return [
        cls,
        {
          fixtures: c.n,
          plainBytes: {
            min: plain[0],
            median: quantile(plain, 0.5),
            max: plain.at(-1),
            sum: plain.reduce((a, b) => a + b, 0),
          },
          preMaskBytes: c.preMask,
          legacyBytes: c.legacy,
          rawBytes: c.raw,
          autoBytes: c.auto,
          gzipChosen: c.gzip,
          rawVsLegacy: round(1 - c.raw / c.legacy, 4),
          autoVsRaw: round(1 - c.auto / c.raw, 4),
          fixturesAtLeast1KiB: c.atLeast1KiB,
          rawCutAtLeast45: c.rawCut45,
        },
      ];
    }),
  );
  const sum = (field: "legacy" | "raw" | "auto", only: readonly FixtureClass[]) =>
    only.reduce((acc, cls) => acc + (perClass.get(cls)?.[field] ?? 0), 0);
  const rep = REPRESENTATIVE.filter((cls) => perClass.has(cls));
  return {
    fixtures: fixtures.length,
    violations,
    classes,
    representative: {
      classes: rep,
      legacyBytes: sum("legacy", rep),
      rawBytes: sum("raw", rep),
      autoBytes: sum("auto", rep),
      autoVsRaw: round(1 - sum("auto", rep) / sum("raw", rep), 4),
      autoVsLegacy: round(1 - sum("auto", rep) / sum("legacy", rep), 4),
    },
  };
}

async function memoryRun(
  key: CryptoKey,
  mode: Mode,
  fixtures: readonly Prepared[],
  opts: { iterations: number; concurrency: number; repeats: number; warmup: number },
) {
  const seal = SEALERS[mode];
  const sealTimes = new Map<FixtureClass, number[]>();
  const decodeTimes = new Map<FixtureClass, number[]>();
  const push = (m: Map<FixtureClass, number[]>, cls: FixtureClass, v: number) => {
    const list = m.get(cls) ?? [];
    list.push(v);
    m.set(cls, list);
  };
  const at = (i: number): Prepared => fixtures[i % fixtures.length] as Prepared;

  for (let i = 0; i < opts.warmup; i++) {
    const f = at(i);
    const sealed = await seal(key, f.json);
    await decodeArtifact(key, sealed.bytes, sealed.sha256);
  }

  const repeats = [];
  for (let rep = 0; rep < opts.repeats; rep++) {
    Bun.gc(true);
    const stopMemory = memorySampler();
    const sealed: Sealed[] = new Array(opts.iterations);
    const sealPhase = await phase(opts.iterations, opts.concurrency, async (i) => {
      const f = at(i);
      const t0 = performance.now();
      sealed[i] = await seal(key, f.json);
      push(sealTimes, f.cls, performance.now() - t0);
    });
    let failures = 0;
    const decodePhase = await phase(opts.iterations, opts.concurrency, async (i) => {
      const f = at(i);
      const s = sealed[i] as Sealed;
      const t0 = performance.now();
      const read = await decodeArtifact(key, s.bytes, s.sha256);
      push(decodeTimes, f.cls, performance.now() - t0);
      if (!read.ok) failures++;
    });
    const peak = stopMemory();
    sealed.length = 0;
    Bun.gc(true);
    repeats.push({
      seal: sealPhase,
      decode: decodePhase,
      decodeFailures: failures,
      peak,
      rssAfterGcMiB: round(process.memoryUsage().rss / MiB, 1),
    });
  }

  const byClass = (m: Map<FixtureClass, number[]>) =>
    Object.fromEntries([...m].map(([cls, xs]) => [cls, summary(xs)]));
  return {
    sealMs: byClass(sealTimes),
    decodeMs: byClass(decodeTimes),
    sealMsAll: summary([...sealTimes.values()].flat()),
    decodeMsAll: summary([...decodeTimes.values()].flat()),
    repeats,
  };
}

const INSERT = `INSERT INTO request_bodies
  (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated, bytes)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (request_id) DO UPDATE SET
    at = EXCLUDED.at, rel_path = EXCLUDED.rel_path, size_bytes = EXCLUDED.size_bytes,
    sha256 = EXCLUDED.sha256, detail_state = EXCLUDED.detail_state,
    truncated = EXCLUDED.truncated, bytes = EXCLUDED.bytes`;

/** One capture as `BodyRepo.put` performs it on Postgres, with the envelope under test. */
async function capture(
  sql: SQL,
  key: CryptoKey,
  seal: Sealer,
  cls: FixtureClass,
  variant: number,
  row: number,
): Promise<void> {
  const requestId = rowId(cls, variant, row);
  const at = BASE_AT + row * 1000;
  const prepared = prepareArtifact({ ...inputFor(cls, variant), requestId, at });
  const sealed = await seal(key, prepared.json);
  const truncated =
    prepared.artifact.client.truncated || prepared.artifact.attempts.some((a) => a.truncated);
  await sql.unsafe(INSERT, [
    requestId,
    at,
    relPathFor(requestId, at),
    sealed.bytes.length,
    sealed.sha256,
    "ready",
    truncated,
    sealed.bytes,
  ]);
}

async function scalar(sql: SQL, query: string): Promise<string> {
  const rows = await sql.unsafe<Rows<{ v: string | number }>>(query);
  return String(rows[0]?.v ?? "");
}

async function postgresRun(
  key: CryptoKey,
  mode: Mode,
  classes: readonly FixtureClass[],
  opts: { iterations: number; concurrency: number; repeats: number; variants: number },
) {
  const sql = await openPg(databaseUrl());
  try {
    if (Number(await scalar(sql, "SELECT count(*) AS v FROM request_bodies")) !== 0) {
      throw new Error(
        "request_bodies already holds rows: use a fresh disposable database per mode",
      );
    }
    const seal = SEALERS[mode];
    const row = (r: number) => ({
      cls: classes[r % classes.length] as FixtureClass,
      variant: Math.floor(r / classes.length) % opts.variants,
    });
    // Inputs generated before timing, so the batches time capture and not the generator.
    for (let r = 0; r < Math.min(opts.iterations, classes.length * opts.variants); r++)
      inputFor(row(r).cls, row(r).variant);

    const settings = Object.fromEntries(
      await Promise.all(
        [
          "server_version",
          "full_page_writes",
          "wal_compression",
          "synchronous_commit",
          "default_toast_compression",
          "max_wal_size",
          "checkpoint_timeout",
          "shared_buffers",
        ].map(async (name) => [name, await scalar(sql, `SELECT current_setting('${name}') AS v`)]),
      ),
    );
    const checkpoints = () =>
      scalar(sql, "SELECT checkpoints_timed + checkpoints_req AS v FROM pg_stat_bgwriter");
    await sql.unsafe("CHECKPOINT");
    const checkpointsBefore = Number(await checkpoints());

    const batches = [];
    const per = Math.floor(opts.iterations / opts.repeats);
    let done = 0;
    for (let b = 0; b < opts.repeats; b++) {
      const n = b === opts.repeats - 1 ? opts.iterations - done : per;
      const start = done;
      Bun.gc(true);
      const lsn0 = await scalar(sql, "SELECT pg_current_wal_insert_lsn() AS v");
      const stopMemory = memorySampler();
      const p = await phase(n, opts.concurrency, async (i) => {
        const { cls, variant } = row(start + i);
        await capture(sql, key, seal, cls, variant, start + i);
      });
      const peak = stopMemory();
      const wal = await scalar(
        sql,
        `SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '${lsn0}') AS v`,
      );
      batches.push({
        rows: n,
        ...p,
        walBytes: Number(wal),
        peak,
        rssAfterGcMiB: round(process.memoryUsage().rss / MiB, 1),
      });
      done += n;
    }
    const checkpointsDuring = Number(await checkpoints()) - checkpointsBefore;

    const size = (
      await sql.unsafe<Rows<Record<string, string | number>>>(
        `SELECT count(*) AS rows, sum(size_bytes) AS size_bytes, sum(octet_length(bytes)) AS octets,
           sum(pg_column_size(bytes)) AS column_bytes,
           pg_relation_size('request_bodies') AS heap_main,
           pg_table_size('request_bodies') AS table_size,
           pg_indexes_size('request_bodies') AS indexes_size,
           pg_total_relation_size('request_bodies') AS total_relation,
           (SELECT pg_total_relation_size(reltoastrelid) FROM pg_class WHERE oid = 'request_bodies'::regclass) AS toast_total
         FROM request_bodies`,
      )
    )[0];
    const perClass = await sql.unsafe<Rows<Record<string, string | number>>>(
      `SELECT regexp_replace(request_id, '^bench-(.*)-[0-9]+-[0-9]+$', '\\1') AS cls, count(*) AS rows,
         sum(octet_length(bytes)) AS octets, sum(pg_column_size(bytes)) AS column_bytes,
         sum(CASE WHEN pg_column_size(bytes) < octet_length(bytes) THEN 1 ELSE 0 END) AS toast_compressed
       FROM request_bodies GROUP BY 1 ORDER BY 1`,
    );

    // Separately: the cost of re-putting a tenth of the rows, as a retried capture does.
    const upserts = Math.max(1, Math.floor(opts.iterations / 10));
    const lsnU = await scalar(sql, "SELECT pg_current_wal_insert_lsn() AS v");
    const upsertPhase = await phase(upserts, opts.concurrency, async (i) => {
      const { cls, variant } = row(i);
      await capture(sql, key, seal, cls, variant, i);
    });
    const upsertWal = Number(
      await scalar(sql, `SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '${lsnU}') AS v`),
    );

    const toNumbers = (o: Record<string, string | number> | undefined) =>
      Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, k === "cls" ? v : Number(v)]));
    return {
      settings,
      checkpointsDuringInserts: checkpointsDuring,
      batches,
      totals: {
        rows: done,
        walBytes: batches.reduce((a, b) => a + b.walBytes, 0),
        wallMs: round(
          batches.reduce((a, b) => a + b.wallMs, 0),
          1,
        ),
      },
      size: toNumbers(size),
      perClass: perClass.map(toNumbers),
      upsert: { rows: upserts, ...upsertPhase, walBytes: upsertWal },
    };
  } finally {
    await sql.close();
  }
}

/** Decodes every restored row on a read-only session and checks it against its regenerated fixture. */
async function verifyRestored(key: CryptoKey) {
  const sql = new SQL({ url: databaseUrl(), max: 1 });
  const conn = await sql.reserve();
  try {
    await conn.unsafe("SET default_transaction_read_only = on");
    const readOnly = String(
      (
        await conn.unsafe<Rows<{ v: string }>>(
          "SELECT current_setting('transaction_read_only') AS v",
        )
      )[0]?.v,
    );
    if (readOnly !== "on") throw new Error("session is not read-only");
    const formats: Record<string, number> = {};
    const failures: string[] = [];
    let rows = 0;
    let after = "";
    for (;;) {
      const page = await conn.unsafe<
        Rows<{
          request_id: string;
          at: string;
          size_bytes: string;
          sha256: string | null;
          bytes: Uint8Array | null;
        }>
      >(
        "SELECT request_id, at, size_bytes, sha256, bytes FROM request_bodies WHERE request_id > $1 ORDER BY request_id LIMIT 100",
        [after],
      );
      if (page.length === 0) break;
      for (const r of page) {
        rows++;
        after = r.request_id;
        const match = /^bench-(.+)-(\d+)-(\d+)$/.exec(r.request_id);
        const cls = CLASSES.find((c) => c === match?.[1]);
        if (match === null || cls === undefined || r.bytes === null) {
          failures.push(`${r.request_id}: unrecognised row`);
          continue;
        }
        const bytes = new Uint8Array(r.bytes);
        const fmt = formatOf(bytes);
        formats[fmt] = (formats[fmt] ?? 0) + 1;
        const at = BASE_AT + Number(match[3]) * 1000;
        const expected = prepareArtifact({
          ...inputFor(cls, Number(match[2])),
          requestId: r.request_id,
          at,
        }).json;
        const read = await decodeArtifact(key, bytes, r.sha256);
        if (Number(r.at) !== at || Number(r.size_bytes) !== bytes.length)
          failures.push(`${r.request_id}: metadata`);
        else if (!read.ok) failures.push(`${r.request_id}: ${read.failure}`);
        else if (JSON.stringify(read.artifact) !== expected)
          failures.push(`${r.request_id}: content differs`);
      }
    }
    return { rows, formats, failures: failures.length, firstFailures: failures.slice(0, 10) };
  } finally {
    conn.release();
    await sql.close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = performance.now();
  const key = await deriveKey(SECRET);
  const kdfMs = round(performance.now() - t0, 1);
  const meta = {
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cpus: cpus().length,
    totalMemGiB: round(totalmem() / 1024 ** 3, 1),
    maxArtifactBytes: MAX_ARTIFACT_BYTES,
    kdfMsExcluded: kdfMs,
    zlib: process.versions.zlib,
    gzipLevel: GZIP_LEVEL ?? "policy",
  };

  let result: Record<string, unknown>;
  if (args["verify-restored"]) {
    result = { meta, verifyRestored: await verifyRestored(key) };
  } else {
    const mode = MODES.find((m) => m === args.mode);
    if (mode === undefined) throw new Error(`--mode must be one of ${MODES.join(", ")}`);
    const cohort =
      args.cohort === "representative" ? REPRESENTATIVE : args.cohort === "all" ? CLASSES : null;
    if (cohort === null) throw new Error("--cohort must be all or representative");
    const opts = {
      iterations: positive("iterations", args.iterations),
      concurrency: positive("concurrency", args.concurrency),
      repeats: positive("repeats", args.repeats),
      warmup: Number(args.warmup ?? 0),
      variants: positive("variants", args.variants),
    };
    if (opts.repeats < 5) process.stderr.write("warning: fewer than five repeats\n");
    const fixtures = corpus(cohort, opts.variants);
    Bun.gc(true);
    const baselineRssMiB = round(process.memoryUsage().rss / MiB, 1);
    result = {
      meta: { ...meta, mode, cohort: args.cohort, ...opts, baselineRssMiB },
      census: await census(key, fixtures),
      ...(args.postgres
        ? { postgres: await postgresRun(key, mode, cohort, opts) }
        : { memory: await memoryRun(key, mode, fixtures, opts) }),
    };
  }

  const text = JSON.stringify(result, null, 2);
  if (args.out !== undefined) writeFileSync(args.out, text);
  process.stdout.write(`${text}\n`);
  const verified = result.verifyRestored as { failures?: number } | undefined;
  const audit = result.census as { violations?: string[] } | undefined;
  if ((verified?.failures ?? 0) > 0 || (audit?.violations?.length ?? 0) > 0) process.exitCode = 1;
}

await main();
