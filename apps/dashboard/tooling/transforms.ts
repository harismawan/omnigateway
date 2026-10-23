import { dirname, join, resolve } from "node:path";
import { type TransformOptions, transformAsync } from "@babel/core";
import { Generator, getConfig } from "@tanstack/router-generator";
// Public hook facade only: this export uses unplugin, not the Vite runtime.
import { tanstackRouter } from "@tanstack/router-plugin/vite";

type Pattern = string | RegExp | Pattern[];
type Filter = Pattern | { include?: Pattern; exclude?: Pattern };
interface TransformHook {
  filter?: { id?: Filter; code?: Filter };
  handler: (code: string, id: string) => unknown;
}
interface RouterHook {
  name: string;
  config?: () => unknown;
  configResolved?: (config: { root: string; command: "build"; plugins: RouterHook[] }) => unknown;
  transform?: TransformHook;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pattern(value: unknown): value is Pattern {
  return (
    typeof value === "string" ||
    value instanceof RegExp ||
    (Array.isArray(value) && value.every(pattern))
  );
}

function filter(value: unknown): value is Filter {
  return (
    pattern(value) ||
    (object(value) &&
      (value.include === undefined || pattern(value.include)) &&
      (value.exclude === undefined || pattern(value.exclude)))
  );
}

/** Deliberately only the public hook shapes of pinned router-plugin 1.168.37. */
export function routerHooks(value: unknown): RouterHook[] {
  const hooks: RouterHook[] = [];
  function add(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) add(child);
      return;
    }
    if (
      !object(value) ||
      typeof value.name !== "string" ||
      (value.config !== undefined && typeof value.config !== "function") ||
      (value.configResolved !== undefined && typeof value.configResolved !== "function")
    ) {
      throw new Error("Unsupported TanStack public build hook shape");
    }
    if (value.transform !== undefined) {
      const hook = value.transform;
      if (
        !object(hook) ||
        typeof hook.handler !== "function" ||
        (hook.filter !== undefined &&
          (!object(hook.filter) ||
            (hook.filter.id !== undefined && !filter(hook.filter.id)) ||
            (hook.filter.code !== undefined && !filter(hook.filter.code))))
      ) {
        throw new Error(`Unsupported TanStack transform hook: ${value.name}`);
      }
    }
    // Function signatures are the pinned public adapter contract; all runtime shapes above checked.
    hooks.push(value as unknown as RouterHook);
  }
  add(value);
  return hooks;
}

function matches(pattern: Pattern, text: string): boolean {
  if (Array.isArray(pattern)) return pattern.some((item) => matches(item, text));
  if (typeof pattern === "string") return text.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function accepts(filter: Filter | undefined, text: string): boolean {
  if (filter === undefined) return true;
  if (pattern(filter)) return matches(filter, text);
  return (
    (filter.include === undefined || matches(filter.include, text)) &&
    (filter.exclude === undefined || !matches(filter.exclude, text))
  );
}

export async function createTransforms(root: string) {
  // The Vite generator hook logs and swallows errors. Run the framework's public generator
  // first, without that catch, even if a previously generated route tree already exists.
  await new Generator({ root, config: getConfig({ target: "react" }, root) }).run();
  const hooks = routerHooks(tanstackRouter({ target: "react", autoCodeSplitting: true }));
  const define: Record<string, string> = {};
  for (const hook of hooks) {
    const config = await hook.config?.();
    if (object(config) && object(config.define)) {
      for (const [key, value] of Object.entries(config.define)) {
        if (typeof value !== "string") throw new Error(`Unsupported TanStack define: ${key}`);
        define[key] = value;
      }
    }
    await hook.configResolved?.({ root, command: "build", plugins: hooks });
  }

  async function transform(code: string, id: string): Promise<string> {
    const filename = id.split("?")[0];
    if (!filename) throw new Error(`Missing physical filename: ${id}`);
    let inputSourceMap: TransformOptions["inputSourceMap"];
    try {
      for (const hook of hooks) {
        const current = hook.transform;
        if (!current || !accepts(current.filter?.id, id) || !accepts(current.filter?.code, code))
          continue;
        const result = await current.handler(code, id);
        if (result === null || result === undefined) continue;
        if (!object(result) || typeof result.code !== "string") {
          throw new Error(`Unsupported TanStack transform result: ${hook.name}`);
        }
        code = result.code;
        if (result.map !== undefined && result.map !== null) {
          const map = result.map;
          if (
            !object(map) ||
            typeof map.version !== "number" ||
            typeof map.mappings !== "string" ||
            !Array.isArray(map.sources) ||
            !map.sources.every((source: unknown) => typeof source === "string") ||
            !Array.isArray(map.names) ||
            !map.names.every((name: unknown) => typeof name === "string")
          )
            throw new Error(`Unsupported TanStack source map: ${hook.name}`);
          inputSourceMap = {
            version: map.version,
            mappings: map.mappings,
            sources: map.sources,
            names: map.names,
            file: filename,
          };
          if (
            Array.isArray(map.sourcesContent) &&
            map.sourcesContent.every((source: unknown) => typeof source === "string")
          ) {
            inputSourceMap.sourcesContent = map.sourcesContent;
          }
        }
      }
      const result = await transformAsync(code, {
        filename,
        babelrc: false,
        configFile: false,
        inputSourceMap,
        sourceMaps: "inline",
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [
          [
            import.meta.resolve("babel-plugin-styled-components"),
            { displayName: true, ssr: false },
          ],
        ],
      });
      if (!result?.code) throw new Error("Babel returned no transformed source");
      return result.code;
    } catch (error) {
      throw new Error(
        `Dashboard transform failed: ${filename}\n${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const plugin: Bun.BunPlugin = {
    name: "dashboard-framework-transforms",
    setup(build) {
      build.onResolve({ filter: /\?tsr-(split|shared)=/ }, (args) => ({
        path: resolve(dirname(args.importer.split("?")[0] ?? args.importer), args.path),
      }));
      build.onLoad({ filter: /\.[jt]sx?(?:\?.*)?$/ }, async (args) => {
        if (!args.path.startsWith(`${join(root, "src")}/`)) return;
        const filename = args.path.split("?")[0];
        if (!filename) throw new Error(`Missing physical filename: ${args.path}`);
        return {
          contents: await transform(await Bun.file(filename).text(), args.path),
          loader: "tsx",
        };
      });
    },
  };
  return { plugin, define, transform, hooks };
}
