/**
 * Every token `codecIoFree.test.ts` scans for, in one file nothing imports.
 *
 * It exists to prove the scanner fires. Each assertion there is "this list is
 * empty", which is also what a scanner that read nothing reports — and the
 * repository's own source cannot serve as the control, because boundary rule 8
 * sends every outbound request through `HttpClient` so `fetch(` appears in no
 * production file.
 *
 * **All five, not one.** An earlier control proved only `import(` and leaned on
 * the tokens sharing a loop, which is an argument about the implementation
 * rather than a measurement of it — and it left the two the docblock singles out
 * as mattering most, `fetch(` and `new Request(`, unproven.
 *
 * Never imported by production code. `dead-exports` skips it because nothing
 * here is exported.
 */
async function leak(): Promise<unknown> {
  const socket = new WebSocket("wss://example.test");
  // Read off `globalThis` rather than constructed: `XMLHttpRequest` is not in
  // Bun's lib, so `new XMLHttpRequest()` fails `bun run typecheck` — measured.
  // The scanner matches the token, and a fixture that does not compile is one
  // the next contributor deletes rather than fixes.
  const xhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  const echo = new Request("https://example.test");
  const lazy = await import("node:os");
  const answer = await fetch("https://example.test");
  return [socket, xhr, echo, lazy, answer];
}

void leak;
