import { describe, expect, test } from "bun:test";
import {
  createLogger,
  formatLine,
  type LogLevel,
  noopLogger,
  parseLine,
  parseLogLevel,
} from "../src/index.ts";

const AT = Date.parse("2026-08-09T04:12:03.114Z");

function capture(level: LogLevel = "debug") {
  const lines: string[] = [];
  const logger = createLogger({ level, write: (line) => lines.push(line), now: () => AT });
  return { lines, logger };
}

describe("formatLine", () => {
  test("renders an ISO instant, a padded level, and the message", () => {
    expect(formatLine("info", AT, "listening", undefined, false)).toBe(
      "2026-08-09T04:12:03.114Z INFO  listening",
    );
  });

  test("pads every level to the same width", () => {
    const widths = (["debug", "info", "warn", "error"] as const).map((level) =>
      formatLine(level, AT, "x", undefined, false).indexOf("x"),
    );
    expect(new Set(widths).size).toBe(1);
  });

  test("renders fields in declaration order, not insertion order", () => {
    const line = formatLine(
      "error",
      AT,
      "attempt failed",
      { code: "UPSTREAM", requestId: "req_9f2", provider: "anthropic", durationMs: 812 },
      false,
    );
    expect(line).toBe(
      "2026-08-09T04:12:03.114Z ERROR attempt failed  " +
        "requestId=req_9f2 provider=anthropic code=UPSTREAM durationMs=812",
    );
  });

  test("omits undefined fields but renders null", () => {
    const line = formatLine("info", AT, "done", { requestId: undefined, ttftMs: null }, false);
    expect(line).toBe("2026-08-09T04:12:03.114Z INFO  done  ttftMs=null");
  });

  test("drops the field section entirely when nothing is set", () => {
    expect(formatLine("info", AT, "done", { requestId: undefined }, false)).toBe(
      "2026-08-09T04:12:03.114Z INFO  done",
    );
  });

  test("quotes values containing a space, an equals sign, or a quote", () => {
    const line = formatLine("warn", AT, "x", { reason: "no such host = down" }, false);
    expect(line).toContain('reason="no such host = down"');
  });

  test("leaves an unambiguous value bare", () => {
    expect(formatLine("warn", AT, "x", { reason: "invalid_grant" }, false)).toContain(
      "reason=invalid_grant",
    );
  });

  test("renders booleans and numbers without quoting", () => {
    const line = formatLine("info", AT, "x", { retryable: false, status: 429 }, false);
    expect(line).toContain("status=429");
    expect(line).toContain("retryable=false");
  });

  test("truncates reason to 200 characters, so an upstream body cannot ride along", () => {
    const line = formatLine("error", AT, "x", { reason: "a".repeat(500) }, false);
    expect(line).toContain(`reason=${"a".repeat(200)}…`);
    expect(line).not.toContain("a".repeat(201));
  });

  test("renders reason last, so truncation cannot hide a structured field", () => {
    const line = formatLine("error", AT, "x", { reason: "why", status: 500 }, false);
    expect(line.indexOf("status=")).toBeLessThan(line.indexOf("reason="));
  });

  test("wraps only the level token in colour, and only when asked", () => {
    const plain = formatLine("error", AT, "boom", undefined, false);
    const colored = formatLine("error", AT, "boom", undefined, true);
    expect(plain).not.toContain("");
    expect(colored).toContain("\u001b[31mERROR\u001b[0m");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
    expect(colored.replace(/\[[0-9;]*m/g, "")).toBe(plain);
  });
});

describe("createLogger", () => {
  test("writes everything at debug", () => {
    const { lines, logger } = capture("debug");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toHaveLength(4);
  });

  test.each([
    ["debug", 4],
    ["info", 3],
    ["warn", 2],
    ["error", 1],
  ] as const)("level %s admits %i of the four levels", (level, expected) => {
    const { lines, logger } = capture(level);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toHaveLength(expected);
  });

  test("enabled() agrees with what is actually written", () => {
    const { lines, logger } = capture("warn");
    for (const level of ["debug", "info", "warn", "error"] as const) {
      const before = lines.length;
      logger[level]("x");
      expect(lines.length > before).toBe(logger.enabled(level));
    }
  });

  test("uses the injected clock", () => {
    const { lines, logger } = capture();
    logger.info("x");
    expect(lines[0]).toStartWith("2026-08-09T04:12:03.114Z");
  });

  test("swallows a failing sink rather than failing the caller", () => {
    const logger = createLogger({
      level: "info",
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => logger.error("boom")).not.toThrow();
  });

  test("defaults to no colour", () => {
    const { lines, logger } = capture();
    logger.error("x");
    expect(lines[0]).not.toContain("");
  });
});

describe("noopLogger", () => {
  test("reports nothing enabled and throws at no level", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(noopLogger.enabled(level)).toBe(false);
      expect(() => noopLogger[level]("x", { requestId: "r" })).not.toThrow();
    }
  });
});

