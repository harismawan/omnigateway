import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  bodiesDirFor,
  decodeArtifact,
  gunzipArtifact,
  MAX_ARTIFACT_BYTES,
  prepareArtifact,
  readArtifact,
  relPathFor,
  sealArtifact,
  sealBinaryArtifact,
  sha256Hex,
  writeArtifact,
} from "../src/bodies/artifact.ts";
import {
  boundValue,
  DEPTH_MARKER,
  MAX_OBJECT_KEYS,
  MAX_STRING_BYTES,
} from "../src/bodies/bound.ts";
import { MASK_RULES, type MaskRule, type MaskRuleId, maskString } from "../src/bodies/mask.ts";
import { deriveKey, encrypt } from "../src/encryption.ts";
import { createBodyRepo } from "../src/sqlite/bodies.ts";
import { openDb } from "../src/sqlite/db.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { BodyArtifact, Store } from "../src/types.ts";

const encoder = new TextEncoder();

/**
 * A store on disk, because the artifact tree is derived from the database path
 * and an in-memory database has nowhere to put one.
 */
async function tempStore(): Promise<{ store: Store; root: string; dbPath: string; dir: string }> {
  const root = join(tmpdir(), `omni-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const dbPath = join(root, "omnigateway.db");
  const store = await createStore({
    path: dbPath,
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
  return { store, root, dbPath, dir: join(root, "request_bodies") };
}

async function cleanup(store: Store, root: string): Promise<void> {
  store.close();
  await rm(root, { recursive: true, force: true });
}

const AT = Date.UTC(2026, 7, 17, 12, 0, 0);

function artifact(overrides: Partial<BodyArtifact> = {}): BodyArtifact {
  return {
    schemaVersion: 1,
    requestId: "req_11111111-2222-4333-8444-555555555555",
    at: AT,
    client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
    attempts: [],
    error: null,
    ...overrides,
  };
}

/** Steps into a parsed artifact without pretending to know its shape. */
function child(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Masking: both halves of the surface, because the false-positive side is a
// deliberate cost and has to stay a measured one.
// ---------------------------------------------------------------------------

test("masking redacts credentials and long opaque tokens", () => {
  const secrets: Array<[string, string]> = [
    ["Authorization: Bearer abc123DEF456ghi789", "bearer token"],
    ["authorization: bearer sk-ant-oat01-XYZ", "lowercase bearer"],
    ["my key is sk-ant-api03-9fZq2LmT4vB8nR1xK", "sk- key"],
    ["ak-live-8827aabbccddeeff0011", "ak- key"],
    ["pk-test-8827aabbccddeeff0011", "pk- key"],
    ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256 digest"],
    ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAA", "base64"],
    // Exactly the base64url encoding of 256 bits, which is what this gateway's
    // own keys are made of once the prefix is stripped. The lower edge of the
    // length rule sits deliberately below it.
    ["7vQ2mXk9LpR4tZ0aB6cD8eF1gH3jK5nM7pQ9rS2tU4w", "bare 43-char token"],
  ];
  for (const [input, what] of secrets) {
    const masked = maskString(input);
    // Compared against the original, not against a literal: the point is that
    // nothing recognisable survived, whichever rule caught it.
    expect(`${what}: ${masked}`).toContain("[redacted]");
    expect(masked).not.toBe(input);
  }

  // The scheme and the vendor prefix survive, because which credential leaked is
  // what an operator acts on.
  expect(maskString("Bearer abc123DEF456ghi789")).toBe("Bearer [redacted]");
  expect(maskString("sk-ant-api03-9fZq2LmT4vB8nR1xK")).toBe("sk-[redacted]");

  // A JWT is caught segment by segment by the length rule rather than by a shape
  // of its own.
  const jwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImFiYzEyMyJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5cAAAAAAAAAAAAAAAA",
  ].join(".");
  expect(maskString(jwt)).toBe("[redacted].[redacted].[redacted]");
});

/**
 * The families the length rule provably cannot reach.
 *
 * Every string below was probed against the length rule first and survived it —
 * too short, or long enough but split into sub-threshold runs, or sitting at
 * exactly the forty characters `req_<uuid>` occupies and therefore unmaskable by
 * length at any threshold. Each keeps its prefix, because which vendor's
 * credential leaked is what an operator acts on.
 */
test("masking redacts vendor-prefixed credentials the length rule cannot reach", () => {
  const keys: Array<[string, string]> = [
    // Forty characters whole: one short of the threshold, and short by
    // construction rather than by accident.
    ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", "ghp_"],
    ["gho_16C7e42F292c6912E7710c838347Ae178B4a", "gho_"],
    ["ghs_16C7e42F292c6912E7710c838347Ae178B4a", "ghs_"],
    ["ghu_16C7e42F292c6912E7710c838347Ae178B4a", "ghu_"],
    ["github_pat_11ABCDEFG0aBcDeFgHiJkL_ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210zyxwvu", "github_pat_"],
    // Thirty-nine.
    ["AIzaSyD-9fZq2LmT4vB8nR1xKpW7uY0jH3gE6cAb", "AIza"],
    // Thirty-five.
    ["GOCSPX-9fZq2LmT4vB8nR1xKpW7uY0jH3g", "GOCSPX-"],
    ["xai-9fZq2LmT4vB8nR1xKpW7uY0jH3gE6cAbDdEeFfGg", "xai-"],
  ];
  for (const [secret, prefix] of keys) {
    expect(`${prefix}: ${maskString(secret)}`).toBe(`${prefix}: ${prefix}[redacted]`);
    // And in the middle of a sentence, which is how one actually arrives.
    expect(maskString(`token=${secret} failed`)).toBe(`token=${prefix}[redacted] failed`);
  }

  // Anthropic's is already covered by the `sk-` rule, and is asserted here so a
  // future duplicate rule for it is visibly redundant rather than harmless.
  expect(maskString("sk-ant-api03-9fZq2LmT4vB8nR1xK")).toBe("sk-[redacted]");
});

test("masking leaves the pinned non-secret strings intact", () => {
  const survivors = [
    "The request failed because the upstream provider returned a 529 overloaded error.",
    "/home/operator/.config/omnigateway/request_bodies/2026/08/17/req_abc.json.enc",
    "https://api.anthropic.com/v1/messages?beta=prompt-caching-2024-07-31",
    // A UUID is 36 characters, deliberately under the threshold: ids are how an
    // operator correlates an artifact with a log line.
    "550e8400-e29b-41d4-a716-446655440000",
    "req_550e8400-e29b-41d4-a716-446655440000",
    "2026-08-17T12:34:56.789Z",
    "claude-opus-4-1-20250805",
    "packages/store/src/bodies/artifact.ts:142:11",
    "export function createBodyRepo(db, key, dir) { return { put, get, prune }; }",
    "com.example.deeply.nested.package.name.ServiceImplementationFactory",
    "sk-",
    "Bearer",
    // The near misses of the vendor prefixes. A prefix rule is only cheap if it
    // does not fire on prose, so the words that begin like one are pinned too.
    "ghost_writer",
    "github_patterns are how the fine-grained tokens are described",
    "the AIza prefix identifies a Google API key",
    "GOCSPX-",
    "xai-",
    "highlight_matches(text)",
    // A prefix with fewer than the eight trailing characters every rule
    // requires. The bare prefixes above only pin zero, which a rule whose
    // minimum had slipped to one would still satisfy.
    "AIzaSyD",
    "ghp_1234567",
    "github_pat_1234",
    "GOCSPX-1234567",
    "xai-1234567",
    "sk-abcdefg",
    // A prefix part-way into a run of token characters, which is not where a
    // credential starts and is where the anchors keep every rule from firing.
    // `-` is the case that matters: it is both a token character and a word
    // boundary, so a `\b` fires after it and hands back everything to its left.
    "prefixAIzaSyD9fZq2Lm",
    "aaaaaaaaaa-AIzaSyD9fZq",
    "task-sk-abcdefghij",
    "omni-xai-abcdefghij",
    "proxai-abcdefghij",
    // xAI model aliases. `xai-` is the one prefix here that also names
    // something ordinary, and under a class that admitted `-` every one of
    // these was destroyed.
    "xai-grok-4-latest",
    "xai-grok-3-mini-beta",
    "xai-grok-code-fast-1",
  ];
  for (const value of survivors) {
    expect(maskString(value)).toBe(value);
  }
});

// ---------------------------------------------------------------------------
// Monotonicity: the property that makes it safe to add a rule to the chain.
//
// Every shape rule keeps its prefix in clear, so a rule that fires *inside* a
// run the length rule would have eaten whole gives back everything to the left
// of that prefix. That is not hypothetical — it is what a `\b` anchor did, and
// nothing in a suite of examples noticed, because each rule was only ever
// checked against inputs written for it.
// ---------------------------------------------------------------------------

/** The chain as it stood before the vendor rules were added to it. */
const BASELINE: readonly MaskRuleId[] = ["bearer", "prefixedKey", "opaque"];

/**
 * The literals a rule is allowed to hand back that an earlier chain had hidden.
 *
 * A shape rule keeps its prefix on purpose — which vendor's credential leaked is
 * what an operator acts on — and a prefix is a fixed string carrying no secret.
 * Anything else surrendered is secret material the older chain covered.
 */
const SURVIVING_PREFIXES = new Set([
  "sk-",
  "ak-",
  "pk-",
  "ghp_",
  "gho_",
  "ghs_",
  "ghu_",
  "github_pat_",
  "AIza",
  "GOCSPX-",
  "xai-",
]);

/**
 * Which characters of `input` a chain elides, and under which match.
 *
 * Positions rather than output text, because "redacts less" is a claim about the
 * input: two chains produce differently shaped output for the same coverage, and
 * comparing the outputs cannot tell a moved marker from a recovered secret.
 *
 * Each rule runs over the input with the previous rules' elisions replaced by
 * NUL. That is what makes the model faithful: NUL is one character wide, so
 * every match index is still an input index, and it sits outside every rule's
 * token class, so it breaks a run exactly the way `[redacted]` does.
 *
 * Positions carry a match number rather than a flag because two matches can end
 * up adjacent — a shape rule keeps a prefix, and the length rule then eats the
 * run ending at it — and the masker writes one marker per match. A flag map
 * cannot tell one elision from two touching ones.
 */
function elidedPositions(rules: readonly MaskRule[], input: string): number[] {
  const elided = new Array<number>(input.length).fill(0);
  let matches = 0;
  let working = input;
  for (const rule of rules) {
    // A fresh regex per pass: the shared ones carry `lastIndex`.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let next = working;
    for (const match of working.matchAll(pattern)) {
      const text = match[0];
      const start = match.index + rule.keep(text);
      const end = match.index + text.length;
      matches += 1;
      for (let i = start; i < end; i++) elided[i] = matches;
      next = `${next.slice(0, start)}${"\0".repeat(end - start)}${next.slice(end)}`;
    }
    working = next;
  }
  return elided;
}

/** Renders a position map the way the masker renders its matches. */
function render(input: string, elided: readonly number[]): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const match = elided[i] ?? 0;
    if (match === 0) {
      out += input[i];
      continue;
    }
    if (elided[i - 1] !== match) out += "[redacted]";
  }
  return out;
}

/** The runs `older` hid and `newer` does not, in the input's own text. */
function surrendered(input: string, older: readonly number[], newer: readonly number[]): string[] {
  const runs: string[] = [];
  let start = -1;
  for (let i = 0; i <= input.length; i++) {
    const lost = i < input.length && older[i] !== 0 && newer[i] === 0;
    if (lost && start < 0) start = i;
    if (!lost && start >= 0) {
      runs.push(input.slice(start, i));
      start = -1;
    }
  }
  return runs;
}

/**
 * Prefix, lead-in, and trailing shapes crossed with each other.
 *
 * The lead-ins are the point. A credential in a captured body arrives at the
 * start of a value, mid-sentence, and welded to whatever preceded it — and
 * base64url spells `-`, so a run of token characters that happens to contain
 * `-AIza` or `-xai-` is not a contrived input.
 */
function corpus(): string[] {
  const prefixes = [...SURVIVING_PREFIXES];
  const leads = ["", "-", "_", "x", "token=", "aaaaaaaaaa", "aaaaaaaaaa-", `${"A".repeat(40)}-`];
  const tails = [
    "",
    "1",
    "1234567",
    "12345678",
    "aBcDeFgH1234567890",
    "z".repeat(41),
    "z".repeat(80),
    "aB-cD-eF-gH-iJ-kL",
    "grok-4-latest",
  ];
  const inputs: string[] = [];
  for (const prefix of prefixes) {
    for (const lead of leads) {
      for (const tail of tails) inputs.push(`${lead}${prefix}${tail}`);
    }
  }
  return [
    ...inputs,
    // The three reproductions. Each is a run of token characters the length
    // rule alone elided whole, and each had its leading segment handed back.
    "aaaaaaaaaa-AIzaSyD9fZq2LmT4vB8nR1xKpW7uY0jH3gE6",
    "7vQ2mXk9LpR4-xai-tZ0aB6cD8eF1gH3jK5nM7pQ9rS2tU4w",
    "prefix1234-ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    // And the same shape through the rule that predates the vendor rules.
    "aaaaaaaaaa-sk-ant-api03-9fZq2LmT4vB8nR1xKpW7uY0jH3gE6cAb",
    "Bearer 7vQ2mXk9LpR4tZ0aB6cD8eF1gH3jK5nM7pQ9rS2tU4w",
    "the quick brown fox jumps over the lazy dog",
    "req_550e8400-e29b-41d4-a716-446655440000",
  ];
}

test("the position model of the masker agrees with the masker", () => {
  // Without this the property below could hold over a model that has drifted
  // from the code it claims to describe.
  for (const input of corpus()) {
    expect(`${input}: ${render(input, elidedPositions(MASK_RULES, input))}`).toBe(
      `${input}: ${maskString(input)}`,
    );
  }
});

test("masking never redacts less than the chain without its shape rules", () => {
  const baseline = MASK_RULES.filter((rule) => BASELINE.includes(rule.id));
  expect(baseline).toHaveLength(BASELINE.length);

  for (const input of corpus()) {
    const older = elidedPositions(baseline, input);
    const newer = elidedPositions(MASK_RULES, input);
    // Reported as the whole list so a failure names every run that came back,
    // not just the first.
    expect(`${input}: ${JSON.stringify(surrendered(input, older, newer))}`).toBe(
      `${input}: ${JSON.stringify(
        surrendered(input, older, newer).filter((run) => SURVIVING_PREFIXES.has(run)),
      )}`,
    );
  }
});

test("the reproductions that the vendor rules used to weaken are elided whole", () => {
  // Spelled out rather than left to the property, because the property is a
  // claim about a chain and these are the three strings that made it.
  expect(maskString("aaaaaaaaaa-AIzaSyD9fZq2LmT4vB8nR1xKpW7uY0jH3gE6")).toBe("[redacted]");
  expect(maskString("7vQ2mXk9LpR4-xai-tZ0aB6cD8eF1gH3jK5nM7pQ9rS2tU4w")).toBe("[redacted]");
  expect(maskString("prefix1234-ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toBe("[redacted]");
  expect(maskString("aaaaaaaaaa-sk-ant-api03-9fZq2LmT4vB8nR1xKpW7uY0jH3gE6cAb")).toBe("[redacted]");
});

test("masking traverses structure and leaves object keys alone", async () => {
  const { store, root, dir } = await tempStore();
  const secret = "sk-ant-api03-9fZq2LmT4vB8nR1xKpW";
  await store.bodies.put(
    artifact({
      client: {
        request: { messages: [{ role: "user", content: `here is ${secret} please check` }] },
        response: null,
        truncated: false,
      },
    }),
  );

  const read = await store.bodies.get("req_11111111-2222-4333-8444-555555555555");
  const rendered = JSON.stringify(read?.artifact);
  expect(rendered).not.toContain(secret);
  expect(rendered).toContain("sk-[redacted]");
  // The schema names the structure; rewriting a key would destroy the thing the
  // artifact exists to let someone read.
  expect(rendered).toContain('"messages"');
  expect(rendered).toContain('"role":"user"');

  // And nothing leaked past the repository into the file itself.
  const bytes = await readFile(
    join(dir, relPathFor("req_11111111-2222-4333-8444-555555555555", AT)),
  );
  expect(new TextDecoder().decode(bytes)).not.toContain(secret);
  await cleanup(store, root);
});

// ---------------------------------------------------------------------------
// Structural bounds. Asserted through `prepareArtifact` and its serialized form,
// so every case also proves the result is still parseable JSON — which is the
// whole reason bounding is structural rather than by byte offset.
// ---------------------------------------------------------------------------

function parsedFrom(input: BodyArtifact): { artifact: BodyArtifact; roundTripped: BodyArtifact } {
  const prepared = prepareArtifact(input);
  const roundTripped: unknown = JSON.parse(prepared.json);
  return { artifact: prepared.artifact, roundTripped: roundTripped as BodyArtifact };
}

test("a string past the byte budget is cut, marked, and still parses", () => {
  // Words rather than one run of a character, so masking's length rule does not
  // reach it first and this really is measuring the bound.
  const long = "the quick brown fox jumps over the lazy dog ".repeat(4000);
  expect(long.length).toBeGreaterThan(MAX_STRING_BYTES);

  const { artifact: prepared, roundTripped } = parsedFrom(
    artifact({ client: { request: { prompt: long }, response: null, truncated: false } }),
  );

  const value = (roundTripped.client.request as { prompt: string }).prompt;
  expect(encoder.encode(value).length).toBeLessThanOrEqual(MAX_STRING_BYTES);
  expect(value.endsWith("…[truncated]")).toBe(true);
  expect(value.startsWith("the quick brown fox")).toBe(true);
  expect(prepared.client.truncated).toBe(true);
});

test("an array past the item cap keeps its last items and still parses", () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({ turn: i }));
  const { artifact: prepared, roundTripped } = parsedFrom(
    artifact({ client: { request: { messages }, response: null, truncated: false } }),
  );

  const kept = (roundTripped.client.request as { messages: Array<{ turn: number }> }).messages;
  expect(kept).toHaveLength(24);
  // The *last* items, because the recent turns are what an incident is about.
  expect(kept[0]?.turn).toBe(36);
  expect(kept.at(-1)?.turn).toBe(59);
  expect(prepared.client.truncated).toBe(true);
});

test("nesting past the depth limit is replaced by a marker and still parses", () => {
  // Root is depth 1, so `l6` sits at depth 6 and survives while the object it
  // holds sits at depth 7 and does not.
  const deep = { l2: { l3: { l4: { l5: { l6: { l7: { leaf: "gone" } } } } } } };
  const { artifact: prepared, roundTripped } = parsedFrom(
    artifact({ client: { request: deep, response: null, truncated: false } }),
  );

  const l6 = ["l2", "l3", "l4", "l5", "l6"].reduce(child, roundTripped.client.request);
  expect(child(l6, "l7")).toBe(DEPTH_MARKER);
  // The level above it is intact, so this cut where it said it would.
  expect(l6).toEqual({ l7: DEPTH_MARKER });
  expect(prepared.client.truncated).toBe(true);
});

test("an object past the key cap keeps its first keys and still parses", () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < 200; i++) wide[`k${String(i).padStart(3, "0")}`] = i;

  const { artifact: prepared, roundTripped } = parsedFrom(
    artifact({ client: { request: wide, response: null, truncated: false } }),
  );

  const kept = roundTripped.client.request as Record<string, number>;
  expect(Object.keys(kept)).toHaveLength(MAX_OBJECT_KEYS);
  expect(kept.k000).toBe(0);
  expect(kept.k079).toBe(79);
  expect(kept.k080).toBeUndefined();
  expect(prepared.client.truncated).toBe(true);
});

test("bounding leaves a payload inside every limit untouched", () => {
  const payload = { messages: [{ role: "user", content: "hello" }], temperature: 0.5 };
  const bounded = boundValue(payload);
  expect(bounded.truncated).toBe(false);
  expect(bounded.value).toEqual(payload);
});

test("a truncation the caller knows about survives a payload that needs no bounding", () => {
  // The capture layer is the only thing that can see a client hanging up
  // mid-stream, a drain ending on a source error, or a response past the byte
  // cap. None of those leave a structural trace, so a `truncated` derived from
  // the value alone reports every one of them as a complete body. Both payloads
  // here are small and well-formed on purpose: bounding has nothing to say, and
  // the flag can only come from the caller.
  const prepared = prepareArtifact(
    artifact({
      client: { request: { model: "fast" }, response: { partial: true }, truncated: true },
      attempts: [
        {
          attempt: 1,
          provider: "anthropic",
          request: { model: "fast" },
          response: { partial: true },
          streamChunks: null,
          truncated: true,
        },
      ],
    }),
  );

  expect(prepared.artifact.client.truncated).toBe(true);
  expect(prepared.artifact.attempts[0]?.truncated).toBe(true);
  // And it is not simply always true: the same shapes without the flag are clean.
  const clean = prepareArtifact(
    artifact({ client: { request: { model: "fast" }, response: { ok: true }, truncated: false } }),
  );
  expect(clean.artifact.client.truncated).toBe(false);
});

test("an artifact still oversized after bounding is written with an omission marker", () => {
  // Eighty keys of prose, each well inside the string budget: every structural
  // limit is respected and the total is still megabytes.
  const wide: Record<string, string> = {};
  for (let i = 0; i < 80; i++) wide[`k${i}`] = "lorem ipsum dolor sit amet ".repeat(400);

  const prepared = prepareArtifact(
    artifact({
      client: { request: wide, response: wide, truncated: false },
      attempts: [
        {
          attempt: 1,
          provider: "anthropic",
          request: wide,
          response: wide,
          streamChunks: null,
          truncated: false,
        },
      ],
    }),
  );

  expect(encoder.encode(prepared.json).length).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
  const marker = prepared.artifact.client.request as { omitted: boolean; serializedBytes: number };
  expect(marker.omitted).toBe(true);
  expect(marker.serializedBytes).toBeGreaterThan(MAX_ARTIFACT_BYTES);
  // The story survives even though the payloads do not.
  expect(prepared.artifact.attempts[0]?.provider).toBe("anthropic");
  expect(prepared.artifact.attempts[0]?.truncated).toBe(true);
  expect(JSON.parse(prepared.json)).toEqual(prepared.artifact);
});

// ---------------------------------------------------------------------------
// The repository: encryption at rest, sharding, and the states a reader has to
// survive.
// ---------------------------------------------------------------------------

test("an artifact round-trips through the repository and shards by UTC date", async () => {
  const { store, root, dir } = await tempStore();
  const input = artifact({
    attempts: [
      {
        attempt: 1,
        provider: "anthropic",
        request: { model: "claude-opus-4-1-20250805" },
        response: { stop_reason: "end_turn" },
        streamChunks: ["event: message_start", "event: message_stop"],
        truncated: false,
      },
    ],
  });
  const row = await store.bodies.put(input);

  expect(row.detailState).toBe("ready");
  expect(row.truncated).toBe(false);
  expect(row.relPath).toBe(`2026/08/17/${input.requestId}.json.enc`);
  expect(await exists(join(dir, row.relPath ?? ""))).toBe(true);

  const read = await store.bodies.get(input.requestId);
  expect(read?.row.detailState).toBe("ready");
  expect(read?.artifact?.schemaVersion).toBe(1);
  expect(read?.artifact?.attempts[0]?.provider).toBe("anthropic");
  expect(read?.artifact?.attempts[0]?.streamChunks).toEqual([
    "event: message_start",
    "event: message_stop",
  ]);
  expect(read?.artifact?.client.request).toEqual({ model: "fast" });
  await cleanup(store, root);
});

test("stored artifact bytes never contain the plaintext they hold", async () => {
  const { store, root, dir } = await tempStore();
  // Short enough that no masking rule touches it, so its absence on disk can
  // only be encryption.
  const marker = "CANARY-MARKER-DO-NOT-LEAK";
  const input = artifact({
    client: { request: { prompt: marker }, response: { text: marker }, truncated: false },
  });
  const row = await store.bodies.put(input);

  const bytes = await readFile(join(dir, row.relPath ?? ""));
  expect(new TextDecoder().decode(bytes)).not.toContain(marker);
  expect(new TextDecoder().decode(bytes).startsWith("enc:v1:")).toBe(true);
  expect(row.sizeBytes).toBe(bytes.length);

  // And it is genuinely still there behind the key, so this is encryption rather
  // than the marker never having been written.
  const read = await store.bodies.get(input.requestId);
  expect(child(read?.artifact?.client.request, "prompt")).toBe(marker);
  await cleanup(store, root);
});

test("a request id that could escape its shard directory is rejected", async () => {
  const { store, root, dir } = await tempStore();
  for (const hostile of ["../../etc/passwd", "a/b", "req .json", "", "..", "req\0x"]) {
    await expect(store.bodies.put(artifact({ requestId: hostile }))).rejects.toThrow(
      /not safe to use as an artifact path segment/,
    );
  }
  // Nothing was written anywhere: no tree, and no row claiming there is one.
  expect(await exists(dir)).toBe(false);
  expect(await store.bodies.get("../../etc/passwd")).toBeNull();
  await cleanup(store, root);
});

test("an artifact deleted underneath its row reads as missing, not as an error", async () => {
  const { store, root, dir, dbPath } = await tempStore();
  const input = artifact();
  const row = await store.bodies.put(input);
  await rm(join(dir, row.relPath ?? ""));

  const read = await store.bodies.get(input.requestId);
  expect(read?.row.detailState).toBe("missing");
  expect(read?.artifact).toBeNull();
  // The metadata still comes back, which is what the admin route renders.
  expect(read?.row.sizeBytes).toBe(row.sizeBytes);

  // The observation was recorded, so a later reader does not have to rediscover it.
  const db = openDb(dbPath);
  const stored = db
    .query<{ detail_state: string }, [string]>(
      "SELECT detail_state FROM request_bodies WHERE request_id = ?",
    )
    .get(input.requestId);
  expect(stored?.detail_state).toBe("missing");
  db.close();
  await cleanup(store, root);
});

test("an artifact that fails its digest or its decryption reads as corrupt", async () => {
  const { store, root, dir, dbPath } = await tempStore();
  const rottedRow = await store.bodies.put(artifact({ requestId: "req_rotted" }));
  const swappedRow = await store.bodies.put(artifact({ requestId: "req_swapped" }));
  const otherRow = await store.bodies.put(
    artifact({
      requestId: "req_other",
      client: {
        request: { prompt: "someone else's conversation" },
        response: null,
        truncated: false,
      },
    }),
  );

  // Bit-rot: the bytes changed and the recorded digest no longer matches, which
  // is detectable without holding the key at all.
  await writeFile(join(dir, rottedRow.relPath ?? ""), "enc:v1:00:00:00");

  // A swap: perfectly valid ciphertext under this very key, but not the
  // ciphertext this row was written for. Only the digest can tell, and without
  // it the reader would hand back another request's conversation as this one's.
  await writeFile(
    join(dir, swappedRow.relPath ?? ""),
    await readFile(join(dir, otherRow.relPath ?? "")),
  );

  for (const id of ["req_rotted", "req_swapped"]) {
    const read = await store.bodies.get(id);
    expect(`${id}: ${read?.row.detailState}`).toBe(`${id}: corrupt`);
    expect(read?.artifact).toBeNull();
  }
  // Nothing of the other request's payload came back under this id.
  expect(JSON.stringify(await store.bodies.get("req_swapped"))).not.toContain("someone else");

  // Both observations were written back to their rows.
  const db = openDb(dbPath);
  const states = db
    .query<{ request_id: string; detail_state: string }, []>(
      "SELECT request_id, detail_state FROM request_bodies ORDER BY request_id",
    )
    .all();
  expect(states).toEqual([
    { request_id: "req_other", detail_state: "ready" },
    { request_id: "req_rotted", detail_state: "corrupt" },
    { request_id: "req_swapped", detail_state: "corrupt" },
  ]);
  db.close();
  await cleanup(store, root);
});

test("get returns null for a request that was never captured", async () => {
  const { store, root } = await tempStore();
  expect(await store.bodies.get("req_never")).toBeNull();
  await cleanup(store, root);
});

// ---------------------------------------------------------------------------
// Legacy envelope compatibility. Every fixture below is emitted by the credential
// helper (`encrypt` plus `TextEncoder`), never by the artifact writer, so a later
// change to how artifacts are sealed cannot quietly redefine what "legacy" means.
// ---------------------------------------------------------------------------

const LEGACY_SECRET = "test-secret-value-for-unit-tests";
const legacyKey = deriveKey(LEGACY_SECRET);
const decoder = new TextDecoder();

const LEGACY_INPUT = artifact({
  attempts: [
    {
      attempt: 1,
      provider: "anthropic",
      request: { model: "claude-opus-4-1-20250805" },
      response: { stop_reason: "end_turn" },
      streamChunks: ["event: message_start", "event: message_stop"],
      truncated: false,
    },
  ],
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The unchanged legacy seal: credential helper, then UTF-8 of its text. */
async function legacySeal(json: string, key?: CryptoKey): Promise<Uint8Array> {
  return encoder.encode(await encrypt(key ?? (await legacyKey), json));
}

/** Splits a legacy envelope into the five components `decrypt` expects. */
function legacyParts(bytes: Uint8Array): { iv: string; body: string; tag: string } {
  const [, , iv = "", body = "", tag = ""] = decoder.decode(bytes).split(":");
  return { iv, body, tag };
}

function legacyText(parts: { iv: string; body: string; tag: string }): Uint8Array {
  return encoder.encode(`enc:v1:${parts.iv}:${parts.body}:${parts.tag}`);
}

/** AES-GCM sealed independently of `encrypt`, so IV and tag lengths are ours to choose. */
async function sealWith(
  json: string,
  ivBytes: number,
  tagBits: number,
): Promise<{ iv: string; body: string; tag: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: tagBits },
      await legacyKey,
      encoder.encode(json),
    ),
  );
  const split = sealed.length - tagBits / 8;
  return {
    iv: toHex(iv),
    body: toHex(sealed.subarray(0, split)),
    tag: toHex(sealed.subarray(split)),
  };
}

test("a legacy envelope from the unchanged helper decodes to the prepared artifact", async () => {
  const prepared = prepareArtifact(LEGACY_INPUT);
  const bytes = await legacySeal(prepared.json);
  expect(decoder.decode(bytes).startsWith("enc:v1:")).toBe(true);

  const digest = await sha256Hex(bytes);
  for (const expected of [digest, null]) {
    const read = await decodeArtifact(await legacyKey, bytes, expected);
    expect(`${expected === null ? "null" : "digest"}: ${read.ok}`).toBe(
      `${expected === null ? "null" : "digest"}: true`,
    );
    if (read.ok) expect(read.artifact).toEqual(prepared.artifact);
  }
});

test("a legacy envelope under the wrong key, or a wrong digest, is corrupt", async () => {
  const bytes = await legacySeal(prepareArtifact(LEGACY_INPUT).json);
  const digest = await sha256Hex(bytes);
  const otherKey = await deriveKey("another-secret-value-for-unit-tests");

  expect(await decodeArtifact(otherKey, bytes, digest)).toEqual({ ok: false, failure: "corrupt" });
  // A null digest leaves GCM as the only boundary, and it must hold alone.
  expect(await decodeArtifact(otherKey, bytes, null)).toEqual({ ok: false, failure: "corrupt" });
  expect(await decodeArtifact(await legacyKey, bytes, "0".repeat(64))).toEqual({
    ok: false,
    failure: "corrupt",
  });
});

test("malformed legacy envelopes are corrupt rather than thrown, digest or no digest", async () => {
  const valid = await legacySeal(prepareArtifact(LEGACY_INPUT).json);
  const { iv, body, tag } = legacyParts(valid);
  expect(body.toUpperCase()).not.toBe(body);
  const validText = decoder.decode(valid);

  const cases: Array<[string, Uint8Array]> = [
    ["extra component", encoder.encode(`${validText}:00`)],
    ["extra empty component", encoder.encode(`${validText}:`)],
    ["missing tag component", encoder.encode(`enc:v1:${iv}:${body}`)],
    ["trailing newline", encoder.encode(`${validText}\n`)],
    ["unknown version", encoder.encode(validText.replace("enc:v1:", "enc:v2:"))],
    ["wrong scheme", encoder.encode(validText.replace("enc:v1:", "ENC:v1:"))],
    ["odd-length body hex", legacyText({ iv, body: `${body}0`, tag })],
    ["odd-length iv hex", legacyText({ iv: `${iv}0`, body, tag })],
    ["odd-length tag hex", legacyText({ iv, body, tag: `${tag}0` })],
    ["uppercase hex", legacyText({ iv, body: body.toUpperCase(), tag })],
    ["non-hex character", legacyText({ iv, body: `g${body.slice(1)}`, tag })],
    ["empty iv", legacyText({ iv: "", body, tag })],
    ["empty tag", legacyText({ iv, body, tag: "" })],
    ["empty body", legacyText({ iv, body: "", tag })],
    ["short iv", legacyText({ iv: iv.slice(0, -2), body, tag })],
    ["long iv", legacyText({ iv: `${iv}00`, body, tag })],
    ["short tag", legacyText({ iv, body, tag: tag.slice(0, -2) })],
    ["long tag", legacyText({ iv, body, tag: `${tag}00` })],
    // Valid GCM under its own parameters, so only the fixed lengths reject them.
    [
      "authenticating 16-byte iv",
      legacyText(await sealWith(prepareArtifact(LEGACY_INPUT).json, 16, 128)),
    ],
    [
      "authenticating 8-byte iv",
      legacyText(await sealWith(prepareArtifact(LEGACY_INPUT).json, 8, 128)),
    ],
    [
      "authenticating 12-byte tag",
      legacyText(await sealWith(prepareArtifact(LEGACY_INPUT).json, 12, 96)),
    ],
    ["not an envelope at all", encoder.encode("hello")],
    ["empty input", new Uint8Array(0)],
    ["non-UTF-8 bytes", new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28])],
  ];

  const key = await legacyKey;
  for (const [name, bytes] of cases) {
    expect(`${name}: ${JSON.stringify(await decodeArtifact(key, bytes, null))}`).toBe(
      `${name}: ${JSON.stringify({ ok: false, failure: "corrupt" })}`,
    );
    // Again with the digest of exactly these bytes, so the digest cannot be what
    // rejected them.
    const digest = await sha256Hex(bytes);
    expect(`${name}: ${JSON.stringify(await decodeArtifact(key, bytes, digest))}`).toBe(
      `${name}: ${JSON.stringify({ ok: false, failure: "corrupt" })}`,
    );
  }
});

test("a legacy envelope that authenticates but is not a JSON object is corrupt", async () => {
  const key = await legacyKey;
  for (const plaintext of ["not json {", "", "[]", "null", "42", '"text"', "true", '{"a":']) {
    const bytes = await legacySeal(plaintext);
    const read = await decodeArtifact(key, bytes, await sha256Hex(bytes));
    expect(`${JSON.stringify(plaintext)}: ${JSON.stringify(read)}`).toBe(
      `${JSON.stringify(plaintext)}: ${JSON.stringify({ ok: false, failure: "corrupt" })}`,
    );
  }
});

test("a legacy file from the unchanged helper reads as ready through the repository", async () => {
  const root = join(tmpdir(), `omni-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const dbPath = join(root, "omnigateway.db");
  const dir = bodiesDirFor(dbPath);
  const db = openDb(dbPath);
  const repo = createBodyRepo(db, await legacyKey, dir);

  const prepared = prepareArtifact(LEGACY_INPUT);
  const bytes = await legacySeal(prepared.json);
  const relPath = relPathFor(LEGACY_INPUT.requestId, LEGACY_INPUT.at);
  await writeArtifact(dir, relPath, bytes);
  db.run(
    `INSERT INTO request_bodies (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated)
     VALUES (?,?,?,?,?,?,?)`,
    [
      LEGACY_INPUT.requestId,
      LEGACY_INPUT.at,
      relPath,
      bytes.length,
      await sha256Hex(bytes),
      "ready",
      0,
    ],
  );

  const read = await repo.get(LEGACY_INPUT.requestId);
  expect(read?.row.detailState).toBe("ready");
  expect(read?.artifact).toEqual(prepared.artifact);

  db.close();
  await rm(root, { recursive: true, force: true });
});

