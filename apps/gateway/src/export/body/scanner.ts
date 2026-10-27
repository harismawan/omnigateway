/** No JSON.parse, recursion, or object graph proportional to JSON nodes. */
export function extractClient(
  text: string,
  signal: AbortSignal,
): {
  request: string | null;
  response: string | null;
} {
  const fields = scanFields(text, signal);
  return {
    request: fields.get("client.request") ?? null,
    response: fields.get("client.response") ?? null,
  };
}

/** Only these scalar/container spans escape the scanner; provider attempts never do. */
const WANTED = new Set([
  "requestId",
  "schemaVersion",
  "client.request",
  "client.response",
  "client.truncated",
  "client.request.omitted",
  "client.request.reason",
  "client.response.omitted",
  "client.response.reason",
]);

export function scanFields(text: string, signal: AbortSignal): Map<string, string> {
  let at = 0;
  let checked = 0;
  const fields = new Map<string, string>();
  const fail = (): never => {
    throw new Error("invalid artifact JSON");
  };
  const check = () => {
    if (at - checked >= 4096) {
      signal.throwIfAborted();
      checked = at;
    }
  };
  const space = () => {
    while (text[at] === " " || text[at] === "\n" || text[at] === "\r" || text[at] === "\t") {
      at++;
      check();
    }
  };
  const string = (key: boolean): string => {
    if (text[at++] !== '"') return fail();
    let decoded = "";
    for (;;) {
      check();
      const code = text.charCodeAt(at++);
      if (!Number.isFinite(code) || code < 32) return fail();
      if (code === 34) return decoded;
      let char = String.fromCharCode(code);
      if (code === 92) {
        const escapedChar = text[at++];
        if (escapedChar === "u") {
          const hex = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail();
          char = String.fromCharCode(Number.parseInt(hex, 16));
          at += 4;
        } else {
          const escaped: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (escapedChar === undefined || escaped[escapedChar] === undefined) return fail();
          char = escaped[escapedChar];
        }
      }
      // Long hostile keys cannot allocate unbounded auxiliary strings.
      if (key && decoded.length <= 32) decoded += char;
    }
  };
  // A byte per container, not an object per JSON node. Maximum possible depth
  // is half the input length; the byte packs grammar state, kind, and the
  // handful of paths we care about. Even 100,000 nesting levels stay small.
  const paths = ["-", "", "client", ...WANTED];
  const stack = new Uint8Array(Math.floor(text.length / 2) + 1);
  let depth = 0;
  const active = new Map<string, { start: number; depth: number }>();
  const complete = () => {
    for (const [path, span] of active) {
      if (span.depth === depth) {
        fields.set(path, text.slice(span.start, at));
        active.delete(path);
      }
    }
  };
  const value = (path: string): void => {
    space();
    const start = at;
    const char = text[at];
    if (WANTED.has(path)) {
      if (fields.has(path) || active.has(path)) fail();
      active.set(path, { start, depth });
    }
    if (char === "{" || char === "[") {
      at++;
      stack[depth++] = (paths.indexOf(path) << 3) | (char === "{" ? 4 : 0);
      return;
    }
    if (char === '"') string(false);
    else if (char === "t" && text.slice(at, at + 4) === "true") at += 4;
    else if (char === "f" && text.slice(at, at + 5) === "false") at += 5;
    else if (char === "n" && text.slice(at, at + 4) === "null") at += 4;
    else {
      if (text[at] === "-") at++;
      if (text[at] === "0") at++;
      else {
        if (!(text.charCodeAt(at) >= 49 && text.charCodeAt(at) <= 57)) fail();
        while (digit(text.charCodeAt(at))) {
          at++;
          check();
        }
      }
      if (text[at] === ".") {
        at++;
        if (!digit(text.charCodeAt(at))) fail();
        while (digit(text.charCodeAt(at))) {
          at++;
          check();
        }
      }
      if (text[at] === "e" || text[at] === "E") {
        at++;
        if (text[at] === "+" || text[at] === "-") at++;
        if (!digit(text.charCodeAt(at))) fail();
        while (digit(text.charCodeAt(at))) {
          at++;
          check();
        }
      }
    }
    complete();
  };
  signal.throwIfAborted();
  space();
  if (text[at] !== "{") fail();
  value("");
  let seenClient = false;
  while (depth) {
    check();
    space();
    const frame = stack[depth - 1];
    if (frame === undefined) return fail();
    const object = (frame & 4) !== 0;
    const state = frame & 3;
    const parent = paths[frame >> 3] ?? "-";
    const close = object ? "}" : "]";
    if (state === 0 && text[at] === close) {
      at++;
      depth--;
      complete();
      continue;
    }
    if (state === 2) {
      if (text[at] === close) {
        at++;
        depth--;
        complete();
        continue;
      }
      if (text[at++] !== ",") fail();
      space();
    }
    let path = "-";
    if (object) {
      const key = string(true);
      space();
      if (text[at++] !== ":") fail();
      path = parent === "" ? key : parent === "-" ? "-" : `${parent}.${key}`;
      if (path === "client") {
        if (seenClient) fail();
        seenClient = true;
      }
      if (path !== "client" && !WANTED.has(path)) path = "-";
    }
    stack[depth - 1] = (frame & ~3) | 2;
    value(path);
  }
  space();
  signal.throwIfAborted();
  if (at !== text.length) fail();
  return fields;
}

function digit(code: number): boolean {
  return code >= 48 && code <= 57;
}
