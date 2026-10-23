import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../apps/dashboard");
test("dashboard dev and preview run native Bun with no Vite dependency or config", async () => {
  const pkg = await Bun.file(resolve(root, "package.json")).json();
  expect(pkg.scripts.dev).toBe("bun tooling/serve.ts");
  expect(pkg.scripts.preview).toBe("bun tooling/serve.ts --preview");
  for (const name of ["vite", "@vitejs/plugin-react"]) {
    expect(pkg.devDependencies[name]).toBeUndefined();
    expect(() => Bun.resolveSync(name, root)).toThrow();
  }
  expect(await Bun.file(resolve(root, "vite.config.ts")).exists()).toBe(false);
  expect(await Bun.file(resolve(root, "src/vite-env.d.ts")).exists()).toBe(false);
});