/**
 * An authenticated legacy frame past 2 * MAX_ARTIFACT_BYTES + 65 stored bytes.
 *
 * `prepareArtifact`'s last fallback keeps every attempt's frame and never
 * rechecks the remaining size, so a many-attempt artifact built through the
 * store API (the gateway caps dispatch at ten attempts) comes out larger than
 * the budget it is meant to honour. Built once per file: it is megabytes of
 * encrypted hex.
 */
const oversizedLegacy = (async () => {
  const attempts = Array.from({ length: 6000 }, (_, i) => ({
    attempt: i + 1,
    provider: "anthropic",
    request: { model: "fast" },
    response: { ok: true },
    streamChunks: null,
    truncated: false,
  }));
  const prepared = prepareArtifact(
    artifact({
      client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
      attempts,
    }),
  );
  const bytes = await legacySeal(prepared.json);
  return { prepared, bytes, digest: await sha256Hex(bytes) };
})();

test("an oversized but authenticated legacy frame is a real fixture past the proposed ceiling", async () => {
  const { prepared, bytes } = await oversizedLegacy;
  // Pins the premise: the unchanged preparer really does emit past the budget,
  // and the legacy envelope really is exactly 2N + 65 bytes.
  expect(Buffer.byteLength(prepared.json)).toBeGreaterThan(MAX_ARTIFACT_BYTES);
  expect(bytes.length).toBe(2 * Buffer.byteLength(prepared.json) + 65);
  expect(bytes.length).toBeGreaterThan(2 * MAX_ARTIFACT_BYTES + 65);
});

