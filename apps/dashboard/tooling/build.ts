import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_IMPORTS, sharedEntryName } from "../shared/manifest.ts";
import { createTransforms } from "./transforms.ts";

export const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = { "process.env.NODE_ENV": '"production"' };

async function checkedBuild(config: Bun.BuildConfig): Promise<void> {
  const result = await Bun.build(config);
  if (!result.success) throw new AggregateError(result.logs, "Dashboard build failed");
}

export async function buildShared(
  root = dashboardRoot,
  outdir = join(root, "dist/shared"),
): Promise<void> {
  await rm(outdir, { recursive: true, force: true });
  // One graph, never separate entry builds: every consumer shares React and SDK contexts.
  await checkedBuild({
    root: join(root, "shared"),
    entrypoints: Object.values(SHARED_IMPORTS).map((url) =>
      join(root, "shared", `${sharedEntryName(url)}.ts`),
    ),
    outdir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    jsx: { development: false },
    define: production,
    naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].[ext]" },
  });
}

export async function buildDashboard(
  root = dashboardRoot,
  dist = join(root, "dist"),
): Promise<void> {
  const transforms = await createTransforms(root);
  await rm(dist, { recursive: true, force: true });
  await cp(join(root, "public"), dist, { recursive: true });
  const source = await Bun.file(join(root, "index.html")).text();
  const favicon = source.match(/<link\b[^>]*href="\/favicon.svg"[^>]*>/)?.[0];
  if (!favicon) throw new Error("Dashboard source HTML is missing its stable favicon");
  const html = source
    .replace(favicon, "")
    .replace('src="/src/main.tsx"', 'src="./src/main.tsx"')
    .replace(
      "<head>",
      `<head><script type="importmap">${JSON.stringify({ imports: SHARED_IMPORTS })}</script>`,
    );
  const fonts = new Map<string, Uint8Array>();
  const assets: Bun.BunPlugin = {
    name: "dashboard-html-and-assets",
    setup(build) {
      build.onLoad({ filter: /\/index\.html$/ }, () => ({ contents: html, loader: "html" }));
      // Bun otherwise embeds WOFF2 as data URLs, even with a file loader.
      build.onResolve({ filter: /\.woff2$/ }, async (args) => {
        const filename = resolve(args.resolveDir, args.path);
        const bytes = new Uint8Array(await Bun.file(filename).arrayBuffer());
        const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
        const name = `${basename(filename, ".woff2")}-${hash}.woff2`;
        fonts.set(name, bytes);
        return { path: `/assets/${name}`, external: true };
      });
      build.onResolve({ filter: /^use-sync-external-store(?:\/.*)?$/ }, (args) => {
        if (/^use-sync-external-store\/(?:shim\/)?with-selector(?:\.js)?$/.test(args.path)) {
          return { path: join(root, "src/shims/use-sync-external-store-with-selector.ts") };
        }
        if (/^use-sync-external-store(?:\/shim)?(?:\/index)?(?:\.js)?$/.test(args.path)) {
          return { path: join(root, "src/shims/use-sync-external-store.ts") };
        }
      });
    },
  };
  await checkedBuild({
    root,
    entrypoints: [join(root, "index.html")],
    outdir: dist,
    publicPath: "/",
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    jsx: { development: false },
    define: { ...transforms.define, ...production },
    external: Object.keys(SHARED_IMPORTS),
    plugins: [assets, transforms.plugin],
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
  });
  await mkdir(join(dist, "assets"), { recursive: true });
  for (const [name, bytes] of fonts) await Bun.write(join(dist, "assets", name), bytes);
  const output = Bun.file(join(dist, "index.html"));
  // Bun hoists the deferred module into head. Keep its original position after the
  // synchronous localStorage theme bootstrap as well as preserving execution order.
  let builtHtml = await output.text();
  const module = builtHtml.match(/<script type="module"[^>]*><\/script>/)?.[0];
  if (!module) throw new Error("Dashboard HTML build emitted no module script");
  builtHtml = builtHtml
    .replace(module, "")
    .replace("</head>", `${favicon}</head>`)
    .replace("</body>", `${module}</body>`);
  await Bun.write(output, builtHtml);
  await buildShared(root, join(dist, "shared"));
}

if (import.meta.main) {
  if (process.argv.includes("--shared")) await buildShared();
  else await buildDashboard();
}
