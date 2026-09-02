import { expect, test } from "bun:test";
import { createLogger, type LogFields, type Logger, safeToken } from "../src/logger.ts";

/**
 * The redaction boundary, pinned at the compiler rather than at review.
 *
 * `LogFields` is a closed allowlist so that arbitrary strings — prompt text,
 * upstream bodies, operator input — cannot reach stdout by riding on a log line.
 * That is a claim about *enforcement*, and enforcement is what was broken: a
 * plain `fields?: LogFields` is checked by excess property checking, which only
 * looks at fresh object literals. A conditional spread and a wider variable both
 * walked past it, and the spread is how it was found — it is the natural way to
 * write an optional field, and the compiler agreed with it.
 *
 * **These assertions are `@ts-expect-error`, which means they run at
 * `bun run typecheck` and not here.** If the constraint is ever relaxed, the
 * suppressed error stops occurring and `@ts-expect-error` becomes an error
 * itself — so the pin fails loudly in the direction that matters. A runtime test
 * could not check this at all: the field would simply be printed.
 */

const sink: string[] = [];
const logger: Logger = createLogger({
  level: "debug",
  write: (line) => sink.push(line),
  now: () => 0,
});

test("a field the allowlist does not name is refused, however it is written", () => {
  sink.length = 0;
  // 1. The direct literal. Excess property checking always caught this one.
  // @ts-expect-error - `detail` is not a member of LogFields
  logger.info("direct", { plugin: "p", detail: "leak" });

  // 2. Through a conditional spread. **This was accepted before the fix.**
  // @ts-expect-error - `detail` is not a member of LogFields
  logger.info("spread", { plugin: "p", ...(sink.length > 99 ? {} : { detail: "leak" }) });

  // 3. Through a variable of a wider type. This never had a check at all —
  //    excess property checking does not apply to a value that is not a literal.
  const wider = { plugin: "p", detail: "leak" };
  // @ts-expect-error - `detail` is not a member of LogFields
  logger.error("variable", wider);

  // Every level, not just one: the constraint is written four times and three
  // of them could be dropped without any other test noticing.
  //
  // Through the **spread**, like case 2. Written as fresh literals these two
  // passed against a plain `fields?: LogFields` — excess property checking
  // already refuses those — so relaxing `debug` and `warn` alone left the suite
  // green, and two of the four constraints were unpinned by the very test whose
  // comment claimed all four.
  // A concrete key beside the spread, as case 2 has. With only a spread the
  // argument has no property TypeScript must infer from, so `T` falls back to
  // `LogFields` itself, `keyof T` never contains `detail`, and the constraint
  // has nothing to reject — the assertion would pass for the wrong reason.
  // @ts-expect-error - `detail` is not a member of LogFields
  logger.debug("debug", { plugin: "p", ...(sink.length > 99 ? {} : { detail: "leak" }) });
  // @ts-expect-error - `detail` is not a member of LogFields
  logger.warn("warn", { plugin: "p", ...(sink.length > 99 ? {} : { detail: "leak" }) });

  // The lines above still *run*, so this is also the proof they are reachable
  // rather than dead code the compiler alone ever sees.
  expect(sink).toHaveLength(5);
});

test("every legitimate spelling still compiles, so the constraint is not merely strict", () => {
  sink.length = 0;
  // The control. A constraint that refused everything would satisfy the test
  // above while making the logger unusable, and nothing else here would notice.
  logger.info("literal", { plugin: "p", status: 200 });

  const optional = sink.length > 99 ? {} : { status: 200 };
  logger.info("spread", { plugin: "p", ...optional });

  const prepared: LogFields = { requestId: "req_1", provider: "anthropic" };
  logger.info("variable", prepared);

  logger.info("no fields at all");

  expect(sink).toHaveLength(4);
});

test("the surface field names the three client dialects and nothing else", () => {
  sink.length = 0;
  logger.info("anthropic", { surface: "anthropic" });
  logger.info("openai", { surface: "openai" });
  logger.info("responses", { surface: "responses" });
  // Vocabulary, not free text: a fourth surface is a core edit by design, and
  // this is the line that makes it one.
  // @ts-expect-error - "grpc" is not a client surface this gateway serves
  logger.info("invented", { surface: "grpc" });
  expect(sink).toHaveLength(4);
});

test("a model name is capped on the way out, like the reason beside it", () => {
  sink.length = 0;
  // `resolveModel` synthesizes a target from a prefixed model name, so
  // `resolvedModel` can be the client's own string — and unlike `reason` this
  // field had no cap at all, which made it the longer of the two channels onto
  // the same line.
  logger.info("routed", { model: `anthropic/${"x".repeat(4000)}`, reason: "y".repeat(4000) });
  const line = sink[0] as string;
  expect(line.length).toBeLessThan(700);
});

test("safeToken refuses what would forge a log line, at any length", () => {
  // The charset is the half that matters, and for a narrower reason than it
  // first appears: `renderValue` JSON-quotes a value containing whitespace or a
  // quote, so a newline is escaped rather than writing a second line. What the
  // charset buys is keeping such a value off the line at all. None of these is
  // long enough for a length bound to catch.
  const hostile = ['a"b', "a b", "a\nb", "a\rb", "a\u001b[31mb", "a=b"];
  for (const value of hostile) expect(safeToken(value)).toBe("(unprintable)");
  // And the length boundary itself, on a value the charset accepts.
  expect(safeToken("a".repeat(64))).toBe("a".repeat(64));
  expect(safeToken("a".repeat(65))).toBe("(unprintable)");
});
