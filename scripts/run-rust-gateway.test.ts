import { expect, test } from "bun:test";
import { join } from "node:path";

test("Rust launcher defaults to immediate purge and preserves explicit overrides", async () => {
  const launcher = join(import.meta.dir, "run-rust-gateway.sh");
  for (const [override, expected] of [
    [undefined, "0"],
    ["1", "1"],
    ["0", "0"],
  ] as const) {
    const child = Bun.spawn(
      ["sh", launcher, "-c", 'printf "%s:%s" "$MIMALLOC_PURGE_DELAY" "$1"', "_", "argument"],
      {
        env: {
          OMNI_RUST_BINARY: "/bin/sh",
          ...(override === undefined ? {} : { MIMALLOC_PURGE_DELAY: override }),
        },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    expect(await new Response(child.stdout).text()).toBe(`${expected}:argument`);
    expect(await child.exited).toBe(0);
  }
});