/** The read ceiling every envelope answers to, restated rather than imported. */
const GLOBAL_CEILING = 2 * MAX_ARTIFACT_BYTES + 65;
/** Header, IV, and tag around at most one artifact budget of ciphertext. */
const BINARY_CEILING = MAX_ARTIFACT_BYTES + 38;
const CORRUPT = JSON.stringify({ ok: false, failure: "corrupt" });

/**
 * Decodes with crypto watched, so a rejection can be shown to have happened on
 * the shape alone: no digest computed and nothing decrypted. Digests the caller
 * wants to supply must be computed before this is called.
 */
async function decodeUnwatched(
  bytes: Uint8Array,
  expected: string | null,
): Promise<{ read: string; digests: number; decrypts: number }> {
  const key = await legacyKey;
  const digest = spyOn(crypto.subtle, "digest");
  const decrypt = spyOn(crypto.subtle, "decrypt");
  try {
    const read = JSON.stringify(await decodeArtifact(key, bytes, expected));
    return { read, digests: digest.mock.calls.length, decrypts: decrypt.mock.calls.length };
  } finally {
    digest.mockRestore();
    decrypt.mockRestore();
  }
}

/** A JSON object of exactly `n` UTF-8 bytes. */
function paddedJson(n: number): string {
  return `{"pad":"${"x".repeat(n - 10)}"}`;
}

