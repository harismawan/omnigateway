import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardRoot } from "../tooling/build.ts";
import { createTransforms, routerHooks } from "../tooling/transforms.ts";

const temporary: string[] = [];
afterAll(async () => {
  for (const root of temporary) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dashboard-build-test-"));
  temporary.push(root);
  await mkdir(join(root, "src/routes"), { recursive: true });
  await mkdir(join(root, "public"));
  await symlink(join(dashboardRoot, "node_modules"), join(root, "node_modules"));
  await Bun.write(
    join(root, "src/routes/__root.tsx"),
    'import {createRootRoute} from "@tanstack/react-router"; export const Route = createRootRoute({});',
  );
  await Bun.write(
    join(root, "index.html"),
    '<html><head><link rel="icon" href="/favicon.svg"></head><body><script type="module" src="/src/main.tsx"></script></body></html>',
  );
  return root;
}

function build(root: string) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import {buildDashboard} from ${JSON.stringify(join(dashboardRoot, "tooling/build.ts"))}; await buildDashboard(${JSON.stringify(root)});`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
}

describe("public framework build adapter", () => {
  test("rejects unsupported hook shapes rather than silently skipping transforms", () => {
    expect(() => routerHooks([{ name: "bad", transform: () => null }])).toThrow(
      "Unsupported TanStack transform hook",
    );
  });

  test("keeps exact default split groups, eager gates/loaders/pending and physical styled names", async () => {
    const root = await fixture();
    const filename = join(root, "src/routes/index.tsx");
    const source = `import {createFileRoute} from '@tanstack/react-router';
import styled from 'styled-components';
const Box = styled.div\`color: red;\`;
export const Route = createFileRoute('/')({
 beforeLoad: () => 'eager-before', loader: () => 'eager-loader', pendingComponent: () => 'eager-pending',
 component: () => <Box>lazy-component</Box>, errorComponent: () => 'lazy-error', notFoundComponent: () => 'lazy-not-found'
});`;
    await Bun.write(filename, source);
    const adapter = await createTransforms(root);
    expect(adapter.hooks.map((hook) => hook.name)).toEqual([
      "tanstack:router-inline-css-defaults",
      "tanstack:router-generator",
      "tanstack-router:code-splitter:compile-reference-file",
      "tanstack-router:code-splitter:compile-virtual-file",
      "tanstack-router:code-splitter:compile-shared-file",
    ]);
    const eager = await adapter.transform(source, filename);
    const imports = new Bun.Transpiler({ loader: "tsx" })
      .scanImports(eager)
      .filter((entry) => entry.kind === "dynamic-import");
    expect(imports.map((entry) => entry.path.split("?tsr-split=")[1]).sort()).toEqual([
      "component",
      "errorComponent",
      "notFoundComponent",
    ]);
    for (const value of ["eager-before", "eager-loader", "eager-pending"])
      expect(eager).toContain(value);
    for (const value of ["lazy-component", "lazy-error", "lazy-not-found"])
      expect(eager).not.toContain(value);
    const split = await adapter.transform(source, `${filename}?tsr-split=component`);
    expect(split).toContain('displayName: "routes__Box"');
    expect(split).not.toContain("eager-before");
  });

  test("fails production generation nonzero even with a stale route tree", async () => {
    const root = await fixture();
    await cp(join(dashboardRoot, "shared"), join(root, "shared"), { recursive: true });
    await Bun.write(join(root, "public/favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    // Deliberately do not import the routes: a missing generator guard must not
    // be masked by the bundler discovering the invalid route independently.
    await Bun.write(join(root, "src/main.tsx"), 'document.body.dataset.smoke = "built";');
    await Bun.write(
      join(root, "src/routes/index.tsx"),
      'import {createFileRoute} from "@tanstack/react-router"; export const Route = createFileRoute("/")({});',
    );
    const valid = build(root);
    expect(valid.exitCode).toBe(0);
    expect(await Bun.file(join(root, "dist/shared/react.js")).exists()).toBe(true);
    const staleTree = await Bun.file(join(root, "src/routeTree.gen.ts")).text();
    expect(staleTree).toContain("index");
    await Bun.write(
      join(root, "src/routes/index.tsx"),
      "export const Route = !!! invalid route source",
    );
    const result = build(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("index.tsx");
    expect(await Bun.file(join(root, "src/routeTree.gen.ts")).text()).toBe(staleTree);
  });

  test("fails production transforms nonzero with physical filename and source location", async () => {
    const root = await fixture();
    await Bun.write(join(root, "src/main.tsx"), 'import "./Broken.tsx";');
    await Bun.write(
      join(root, "src/Broken.tsx"),
      "const ok = 1;\nexport const Broken = <div>;</span>;",
    );
    const result = build(root);
    expect(result.exitCode).not.toBe(0);
    const diagnostics = result.stderr.toString();
    expect(diagnostics).toContain(join(root, "src/Broken.tsx"));
    expect(diagnostics).toContain("(2:");
    expect(diagnostics).toContain("Dashboard transform failed");
  });
});
