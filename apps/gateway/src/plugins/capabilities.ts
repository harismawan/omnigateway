import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * A plugin's own directory, and nothing else.
 *
 * A lexical check catches `..` and absolute paths before any I/O; a walk to the
 * deepest existing ancestor catches a symlink, which string arithmetic cannot
 * see. Both reads and writes go through the same resolution — see
 * `resolveInside` for why that symmetry is the whole point.
 *
 * Related in spirit to the static file server's resolve-then-compare in
 * `app.ts`, but deliberately not shared with it: that one only ever reads an
 * existing file, so it can resolve the target directly. This surface creates
 * files, which is exactly where the harder case lives.
 */
export type PluginFiles = {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
};

/**
 * Resolves a plugin-supplied path inside `root`, or throws.
 *
 * One path for reads and writes, deliberately. The earlier version skipped
 * symlink resolution entirely for writes — on the reasoning that `realpath`
 * fails on a file that does not exist yet — and the result was that a plugin
 * could overwrite a file *through* a symlink it could not read back through.
 * That asymmetry is worse than either behaviour on its own, and it held while a
 * test named "a symlink pointing out of the root is refused" passed, because
 * that test only exercised `read`.
 *
 * The fix is to resolve the deepest ancestor that actually exists. For an
 * existing target that is the target, so a symlinked file is caught. For a new
 * file it is the parent, so a symlinked directory is caught. Anything below the
 * deepest existing ancestor is created by `mkdir` as a real directory, so there
 * is nothing left for a link to hide in.
 */
async function resolveInside(root: string, path: string): Promise<string> {
  const rootReal = await realpath(root);
  const target = resolve(rootReal, path);
  const inside = (candidate: string): boolean =>
    candidate === rootReal || candidate.startsWith(`${rootReal}${sep}`);

  // Lexical first: cheap, and it produces the comprehensible message. It cannot
  // see a symlink, which is what the walk below is for.
  if (!inside(target)) throw new Error(`path is outside the plugin directory: ${path}`);

  let probe = target;
  for (;;) {
    try {
      if (!inside(await realpath(probe))) {
        throw new Error(`path is outside the plugin directory: ${path}`);
      }
      return target;
    } catch (error) {
      if (error instanceof Error && error.message.includes("outside")) throw error;
      const parent = dirname(probe);
      // The root itself always exists and was resolved above, so this terminates
      // there rather than walking to the filesystem root.
      if (parent === probe || probe === rootReal) return target;
      probe = parent;
    }
  }
}

export function createPluginFiles(root: string): PluginFiles {
  return {
    async read(path) {
      const target = await ensureRootThen(root, () => resolveInside(root, path));
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
      const target = await ensureRootThen(root, () => resolveInside(root, path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async exists(path) {
      const target = await ensureRootThen(root, () => resolveInside(root, path));
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
 * How long a plugin's outbound request may hang before it is abandoned.
 *
 * Without this a third-party host that accepts a connection and never answers
 * holds the plugin's promise for the life of the process. Generous, because the
 * point is to bound a hang rather than to enforce a latency budget: a plugin
 * fetching a slow asset over a bad link should still succeed.
 */
const PLUGIN_FETCH_TIMEOUT_MS = 30_000;

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
  deps: { fetchImpl?: PluginFetch; timeoutMs?: number } = {},
): PluginFetch {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  // Normalised through `URL` so a declared "https://host/" and a requested
  // "https://host" compare equal without either side being trimmed at parse.
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));

  const timeoutMs = deps.timeoutMs ?? PLUGIN_FETCH_TIMEOUT_MS;

  return async (url, init) => {
    const parsed = new URL(url);
    if (!allowed.has(parsed.origin)) {
      throw new Error(`origin ${parsed.origin} is not in the allowlist`);
    }
    // A plugin's own signal is honoured rather than replaced: it may be
    // cancelling for its own reasons, and the timeout is a ceiling on top of
    // that rather than a substitute for it.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      init?.signal === undefined || init.signal === null
        ? timeout
        : AbortSignal.any([init.signal, timeout]);
    return fetchImpl(url, { ...init, redirect: "manual", signal });
  };
}