test("an oversized legacy frame is corrupt, rejected before any digest or decryption", async () => {
  // The ruling: a legacy envelope past 2 * MAX_ARTIFACT_BYTES + 65 is not one a
  // supported writer produced, and its size alone is the verdict.
  const { bytes, digest } = await oversizedLegacy;
  for (const expected of [digest, null]) {
    const seen = await decodeUnwatched(bytes, expected);
    expect(seen).toEqual({ read: CORRUPT, digests: 0, decrypts: 0 });
  }
});

test("a legacy envelope exactly at the read ceiling decodes; the next size up is corrupt", async () => {
  const atCeiling = await legacySeal(paddedJson(MAX_ARTIFACT_BYTES));
  expect(atCeiling.length).toBe(GLOBAL_CEILING);
  const read = await decodeArtifact(await legacyKey, atCeiling, await sha256Hex(atCeiling));
  expect(read.ok).toBe(true);

  const past = await legacySeal(paddedJson(MAX_ARTIFACT_BYTES + 1));
  expect(past.length).toBe(GLOBAL_CEILING + 2);
  const seen = await decodeUnwatched(past, null);
  expect(seen).toEqual({ read: CORRUPT, digests: 0, decrypts: 0 });
});

/** Writes `bytes` under a fresh bodies directory, for the acquisition tests. */
async function plantFile(
  bytes: Uint8Array | null,
): Promise<{ root: string; dir: string; rel: string }> {
  const root = join(tmpdir(), `omni-bodies-${crypto.randomUUID()}`);
  const dir = join(root, "request_bodies");
  const rel = relPathFor(LEGACY_INPUT.requestId, LEGACY_INPUT.at);
  if (bytes !== null) await writeArtifact(dir, rel, bytes);
  return { root, dir, rel };
}

