import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * A plugin's own directory, and nothing else.
 *
 * Two checks, because either alone is bypassable. The lexical one catches `..`
 * and absolute paths before any I/O happens. The realpath one catches a symlink
 * whose text contains neither — the case string arithmetic cannot see, and the
 * reason the static file server in `app.ts` resolves before it compares. This is
 * the same guard in the same shape; it is duplicated in behaviour rather than
 * shared only because the two operate on different roots at different times.
 */
export type PluginFiles = {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
};

/**
 * Resolves a plugin-supplied path inside `root`, or throws.
 *
 * `checkLink` is false for a write to a path that does not exist yet: realpath
 * fails on a missing file, so the parent directory is what gets resolved.
 */
async function resolveInside(root: string, path: string, checkLink: boolean): Promise<string> {
  const rootReal = await realpath(root);
  const target = resolve(rootReal, path);
  const inside = (candidate: string): boolean =>
    candidate === rootReal || candidate.startsWith(`${rootReal}${sep}`);

  if (!inside(target)) throw new Error(`path is outside the plugin directory: ${path}`);
  if (!checkLink) return target;

  try {
    // The link may or may not exist. If it does, where it actually lands is the
    // only thing that matters.
    const real = await realpath(target);
    if (!inside(real)) throw new Error(`path is outside the plugin directory: ${path}`);
    return real;
  } catch (error) {
    if (error instanceof Error && error.message.includes("outside")) throw error;
    return target;
  }
}

export function createPluginFiles(root: string): PluginFiles {
  return {
    async read(path) {
      const target = await ensureRootThen(root, () => resolveInside(root, path, true));
      try {
        const data = await readFile(target);
        return new Uint8Array(data);
      } catch {
        // A miss is the normal case for a cache, and after a restore every file
        // is a miss. Reporting it as an error would make self-healing look like
        // corruption.
        return null;
      }
    },
    async write(path, data) {
      const target = await ensureRootThen(root, () => resolveInside(root, path, false));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async exists(path) {
      const target = await ensureRootThen(root, () => resolveInside(root, path, true));
      try {
        await readFile(target);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The root has to exist before it can be resolved, and a plugin's first call is a write. */
async function ensureRootThen<T>(root: string, then: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  return then();
}

export type PluginFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetch`, bound to the origins the manifest declared.
 *
 * Origin equality, never a prefix or suffix compare: under `endsWith`,
 * `pokeapi.co.evil.example` passes, and that is the whole attack. Scheme and
 * port are part of an origin, so an http downgrade and a different port are both
 * different trust decisions than the one the operator read.
 *
 * Redirects are not followed. Following them would let one allowed origin hand
 * the plugin any origin at all, which turns the manifest from an enforced
 * allowlist into a suggestion. The redirect response is returned as-is so a
 * plugin that genuinely needs the hop can declare that origin too.
 *
 * As with every capability here: this constrains honest code. A plugin shares
 * the process and can call global `fetch`. The value is that an operator reading
 * one file learns which hosts a well-behaved plugin contacts.
 */
export function createPluginFetch(
  origins: readonly string[],
  deps: { fetchImpl?: PluginFetch } = {},
): PluginFetch {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  // Normalised through `URL` so a declared "https://host/" and a requested
  // "https://host" compare equal without either side being trimmed at parse.
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));

  return async (url, init) => {
    const parsed = new URL(url);
    if (!allowed.has(parsed.origin)) {
      throw new Error(`origin ${parsed.origin} is not in the allowlist`);
    }
    return fetchImpl(url, { ...init, redirect: "manual" });
  };
}
