import { expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bodiesDirFor,
  MAX_ARTIFACT_BYTES,
  prepareArtifact,
  relPathFor,
  writeArtifact,
} from "../src/bodies/artifact.ts";
import {
  boundValue,
  DEPTH_MARKER,
  MAX_OBJECT_KEYS,
  MAX_STRING_BYTES,
} from "../src/bodies/bound.ts";
import { MASK_RULES, type MaskRule, type MaskRuleId, maskString } from "../src/bodies/mask.ts";
import { deriveKey } from "../src/encryption.ts";
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