test("an artifact file past the ceiling is corrupt, not missing, and is never read whole", async () => {
  const { bytes, digest } = await oversizedLegacy;
  const planted = await plantFile(bytes);
  try {
    expect(await readArtifact(await legacyKey, planted.dir, planted.rel, digest)).toEqual({
      ok: false,
      failure: "corrupt",
    });

    // Sixty-four gibibytes of hole: past Bun's typed-array cap (allocating
    // 2 ** 32 bytes already fails) and past any CI runner's memory, so neither
    // an unbounded read nor an unbounded buffer can succeed, and `corrupt` here
    // can only mean the size was judged from the handle before anything was
    // allocated for it. The old whole-file read reported this as `missing`.
    // Kept well under ext4's 16 TiB file-size limit, so the truncate itself is
    // portable.
    await truncate(join(planted.dir, planted.rel), 2 ** 36);
    expect(await readArtifact(await legacyKey, planted.dir, planted.rel, null)).toEqual({
      ok: false,
      failure: "corrupt",
    });
  } finally {
    await rm(planted.root, { recursive: true, force: true });
  }
});

test("an artifact file exactly at the ceiling is read, and an absent one is missing", async () => {
  const atCeiling = await legacySeal(paddedJson(MAX_ARTIFACT_BYTES));
  const planted = await plantFile(atCeiling);
  try {
    const read = await readArtifact(
      await legacyKey,
      planted.dir,
      planted.rel,
      await sha256Hex(atCeiling),
    );
    expect(read.ok).toBe(true);
    expect(
      await readArtifact(await legacyKey, planted.dir, "2026/08/17/nope.json.enc", null),
    ).toEqual({ ok: false, failure: "missing" });
  } finally {
    await rm(planted.root, { recursive: true, force: true });
  }
});

test("an oversized legacy file reads as corrupt through the repository", async () => {
  const root = join(tmpdir(), `omni-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const dbPath = join(root, "omnigateway.db");
  const dir = bodiesDirFor(dbPath);
  const db = openDb(dbPath);
  const repo = createBodyRepo(db, await legacyKey, dir);
  const { bytes, digest } = await oversizedLegacy;
  const relPath = relPathFor(LEGACY_INPUT.requestId, LEGACY_INPUT.at);
  await writeArtifact(dir, relPath, bytes);
  db.run(
    `INSERT INTO request_bodies (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated)
     VALUES (?,?,?,?,?,?,?)`,
    [LEGACY_INPUT.requestId, LEGACY_INPUT.at, relPath, bytes.length, digest, "ready", 0],
  );

  const read = await repo.get(LEGACY_INPUT.requestId);
  expect(read?.row.detailState).toBe("corrupt");
  expect(read?.artifact).toBeNull();

  db.close();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Binary envelope. Fixtures are sealed here with WebCrypto from the published
// layout — magic, version, codec, claimed length, IV, ciphertext and tag, the
// first ten bytes as additional data — never by the artifact writer, so the
// reader is proven against the format rather than against its own writer.
// ---------------------------------------------------------------------------

type BinaryFields = {
  magic?: string;
  version?: number;
  codec?: number;
  claimed?: number;
  /** What GCM authenticates as additional data; the header itself by default. */
  aad?: Uint8Array<ArrayBuffer>;
  key?: CryptoKey;
};

function binaryHeader(magic: string, version: number, codec: number, claimed: number) {
  const header = new Uint8Array(10);
  header.set(encoder.encode(magic).subarray(0, 4));
  header[4] = version;
  header[5] = codec;
  new DataView(header.buffer).setUint32(6, claimed, false);
  return header;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function binarySeal(
  payload: Uint8Array<ArrayBuffer>,
  fields: BinaryFields = {},
): Promise<Uint8Array> {
  const header = binaryHeader(
    fields.magic ?? "OGBA",
    fields.version ?? 1,
    fields.codec ?? 0,
    fields.claimed ?? payload.length,
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: fields.aad ?? header, tagLength: 128 },
    fields.key ?? (await legacyKey),
    payload,
  );
  return concat(header, iv, new Uint8Array(sealed));
}

/** gzip from zlib directly, never the artifact writer, copied into a buffer of its own. */
function gz(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(data));
}

test("a binary envelope sealed from the spec decodes to the prepared artifact", async () => {
  const prepared = prepareArtifact(LEGACY_INPUT);
  const bytes = await binarySeal(encoder.encode(prepared.json));
  expect(bytes.length).toBe(Buffer.byteLength(prepared.json) + 38);

  const digest = await sha256Hex(bytes);
  for (const expected of [digest, null]) {
    const read = await decodeArtifact(await legacyKey, bytes, expected);
    expect(`${expected === null ? "null" : "digest"}: ${read.ok}`).toBe(
      `${expected === null ? "null" : "digest"}: true`,
    );
    if (read.ok) expect(read.artifact).toEqual(prepared.artifact);
  }
});

test("a binary envelope exactly at its ceiling decodes", async () => {
  const bytes = await binarySeal(encoder.encode(paddedJson(MAX_ARTIFACT_BYTES)));
  expect(bytes.length).toBe(BINARY_CEILING);
  expect((await decodeArtifact(await legacyKey, bytes, await sha256Hex(bytes))).ok).toBe(true);
});

test("a binary envelope that fails authentication is corrupt, digest or no digest", async () => {
  const json = encoder.encode(prepareArtifact(LEGACY_INPUT).json);
  const valid = await binarySeal(json);
  const flip = (offset: number): Uint8Array => {
    const out = valid.slice();
    out[offset] = (out[offset] ?? 0) ^ 0x01;
    return out;
  };
  const other = await deriveKey("another-secret-value-for-unit-tests");

  const cases: Array<[string, Uint8Array]> = [
    ["iv byte flipped", flip(10)],
    ["ciphertext byte flipped", flip(22)],
    ["tag byte flipped", flip(valid.length - 1)],
    ["sealed under another key", await binarySeal(json, { key: other })],
    // The header must be what GCM authenticated: sealed with none, or with a
    // header that differs from the one stored, neither may decode.
    ["sealed without additional data", await binarySeal(json, { aad: new Uint8Array(0) })],
    [
      "sealed over a different claimed length",
      await binarySeal(json, { aad: binaryHeader("OGBA", 1, 0, json.length + 1) }),
    ],
    [
      "sealed over a different codec",
      await binarySeal(json, { aad: binaryHeader("OGBA", 1, 1, json.length) }),
    ],
    [
      "sealed over a different magic",
      await binarySeal(json, { aad: binaryHeader("OGBX", 1, 0, json.length) }),
    ],
    // And the reverse: gzip stored, raw authenticated. Only the header GCM
    // vouched for may decide that the payload is expanded at all.
    [
      "gzip sealed over a raw header",
      await binarySeal(gz(json), {
        codec: 1,
        claimed: json.length,
        aad: binaryHeader("OGBA", 1, 0, json.length),
      }),
    ],
  ];

  const key = await legacyKey;
  for (const [name, bytes] of cases) {
    // Both with no digest and with the digest of exactly these bytes, so the
    // checksum can never be what is standing in for authentication.
    for (const expected of [null, await sha256Hex(bytes)]) {
      expect(`${name}: ${JSON.stringify(await decodeArtifact(key, bytes, expected))}`).toBe(
        `${name}: ${CORRUPT}`,
      );
    }
  }
  expect(await decodeArtifact(key, valid, "0".repeat(64))).toEqual({
    ok: false,
    failure: "corrupt",
  });
});

test("a binary header this reader does not implement is corrupt before any crypto runs", async () => {
  const json = encoder.encode(prepareArtifact(LEGACY_INPUT).json);
  const valid = await binarySeal(json);
  const legacy = await legacySeal(prepareArtifact(LEGACY_INPUT).json);
  const n = json.length;
  const gzipped = gz(json);

  // Every one authenticates under its own header, so GCM would accept it: only
  // the reader's own reading of the header can turn it away.
  const cases: Array<[string, Uint8Array]> = [
    ["version 0", await binarySeal(json, { version: 0 })],
    ["version 2", await binarySeal(json, { version: 2 })],
    ["version 255", await binarySeal(json, { version: 255 })],
    ["codec 2", await binarySeal(json, { codec: 2 })],
    ["codec 255", await binarySeal(json, { codec: 255 })],
    ["claimed length zero, empty payload", await binarySeal(new Uint8Array(0))],
    ["claimed length one short", await binarySeal(json, { claimed: n - 1 })],
    ["claimed length one long", await binarySeal(json, { claimed: n + 1 })],
    ["claimed length 2^32 - 1", await binarySeal(json, { claimed: 2 ** 32 - 1 })],
    [
      "one byte past the binary ceiling",
      await binarySeal(encoder.encode(paddedJson(MAX_ARTIFACT_BYTES + 1))),
    ],
    ["tag truncated by a byte", valid.subarray(0, valid.length - 1)],
    ["trailing byte after the tag", concat(valid, new Uint8Array([0]))],
    ["header only", valid.subarray(0, 10)],
    ["header and iv only", valid.subarray(0, 22)],
    ["one byte short of the minimum", valid.subarray(0, 37)],
    ["magic alone", encoder.encode("OGBA")],
    // Magic is compared exactly and whole; nothing near it is either format.
    ["magic in lower case", await binarySeal(json, { magic: "ogba" })],
    ["magic with a wrong last byte", await binarySeal(json, { magic: "OGBX" })],
    ["legacy prefix without its colon", encoder.encode("enc:v1")],
    // Neither format falls back to the other.
    ["binary magic ahead of a legacy envelope", concat(encoder.encode("OGBA"), legacy)],
    ["legacy prefix ahead of a binary envelope", concat(encoder.encode("enc:v1:"), valid)],
    ["empty input", new Uint8Array(0)],
    // gzip: the payload no longer fixes the claimed length, so each bound on
    // the header stands on its own.
    ["gzip claiming zero bytes", await binarySeal(gzipped, { codec: 1, claimed: 0 })],
    [
      "gzip claiming one byte past the budget",
      await binarySeal(gzipped, { codec: 1, claimed: MAX_ARTIFACT_BYTES + 1 }),
    ],
    [
      "gzip payload one byte past the binary ceiling",
      await binarySeal(new Uint8Array(MAX_ARTIFACT_BYTES + 1), { codec: 1, claimed: n }),
    ],
    [
      "gzip payload too short for a gzip header and footer",
      await binarySeal(gzipped.slice(0, 17), { codec: 1, claimed: n }),
    ],
  ];

  for (const [name, bytes] of cases) {
    const digest = await sha256Hex(bytes);
    for (const expected of [null, digest]) {
      const seen = await decodeUnwatched(bytes, expected);
      expect(`${name}: ${JSON.stringify(seen)}`).toBe(
        `${name}: ${JSON.stringify({ read: CORRUPT, digests: 0, decrypts: 0 })}`,
      );
    }
  }
});

test("an authenticated binary plaintext that is not a UTF-8 JSON object is corrupt", async () => {
  const key = await legacyKey;
  const text = (s: string) => encoder.encode(s);
  const cases: Array<[string, Uint8Array<ArrayBuffer>]> = [
    // A lenient decoder turns each of these into U+FFFD inside a valid object.
    ["invalid byte in a string", concat(text('{"a":"'), new Uint8Array([0xff]), text('"}'))],
    ["overlong encoding", concat(text('{"a":"'), new Uint8Array([0xc0, 0xaf]), text('"}'))],
    ["lone continuation byte", concat(text('{"a":"'), new Uint8Array([0x80]), text('"}'))],
    ["not json", text("not json {")],
    ["array", text("[]")],
    ["null", text("null")],
    ["number", text("42")],
    ["truncated object", text('{"a":')],
  ];
  for (const [name, payload] of cases) {
    const bytes = await binarySeal(payload);
    const read = await decodeArtifact(key, bytes, await sha256Hex(bytes));
    expect(`${name}: ${JSON.stringify(read)}`).toBe(`${name}: ${CORRUPT}`);
  }
});

test("a binary file reads as ready through the repository", async () => {
  const root = join(tmpdir(), `omni-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const dbPath = join(root, "omnigateway.db");
  const dir = bodiesDirFor(dbPath);
  const db = openDb(dbPath);
  const repo = createBodyRepo(db, await legacyKey, dir);

  const prepared = prepareArtifact(LEGACY_INPUT);
  const bytes = await binarySeal(encoder.encode(prepared.json));
  const relPath = relPathFor(LEGACY_INPUT.requestId, LEGACY_INPUT.at);
  await writeArtifact(dir, relPath, bytes);
  db.run(
    `INSERT INTO request_bodies (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated)
     VALUES (?,?,?,?,?,?,?)`,
    [LEGACY_INPUT.requestId, LEGACY_INPUT.at, relPath, bytes.length, null, "corrupt", 0],
  );

  // A null digest and a row previously marked corrupt: GCM alone vouches, and
  // the state recovers on the read that succeeds.
  const read = await repo.get(LEGACY_INPUT.requestId);
  expect(read?.row.detailState).toBe("ready");
  expect(read?.artifact).toEqual(prepared.artifact);

  db.close();
  await rm(root, { recursive: true, force: true });
});

test("the binary writer emits the published layout, readable with WebCrypto alone", async () => {
  const prepared = prepareArtifact(LEGACY_INPUT);
  const json = encoder.encode(prepared.json);
  const sealed = await sealBinaryArtifact(await legacyKey, prepared.json);
  const { bytes } = sealed;

  expect(decoder.decode(bytes.subarray(0, 4))).toBe("OGBA");
  expect(bytes[4]).toBe(1);
  expect(bytes[5]).toBe(0);
  expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(6, false)).toBe(json.length);
  expect(bytes.length).toBe(json.length + 38);
  expect(sealed.sha256).toBe(await sha256Hex(bytes));

  // Opened here without the reader: the first ten bytes are the additional data.
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(10, 22),
      additionalData: bytes.slice(0, 10),
      tagLength: 128,
    },
    await legacyKey,
    bytes.slice(22),
  );
  expect(new Uint8Array(plain)).toEqual(json);

  const read = await decodeArtifact(await legacyKey, bytes, sealed.sha256);
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.artifact).toEqual(prepared.artifact);
});