describe("parseLogLevel", () => {
  test.each(["debug", "info", "warn", "error"] as const)("accepts %s", (level) => {
    expect(parseLogLevel(level)).toBe(level);
  });

  test("normalizes case and surrounding space", () => {
    expect(parseLogLevel("  WARN ")).toBe("warn");
  });

  test.each([undefined, "", "   ", "verbose", "10", "constructor"])(
    "returns null for %p so the caller picks the fallback",
    (value) => {
      expect(parseLogLevel(value)).toBeNull();
    },
  );
});

describe("parseLine", () => {
  test("recovers the head of a line the formatter produced", () => {
    const line = formatLine("warn", AT, "attempt failed; retrying", { attempt: 2 }, false);
    expect(parseLine(line)).toEqual({
      raw: line,
      at: AT,
      level: "warn",
      msg: "attempt failed; retrying",
    });
  });

  test.each(["debug", "info", "warn", "error"] as const)("round-trips %s", (level) => {
    const line = formatLine(level, AT, "x", undefined, false);
    expect(parseLine(line).level).toBe(level);
  });

  test("reads a coloured line, because a TTY-started gateway writes escapes to its log file", () => {
    const line = formatLine("error", AT, "gateway boot failed", { reason: "no key" }, true);
    expect(line).toContain("[");
    expect(parseLine(line)).toMatchObject({ at: AT, level: "error", msg: "gateway boot failed" });
  });

  test("keeps the message whole and leaves the fields in raw", () => {
    const line = formatLine("info", AT, "omnigateway listening", { port: 9000 }, false);
    const parsed = parseLine(line);
    expect(parsed.msg).toBe("omnigateway listening");
    expect(parsed.raw).toContain("port=9000");
  });

  test("returns nulls for a line the gateway did not write", () => {
    const line = "Aug 09 04:12:03 host systemd[1]: Started omnigateway.service.";
    expect(parseLine(line)).toEqual({ raw: line, at: null, level: null, msg: null });
  });

  test.each([
    ["an empty line", ""],
    ["a bare message", "something happened"],
    ["a plausible but unparsable instant", "not-a-date INFO  hello"],
    ["an unknown level", "2026-08-09T04:12:03.114Z TRACE hello"],
  ])("returns nulls for %s", (_label, line) => {
    expect(parseLine(line)).toEqual({ raw: line, at: null, level: null, msg: null });
  });

  test("preserves the raw line exactly, so nothing is lost to display", () => {
    const line = "  2026-08-09T04:12:03.114Z INFO  x  ";
    expect(parseLine(line).raw).toBe(line);
  });

  test("keeps two spaces inside a message that no field could follow", () => {
    // Only a `k=` after the gap starts the field tail, so ordinary double
    // spacing in a message survives.
    const line = formatLine("info", AT, "quota poll  finished", undefined, false);
    expect(parseLine(line).msg).toBe("quota poll  finished");
  });

  test("truncates a message that itself contains a field-shaped gap", () => {
    // The rendered format cannot distinguish this from a real field tail. It is
    // acceptable because every message here is a fixed literal without `=`, and
    // `msg` only ever drives display and filtering — `raw` keeps the whole line.
    const line = formatLine("info", AT, "parsed reason=x", undefined, false).replace(
      "parsed reason",
      "parsed  reason",
    );
    const parsed = parseLine(line);
    expect(parsed.msg).toBe("parsed");
    expect(parsed.raw).toContain("reason=x");
  });
});
