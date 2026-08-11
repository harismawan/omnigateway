type AnchorFamily = "build-output" | "test-output";

function distinctRows(lines: readonly string[], patterns: readonly RegExp[]): Set<number> {
  const rows = new Set<number>();
  for (let index = 0; index < lines.length; index++)
    if (patterns.some((pattern) => pattern.test(lines[index] ?? ""))) rows.add(index);
  return rows;
}

export function inferBuildOrTest(lines: readonly string[]): AnchorFamily | undefined {
  const bunBuildA = distinctRows(lines, [/^\$?\s*bun (?:run|build)\b/, /^bun build v/]);
  const bunBuildB = distinctRows(lines, [
    /^(?:Bundled |Build (?:completed|failed)|\S+\.(?:js|css|map)\s+\d)/,
  ]);
  if ([...bunBuildA].some((row) => [...bunBuildB].some((other) => other !== row)))
    return "build-output";

  const cargoA = distinctRows(lines, [/^(?:Compiling |Checking |\$?\s*cargo (?:build|check)\b)/]);
  const cargoB = distinctRows(lines, [
    /^Finished .+ target/,
    /^(?:error|warning)\[[A-Z]\d+\]:/,
    /^\s*--> \S+:\d+:\d+/,
  ]);
  if ([...cargoA].some((row) => [...cargoB].some((other) => other !== row))) return "build-output";

  const compiler = distinctRows(lines, [/^\S.+:\d+:\d+.*(?:error|warning).*(?:TS\d+|[A-Z]\d+)/]);
  const buildSummary = distinctRows(lines, [
    /^(?:Build|Compilation).*(?:failed|completed|errors?)/,
  ]);
  if (
    compiler.size >= 2 ||
    [...compiler].some((row) => [...buildSummary].some((other) => other !== row))
  )
    return "build-output";

  const bunTestA = distinctRows(lines, [/^(?:bun test v|vitest|jest|PASS |FAIL |Test Files)/i]);
  const bunTestB = distinctRows(lines, [
    /^(?:\d+ (?:pass|fail)|Ran \d+ tests?|Tests?:|Test Files)/,
  ]);
  if ([...bunTestA].some((row) => [...bunTestB].some((other) => other !== row)))
    return "test-output";

  const pytestA = distinctRows(lines, [/^={2,} test session starts/, /^collected \d+ items/]);
  const pytestB = distinctRows(lines, [/^={2,} short test summary/, /\d+ (?:passed|failed|error)/]);
  if ([...pytestA].some((row) => [...pytestB].some((other) => other !== row))) return "test-output";

  const goA = distinctRows(lines, [/^=== RUN /, /^\$?\s*go test\b/]);
  const goB = distinctRows(lines, [/^--- (?:PASS|FAIL):/, /^(?:ok|FAIL)\s+\S/]);
  if ([...goA].some((row) => [...goB].some((other) => other !== row))) return "test-output";
  return undefined;
}