test("the same JSON sealed twice gets a fresh IV and different bytes in either format", async () => {
  const { json } = prepareArtifact(LEGACY_INPUT);
  const key = await legacyKey;

  const [a, b] = [await sealBinaryArtifact(key, json), await sealBinaryArtifact(key, json)];
  expect(a.bytes.subarray(0, 10)).toEqual(b.bytes.subarray(0, 10));
  expect(toHex(a.bytes.subarray(10, 22))).not.toBe(toHex(b.bytes.subarray(10, 22)));
  expect(toHex(a.bytes)).not.toBe(toHex(b.bytes));
  expect(a.sha256).not.toBe(b.sha256);

  const [c, d] = [await sealArtifact(key, json), await sealArtifact(key, json)];
  expect(legacyParts(c.bytes).iv).not.toBe(legacyParts(d.bytes).iv);
  expect(toHex(c.bytes)).not.toBe(toHex(d.bytes));
});

test("the default writer still emits the legacy envelope", async () => {
  const { bytes } = await sealArtifact(await legacyKey, prepareArtifact(LEGACY_INPUT).json);
  expect(decoder.decode(bytes).startsWith("enc:v1:")).toBe(true);
});

test("the binary writer refuses plaintext outside one byte to the artifact budget", async () => {
  const key = await legacyKey;
  const calls: number[] = [];
  const watched = async (plain: Uint8Array): Promise<Uint8Array> => {
    calls.push(plain.length);
    return gz(plain);
  };
  // Padding compresses to almost nothing, so a writer that judged the budget on
  // the compressed size would admit this; the budget is on what the reader
  // gets back, and the compressor is never even asked.
  await expect(
    sealBinaryArtifact(key, paddedJson(MAX_ARTIFACT_BYTES + 1), watched),
  ).rejects.toThrow();
  await expect(sealBinaryArtifact(key, "", watched)).rejects.toThrow();
  expect(calls).toEqual([]);

  const atBudget = await sealBinaryArtifact(key, paddedJson(MAX_ARTIFACT_BYTES));
  expect(atBudget.bytes[5]).toBe(1);
  expect((await decodeArtifact(key, atBudget.bytes, atBudget.sha256)).ok).toBe(true);
  const rawAtBudget = await sealBinaryArtifact(key, paddedJson(MAX_ARTIFACT_BYTES), failing);
  expect(rawAtBudget.bytes.length).toBe(BINARY_CEILING);
});

// ---------------------------------------------------------------------------
// gzip. Compressed before encryption, because ciphertext does not compress;
// expanded only after GCM has vouched for the header that says to, and never
// past the artifact budget whatever the payload asks for.
// ---------------------------------------------------------------------------

/** A compressor that always fails, for the writer's fallback. */
async function failing(): Promise<Uint8Array> {
  throw new Error("compressor unavailable");
}

/** A compressor whose output is exactly `size(n)` bytes for an `n`-byte input. */
function sized(size: (n: number) => number) {
  const calls: number[] = [];
  const compress = async (plain: Uint8Array): Promise<Uint8Array> => {
    calls.push(plain.length);
    return new Uint8Array(size(plain.length));
  };
  return { calls, compress };
}

/** The writer's header fields and payload length, read back by hand. */
function layout(bytes: Uint8Array): { codec: number; claimed: number; payload: number } {
  return {
    codec: bytes[5] ?? -1,
    claimed: new DataView(bytes.buffer, bytes.byteOffset).getUint32(6, false),
    payload: bytes.length - 38,
  };
}

/** Opens an envelope with WebCrypto alone and returns the authenticated payload. */
async function openByHand(bytes: Uint8Array): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(10, 22),
      additionalData: bytes.slice(0, 10),
      tagLength: 128,
    },
    await legacyKey,
    bytes.slice(22),
  );
  return new Uint8Array(plain);
}

/** A compressible artifact past the gzip cutoff: repetitive stream frames. */
const COMPRESSIBLE_INPUT = artifact({
  attempts: [
    {
      attempt: 1,
      provider: "anthropic",
      request: { model: "claude-opus-4-1-20250805" },
      response: { stop_reason: "end_turn" },
      streamChunks: Array.from(
        { length: 200 },
        (_, i) => `event: content_block_delta\ndata: {"index":0,"delta":{"text":"word ${i}"}}`,
      ),
      truncated: false,
    },
  ],
});

test("a gzip envelope sealed from the spec decodes to the prepared artifact", async () => {
  const prepared = prepareArtifact(COMPRESSIBLE_INPUT);
  const json = encoder.encode(prepared.json);
  const payload = gz(json);
  expect(payload.length).toBeLessThan(json.length);
  const bytes = await binarySeal(payload, { codec: 1, claimed: json.length });

  for (const expected of [await sha256Hex(bytes), null]) {
    const read = await decodeArtifact(await legacyKey, bytes, expected);
    expect(`${expected === null ? "null" : "digest"}: ${read.ok}`).toBe(
      `${expected === null ? "null" : "digest"}: true`,
    );
    if (read.ok) expect(read.artifact).toEqual(prepared.artifact);
  }
});

test("concatenated gzip members decode when their whole output is the claimed length", async () => {
  const json = encoder.encode(prepareArtifact(COMPRESSIBLE_INPUT).json);
  const half = Math.floor(json.length / 2);
  const payload = concat(gz(json.subarray(0, half)), gz(json.subarray(half)));
  const bytes = await binarySeal(payload, { codec: 1, claimed: json.length });
  const read = await decodeArtifact(await legacyKey, bytes, await sha256Hex(bytes));
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.artifact).toEqual(prepareArtifact(COMPRESSIBLE_INPUT).artifact);
});

test("authenticated gzip that does not expand to exactly the claimed bytes is corrupt", async () => {
  const json = encoder.encode(prepareArtifact(COMPRESSIBLE_INPUT).json);
  const n = json.length;
  const valid = gz(json);
  const flip = (offset: number): Uint8Array<ArrayBuffer> => {
    const out = valid.slice();
    out[offset] = (out[offset] ?? 0) ^ 0x01;
    return out;
  };
  const half = Math.floor(n / 2);
  const first = gz(json.subarray(0, half));

  // Every payload is authenticated under the header it is stored with, so GCM
  // accepts each one: only the expansion can turn it away, after decryption.
  const cases: Array<[string, Uint8Array<ArrayBuffer>, number]> = [
    ["claimed one short", valid, n - 1],
    ["claimed one long", valid, n + 1],
    ["truncated by a byte", valid.slice(0, -1), n],
    ["footer missing", valid.slice(0, -8), n],
    ["deflate stream cut in half", valid.slice(0, Math.floor(valid.length / 2)), n],
    ["crc flipped", flip(valid.length - 8), n],
    ["length field flipped", flip(valid.length - 1), n],
    ["trailing garbage", concat(valid, new Uint8Array([1, 2, 3])), n],
    ["a partial second member", concat(valid, new Uint8Array([0x1f, 0x8b])), n],
    // zlib skips trailing zero bytes as padding and returns the member before
    // them, so these decode natively; the reader must refuse them itself.
    ["one trailing zero byte", concat(valid, new Uint8Array(1)), n],
    ["eight trailing zero bytes", concat(valid, new Uint8Array(8)), n],
    [
      "valid members then a zero byte",
      concat(first, gz(json.subarray(half)), new Uint8Array(1)),
      n,
    ],
    ["a second member past the claimed length", concat(first, gz(json.subarray(half))), half],
    ["plain JSON stored as gzip", json, n],
    ["gzip of nothing", gz(""), 1],
    ["gzip of an array", gz("[1]"), 3],
  ];

  for (const [name, payload, claimed] of cases) {
    const bytes = await binarySeal(payload, { codec: 1, claimed });
    const digest = await sha256Hex(bytes);
    const seen = await decodeUnwatched(bytes, digest);
    expect(`${name}: ${JSON.stringify(seen)}`).toBe(
      `${name}: ${JSON.stringify({ read: CORRUPT, digests: 1, decrypts: 1 })}`,
    );
  }
});

/**
 * A JSON object whose gzip stream is exactly as long as the object itself, so
 * one payload satisfies a raw header's length and a gzip expansion's at once.
 * Searched for rather than written down, from a fixed generator, so a different
 * zlib build finds its own instead of breaking the premise.
 */
function gzipAsLongAsItself(): { json: string; payload: Uint8Array<ArrayBuffer> } {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let length = 1; length < 1000; length++) {
    let state = length;
    const next = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state >>> 16;
    };
    const json = JSON.stringify({
      k: Array.from({ length }, () => alphabet[next() % 64]).join(""),
    });
    const payload = gz(json);
    if (payload.length === encoder.encode(json).length) return { json, payload };
  }
  throw new Error("no JSON object gzips to its own length");
}

test("the codec comes from the authenticated header, never from the payload's shape", async () => {
  const key = await legacyKey;
  const { json, payload } = gzipAsLongAsItself();

  // Raw, holding a perfectly good gzip stream of a JSON object whose length is
  // the claimed length: a reader that sniffed the gzip magic would expand it and
  // hand the object back. Stored as it is, it is not UTF-8, so it is corrupt.
  const raw = await binarySeal(payload, { codec: 0, claimed: payload.length });
  expect(await decodeArtifact(key, raw, null)).toEqual({ ok: false, failure: "corrupt" });

  // The same stream under a gzip header is the object.
  const gzipped = await binarySeal(payload, { codec: 1, claimed: payload.length });
  expect(await decodeArtifact(key, gzipped, null)).toEqual({
    ok: true,
    artifact: JSON.parse(json),
  });
});

/**
 * Sixteen mebibytes of zeros gzips to about sixteen kilobytes; thirty of those
 * members fit under the binary ceiling and stand for 480 MiB. Building it costs
 * one compression, and inflating it unbounded would cost half a gigabyte.
 */
const BOMB_MEMBER = gz(new Uint8Array(16 * 1024 * 1024));
const BOMB = concat(...Array.from({ length: 30 }, () => BOMB_MEMBER));

test("an authenticated gzip bomb is stopped inside bounded decompression", async () => {
  expect(BOMB.length).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);

  for (const [name, payload] of [
    ["single member", BOMB_MEMBER],
    ["thirty members", BOMB],
  ] as const) {
    for (const claimed of [1000, MAX_ARTIFACT_BYTES]) {
      // The native limit is what refuses it: zlib's own error, raised before
      // the output passes the budget, not the reader's length comparison
      // after an unbounded inflate.
      await expect(gunzipArtifact(payload, claimed)).rejects.toMatchObject({
        code: "ERR_BUFFER_TOO_LARGE",
      });

      const bytes = await binarySeal(payload, { codec: 1, claimed });
      const seen = await decodeUnwatched(bytes, null);
      expect(`${name} claiming ${claimed}: ${JSON.stringify(seen)}`).toBe(
        `${name} claiming ${claimed}: ${JSON.stringify({ read: CORRUPT, digests: 0, decrypts: 1 })}`,
      );
    }
  }
});

test("gzip expanding to exactly the budget decodes; one byte more is stopped by the bound", async () => {
  const atBudget = encoder.encode(paddedJson(MAX_ARTIFACT_BYTES));
  const bytes = await binarySeal(gz(atBudget), { codec: 1, claimed: MAX_ARTIFACT_BYTES });
  expect((await decodeArtifact(await legacyKey, bytes, null)).ok).toBe(true);
  expect(await gunzipArtifact(gz(atBudget), MAX_ARTIFACT_BYTES)).toEqual(atBudget);

  const past = gz(paddedJson(MAX_ARTIFACT_BYTES + 1));
  await expect(gunzipArtifact(past, MAX_ARTIFACT_BYTES)).rejects.toMatchObject({
    code: "ERR_BUFFER_TOO_LARGE",
  });
});

test("the writer stores plaintext under the cutoff raw and compressible plaintext as gzip", async () => {
  const key = await legacyKey;

  // Padding saves far more than the minimum, so only the cutoff can keep 1023
  // bytes raw.
  const small = await sealBinaryArtifact(key, paddedJson(1023));
  expect(layout(small.bytes)).toEqual({ codec: 0, claimed: 1023, payload: 1023 });
  expect(decoder.decode(await openByHand(small.bytes))).toBe(paddedJson(1023));

  const cutoff = await sealBinaryArtifact(key, paddedJson(1024));
  expect(layout(cutoff.bytes).codec).toBe(1);
  expect(layout(cutoff.bytes).claimed).toBe(1024);
  expect(layout(cutoff.bytes).payload).toBeLessThanOrEqual(1024 - 64);
  // Opened and expanded here with WebCrypto and zlib alone.
  expect(decoder.decode(gunzipSync(await openByHand(cutoff.bytes)))).toBe(paddedJson(1024));

  const prepared = prepareArtifact(COMPRESSIBLE_INPUT);
  const sealed = await sealBinaryArtifact(key, prepared.json);
  const json = encoder.encode(prepared.json);
  expect(layout(sealed.bytes).codec).toBe(1);
  expect(layout(sealed.bytes).claimed).toBe(json.length);
  expect(layout(sealed.bytes).payload).toBeLessThan(json.length / 2);
  expect(sealed.sha256).toBe(await sha256Hex(sealed.bytes));
  const read = await decodeArtifact(key, sealed.bytes, sealed.sha256);
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.artifact).toEqual(prepared.artifact);
});

test("the writer only asks for gzip at or past the cutoff, and keeps it at a 64-byte saving", async () => {
  const key = await legacyKey;

  const under = sized(() => 1);
  const raw = await sealBinaryArtifact(key, paddedJson(1023), under.compress);
  expect(under.calls).toEqual([]);
  expect(layout(raw.bytes).codec).toBe(0);

  const n = 2000;
  const saves63 = sized((len) => len - 63);
  const kept63 = await sealBinaryArtifact(key, paddedJson(n), saves63.compress);
  expect(saves63.calls).toEqual([n]);
  expect(layout(kept63.bytes)).toEqual({ codec: 0, claimed: n, payload: n });

  const saves64 = sized((len) => len - 64);
  const kept64 = await sealBinaryArtifact(key, paddedJson(n), saves64.compress);
  expect(layout(kept64.bytes)).toEqual({ codec: 1, claimed: n, payload: n - 64 });

  const atCutoff = sized((len) => len - 64);
  const gzipAtCutoff = await sealBinaryArtifact(key, paddedJson(1024), atCutoff.compress);
  expect(atCutoff.calls).toEqual([1024]);
  expect(layout(gzipAtCutoff.bytes).codec).toBe(1);
});

test("incompressible plaintext, or a failed compression, is stored raw without growth", async () => {
  const key = await legacyKey;
  const json = prepareArtifact(COMPRESSIBLE_INPUT).json;
  const n = encoder.encode(json).length;

  for (const [name, compress] of [
    ["grows", sized((len) => len + 20).compress],
    ["no saving", sized((len) => len).compress],
    ["fails", failing],
  ] as const) {
    const sealed = await sealBinaryArtifact(key, json, compress);
    expect(`${name}: ${JSON.stringify(layout(sealed.bytes))}`).toBe(
      `${name}: ${JSON.stringify({ codec: 0, claimed: n, payload: n })}`,
    );
    expect(decoder.decode(await openByHand(sealed.bytes))).toBe(json);
    expect((await decodeArtifact(key, sealed.bytes, sealed.sha256)).ok).toBe(true);
  }

  // Random bytes, hex-encoded: real gzip saves some of the hex's redundancy,
  // and whichever arm the policy picks the envelope is never larger than raw.
  const noise = toHex(crypto.getRandomValues(new Uint8Array(4096)));
  const real = await sealBinaryArtifact(key, JSON.stringify({ noise }));
  expect(real.bytes.length).toBeLessThanOrEqual(JSON.stringify({ noise }).length + 38);
  expect((await decodeArtifact(key, real.bytes, real.sha256)).ok).toBe(true);
});

test("an encryption failure propagates from the writer rather than storing anything", async () => {
  const decryptOnly = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, [
    "decrypt",
  ]);
  for (const json of [paddedJson(100), prepareArtifact(COMPRESSIBLE_INPUT).json]) {
    await expect(sealBinaryArtifact(decryptOnly, json)).rejects.toThrow();
  }
});

// ---------------------------------------------------------------------------
// Sweeps. Deletion is explicit and takes the file with the row, because a
// cascade would depend on a pragma whose absence is invisible.
// ---------------------------------------------------------------------------

test("retention prune removes rows and their artifact files together", async () => {
  const { store, root, dir } = await tempStore();
  const old = await store.bodies.put(artifact({ requestId: "req_old", at: Date.UTC(2026, 0, 1) }));
  const fresh = await store.bodies.put(
    artifact({ requestId: "req_fresh", at: Date.UTC(2026, 6, 1) }),
  );

  expect(await store.bodies.prune(Date.UTC(2026, 3, 1))).toBe(1);
  expect(await exists(join(dir, old.relPath ?? ""))).toBe(false);
  expect(await store.bodies.get("req_old")).toBeNull();
  expect(await exists(join(dir, fresh.relPath ?? ""))).toBe(true);
  expect((await store.bodies.get("req_fresh"))?.artifact).not.toBeNull();
  await cleanup(store, root);
});

test("the row cap prunes oldest first and takes the files with it", async () => {
  const { store, root, dir } = await tempStore();
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(await store.bodies.put(artifact({ requestId: `req_${i}`, at: AT + i * 86_400_000 })));
  }

  expect(await store.bodies.pruneToCap(2)).toBe(3);
  expect(await store.bodies.get("req_0")).toBeNull();
  expect(await store.bodies.get("req_2")).toBeNull();
  expect((await store.bodies.get("req_3"))?.artifact).not.toBeNull();
  expect((await store.bodies.get("req_4"))?.artifact).not.toBeNull();
  for (const i of [0, 1, 2]) {
    expect(await exists(join(dir, rows[i]?.relPath ?? ""))).toBe(false);
  }
  // Under the cap, nothing moves.
  expect(await store.bodies.pruneToCap(2)).toBe(0);
  await cleanup(store, root);
});

test("the orphan sweep removes artifact files with no row and spares the rest", async () => {
  const { store, root, dir } = await tempStore();
  const kept = await store.bodies.put(artifact({ requestId: "req_kept" }));
  // What a crash between the file write and the row write leaves behind.
  await mkdir(join(dir, "2025/12/31"), { recursive: true });
  await writeFile(join(dir, "2025/12/31/req_orphan.json.enc"), "enc:v1:00:00:00");

  expect(await store.bodies.sweepOrphans()).toBe(1);
  expect(await exists(join(dir, "2025/12/31/req_orphan.json.enc"))).toBe(false);
  expect(await exists(join(dir, kept.relPath ?? ""))).toBe(true);
  expect((await store.bodies.get("req_kept"))?.artifact).not.toBeNull();
  // Idempotent, and it does not mistake a live artifact for an orphan on a
  // second pass.
  expect(await store.bodies.sweepOrphans()).toBe(0);
  await cleanup(store, root);
});

/** Points a row at the bytes a test wrote over its artifact file, as `put` would have. */
function describeBytes(
  dbPath: string,
  requestId: string,
  sealed: { bytes: Uint8Array; sha256: string },
): void {
  const db = new Database(dbPath);
  try {
    db.run("UPDATE request_bodies SET size_bytes = ?, sha256 = ? WHERE request_id = ?", [
      sealed.bytes.length,
      sealed.sha256,
      requestId,
    ]);
  } finally {
    db.close();
  }
}

test("the orphan sweep goes by path, so binary artifacts are spared with a row and swept without", async () => {
  const { store, root, dbPath, dir } = await tempStore();
  const input = artifact({ requestId: "req_binary_kept" });
  const kept = await store.bodies.put(input);
  const key = await deriveKey("test-secret-value-for-unit-tests");
  const sealed = await sealBinaryArtifact(key, prepareArtifact(input).json);
  await writeArtifact(dir, kept.relPath ?? "", sealed.bytes);
  describeBytes(dbPath, input.requestId, sealed);
  await writeArtifact(dir, "2025/12/31/req_binary_orphan.json.enc", sealed.bytes);

  expect(await store.bodies.sweepOrphans()).toBe(1);
  expect(await exists(join(dir, "2025/12/31/req_binary_orphan.json.enc"))).toBe(false);
  expect(await exists(join(dir, kept.relPath ?? ""))).toBe(true);
  // The binary envelope sits under the unchanged `.json.enc` name and is read
  // back by the row that points at it.
  expect(new TextDecoder().decode(sealed.bytes.slice(0, 4))).toBe("OGBA");
  expect(kept.relPath?.endsWith(".json.enc")).toBe(true);
  expect((await store.bodies.get(input.requestId))?.artifact).toEqual(
    prepareArtifact(input).artifact,
  );
  expect(await store.bodies.sweepOrphans()).toBe(0);
  await cleanup(store, root);
});

test("a snapshot carries the row but not a binary artifact file, so the restored pointer is missing", async () => {
  const { store, root, dbPath, dir } = await tempStore();
  const input = artifact({ requestId: "req_binary_snap" });
  const row = await store.bodies.put(input);
  const key = await deriveKey("test-secret-value-for-unit-tests");
  const sealed = await sealBinaryArtifact(key, prepareArtifact(input).json);
  await writeArtifact(dir, row.relPath ?? "", sealed.bytes);
  describeBytes(dbPath, input.requestId, sealed);
  expect((await store.bodies.get(input.requestId))?.row.detailState).toBe("ready");

  const snapshot = join(root, "snap", "omnigateway.db");
  await mkdir(join(root, "snap"), { recursive: true });
  await store.maintenance.snapshotTo(snapshot);
  expect(await exists(join(root, "snap", "request_bodies"))).toBe(false);

  // A restored database is opened where the artifact directory is not.
  const restored = await createStore({ path: snapshot, encryptionKey: key });
  try {
    const read = await restored.bodies.get(input.requestId);
    expect(read?.row.sha256).toBe(sealed.sha256);
    expect(read?.row.sizeBytes).toBe(sealed.bytes.length);
    expect(read?.row.detailState).toBe("missing");
    expect(read?.artifact).toBeNull();
  } finally {
    restored.close();
  }
  await cleanup(store, root);
});

/**
 * The window `put` opens on every capture, reproduced exactly.
 *
 * `put` writes the artifact file and *then* inserts its row, so a request that
 * completes while the sweep is walking the tree has its file listed and its row
 * absent from whatever snapshot the sweep started with. Walking a tree of a
 * hundred thousand files is not instantaneous, so this is a live gateway's
 * ordinary state rather than a contrived one — and sweeping on the snapshot
 * alone deletes the artifact while its row goes on claiming `ready`.
 *
 * The interleaving here is not a race the test hopes to win. The snapshot query
 * is synchronous and runs before the sweep's first `await`, so a row inserted on
 * the line after the call is guaranteed to be one the snapshot never saw and to
 * exist before any unlink, which happens only after the tree walk.
 */
test("the orphan sweep spares an artifact whose row lands after the sweep began", async () => {
  const root = join(tmpdir(), `omni-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const dbPath = join(root, "omnigateway.db");
  const dir = bodiesDirFor(dbPath);
  // One connection, held by the test, so the row insert below is ordered against
  // the sweep's own queries rather than against a second connection's view.
  const db = openDb(dbPath);
  const repo = createBodyRepo(db, await deriveKey("test-secret-value-for-unit-tests"), dir);

  const live = artifact({ requestId: "req_live" });
  const relPath = relPathFor(live.requestId, live.at);
  const bytes = new TextEncoder().encode("enc:v1:00:00:00");
  // The file half of a `put` whose row has not landed yet.
  await writeArtifact(dir, relPath, bytes);
  // And a real orphan alongside it, so a sweep that simply deleted nothing would
  // not pass this by accident.
  await writeArtifact(dir, "2025/12/31/req_orphan.json.enc", bytes);

  const sweep = repo.sweepOrphans();
  db.run(
    `INSERT INTO request_bodies (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated)
     VALUES (?,?,?,?,?,?,?)`,
    [live.requestId, live.at, relPath, bytes.length, null, "ready", 0],
  );

  expect(await sweep).toBe(1);
  expect(await exists(join(dir, relPath))).toBe(true);
  expect(await exists(join(dir, "2025/12/31/req_orphan.json.enc"))).toBe(false);

  db.close();
  await rm(root, { recursive: true, force: true });
});
