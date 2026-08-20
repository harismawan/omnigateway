import { Buffer } from "node:buffer";
import { basename, join, resolve, sep } from "node:path";
import { describeError, GatewayError } from "@omni/ir";
import {
  type Capability,
  isApiCompatible,
  PLUGIN_API_VERSION,
  type PluginManifest,
  safeParseManifest,
} from "@omnigateway/plugin-api/manifest";

/**
 * Administering plugins: what is installed, whether it would load, and how one
 * gets there or leaves.
 *
 * Everything here is the operator's side of the plugin host. The gateway's
 * loader is the other side, and the two are deliberately not the same code: the
 * loader `import`s an entry point, and this module must never do that. An
 * operator running `omni plugin verify` before a production restart is asking
 * "would this load?" precisely because they are not willing to find out by
 * running it. Executing the thing under inspection would answer a different
 * question and answer it destructively.
 *
 * The consequence is that every check the loader performs before its `import`
 * is duplicated here, in the same order, with the same verdicts. That
 * duplication is the design. What is *not* duplicated is the manifest schema —
 * `safeParseManifest` is imported, because a second validator would be a second
 * set of rules and the whole value of `verify` is that it agrees with the host.
 */

/** Where an installation keeps its plugins. One directory per plugin, named by its id. */
export const PLUGINS_DIRNAME = "plugins";

export function pluginsDir(root: string): string {
  return join(root, PLUGINS_DIRNAME);
}

/** The manifest filename, matching the loader's. */
export const MANIFEST_FILENAME = "omni-plugin.json";

/**
 * A ceiling on what one plugin may unpack to.
 *
 * A tarball is compressed and an installer that trusts the declared sizes in it
 * will happily write a hundred gigabytes off a two-kilobyte file. Plugins are a
 * manifest, a server bundle, and a UI bundle; nothing legitimate is close to
 * this. Checked while unpacking into memory, so the refusal costs no disk.
 */
export const MAX_PLUGIN_BYTES = 32 * 1024 * 1024;

/**
 * The id pattern, restated for the one thing the schema cannot cover.
 *
 * `safeParseManifest` already enforces it on the document. This copy judges
 * *path segments* — a directory name found by `readdir`, the root of a tarball —
 * before they are joined onto anything or handed to the store. Those never went
 * through the schema and never will, and the alternative to checking them here
 * is building a filesystem path out of an arbitrary string.
 */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** npm wraps every tarball's contents in a directory called this. It names nothing. */
const NPM_TARBALL_ROOT = "package";

/**
 * The filesystem, as this module asks for it.
 *
 * Injected for the reason `database.ts` injects its own: these tests must never
 * write outside a temp directory, and the cheapest way to guarantee that is for
 * the module to have no way of reaching a real path it was not handed. The two
 * conventions the loader relies on are honoured here too — an absent directory
 * reads as empty rather than throwing, and removing a path that is not there is
 * a no-op — so a caller never has to ask "does this exist" before asking for it.
 */
export type PluginFs = {
  /** Entry names, not paths. An absent directory reads as empty, not as an error. */
  readdir: (dir: string) => readonly string[];
  /** File contents as text, or null when there is no readable file there. */
  readText: (path: string) => string | null;
  /** File contents as bytes, or null when there is no readable file there. */
  readBytes: (path: string) => Uint8Array | null;
  writeBytes: (path: string, bytes: Uint8Array) => void;
  isDirectory: (path: string) => boolean;
  isFile: (path: string) => boolean;
  /** Creates a directory and its parents; an existing one is fine. */
  mkdir: (dir: string) => void;
  /** Removes a path and everything under it. Absent is a no-op. */
  rm: (path: string) => void;
  rename: (from: string, to: string) => void;
};

/**
 * Only the slice of `Store` a purge touches.
 *
 * A structural subset rather than `Store`, as `DatabaseStore` is: a test builds
 * one out of closures, and a real store satisfies it without being told to. It
 * is optional on the deps because every operation except `--purge` is a pure
 * filesystem question, and requiring a database to list plugins would make
 * `omni plugin list` fail on the installation whose database is the problem.
 */
export type PluginStore = {
  plugins: {
    listTables(pluginId: string): string[];
    dropAll(pluginId: string): number;
    orphanTables(installedIds: readonly string[]): string[];
  };
};

export type PluginDeps = {
  fs: PluginFs;
  /**
   * The dashboard SDK version this host ships, when the caller knows one.
   *
   * Absent means unknown, and unknown is reported as unknown — never as a pass
   * and never as a failure. `quota_windows` makes the same distinction for the
   * same reason: a verdict invented where there is no evidence is worse than no
   * verdict, because an operator acts on it.
   */
  sdkVersion?: string;
  /** Required only by `removePlugin(..., { purge: true })`. */
  store?: PluginStore;
  /**
   * How a remote install spec is fetched. Injected so no test reaches the
   * network, and absent when the caller does not intend to allow one — an
   * install from a URL then fails saying so, rather than silently working in
   * production and being untested.
   *
   * `accept` is a hint, not a contract: the npm registry serves two different
   * documents at one URL and the abbreviated one is chosen by the header, so
   * the caller that owns the transport has to be told which is wanted. It is
   * optional precisely so a fetcher may ignore it — a stub in a test does, and
   * so does any registry that only knows how to serve the full document.
   */
  fetchBytes?: (url: string, accept?: string) => Promise<Uint8Array>;
  /**
   * Where a bare package name is resolved, defaulting to `DEFAULT_NPM_REGISTRY`.
   *
   * An injected option rather than an environment read, for boundary rule 6:
   * this package must not learn what the variable is called, because the same
   * resolution is reached from a CLI flag, from an installation's `.env`, and
   * from a test that sets neither. Must be `https://`, checked before anything
   * is fetched.
   */
  registry?: string;
};

/**
 * One load-time check that did not pass.
 *
 * `fatal` is what separates a report from an opinion. The loader skips a plugin
 * over a bad manifest, a mismatched id, an incompatible `api`, or a server entry
 * it cannot reach — those are fatal. It does *not* skip a plugin whose `sdk`
 * range excludes the shipped dashboard SDK: that disables the UI and leaves the
 * server half collecting data, which is the whole point of splitting the two
 * version fields. Reporting an sdk mismatch as a failure would have an operator
 * hold a restart over a greyed-out nav entry.
 */
export type PluginProblem = {
  check: "manifest" | "id" | "api" | "entry" | "sdk";
  reason: string;
  fatal: boolean;
};

/**
 * Everything `verify` learned about one directory under `<root>/plugins`.
 *
 * `id` is the directory name rather than the manifest's, because the directory
 * name is what the gateway uses: the URL segment, the table prefix, and the log
 * field are all derived from the path. A manifest claiming otherwise is the
 * disagreement this reports, not a second candidate for the answer.
 */
export type PluginReport = {
  id: string;
  path: string;
  /** Null when the manifest could not be read or did not parse. */
  manifest: PluginManifest | null;
  problems: readonly PluginProblem[];
  /** True when nothing fatal was found: the gateway would load this. */
  loadable: boolean;
};

/** Convenience for the callers that render a list: the fields a table wants. */
export type PluginSummary = PluginReport & {
  name: string | null;
  version: string | null;
  api: number | null;
  sdk: string | null;
  capabilities: readonly Capability[];
  origins: readonly string[];
};

export type PluginInstallResult = {
  id: string;
  name: string;
  version: string;
  path: string;
  /** True when an install of the same id was replaced rather than created. */
  replaced: boolean;
  /**
   * Always true, and returned rather than assumed. Plugins are `import`ed once
   * at boot and their routes are mounted into the Elysia tree at construction,
   * so nothing about an installed plugin reaches a running gateway until it
   * starts again. A caller that forgets to say so leaves an operator watching a
   * console that will not change.
   */
  restartRequired: true;
};

export type PluginRemoveResult = {
  id: string;
  /** False when there was no directory to remove and only tables were purged. */
  removed: boolean;
  /** Table names dropped. Empty without `purge`, which is the point of `purge`. */
  droppedTables: readonly string[];
};

/* ------------------------------------------------------------------ verify */

function readManifest(fs: PluginFs, home: string): PluginManifest | PluginProblem {
  const raw = fs.readText(join(home, MANIFEST_FILENAME));
  if (raw === null) {
    return { check: "manifest", reason: `no ${MANIFEST_FILENAME}`, fatal: true };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = describeError(error, String(error));
    return {
      check: "manifest",
      reason: `${MANIFEST_FILENAME} is not valid JSON: ${detail}`,
      fatal: true,
    };
  }

  // The id pattern is inside this parse, not beside it. Restating it here would
  // be the second validator this module exists to avoid.
  const parsed = safeParseManifest(document);
  if (!parsed.ok) return { check: "manifest", reason: parsed.reason, fatal: true };
  return parsed.manifest;
}

/**
 * Whether a declared entry resolves to a real file inside the plugin directory.
 *
 * The prefix check mirrors the loader's exactly, including the fact that it is
 * lexical. Verify is the careful command and it would be easy to add a
 * `realpath` here that the loader does not perform — and then `verify` would
 * refuse a plugin the gateway loads happily, which is a worse failure than the
 * one it was added to catch. The two must agree; where the loader is lenient,
 * so is this.
 */
function checkEntry(
  fs: PluginFs,
  home: string,
  entry: string,
  label: "server" | "ui",
  fatal: boolean,
): PluginProblem | null {
  const target = resolve(home, entry);
  if (target !== home && !target.startsWith(`${home}${sep}`)) {
    return {
      check: "entry",
      reason: `${label} entry resolves outside the plugin directory`,
      fatal,
    };
  }
  if (!fs.isFile(target)) {
    return { check: "entry", reason: `${label} entry ${entry} does not exist`, fatal };
  }
  return null;
}

/**
 * Every load-time check the gateway performs, without performing the load.
 *
 * The order matches the loader's, and it matters: a manifest that will not parse
 * has no id to compare and no `api` to judge, so the first fatal problem is
 * usually the only one worth printing. They are all collected anyway, because an
 * operator fixing a plugin would rather see three problems once than one problem
 * three times.
 */
export function verifyPlugin(deps: PluginDeps, root: string, id: string): PluginReport {
  const home = join(pluginsDir(root), id);
  if (!ID_PATTERN.test(id) || !deps.fs.isDirectory(home)) {
    throw new GatewayError("BAD_REQUEST", `no plugin "${id}" installed under ${pluginsDir(root)}`);
  }
  return reportFor(deps, home, id);
}

/** The body of `verify`, shared with `list` so the two can never drift. */
function reportFor(deps: PluginDeps, home: string, id: string): PluginReport {
  const problems: PluginProblem[] = [];
  const read = readManifest(deps.fs, home);
  if (!("id" in read)) {
    problems.push(read);
    return { id, path: home, manifest: null, problems, loadable: false };
  }
  const manifest = read;

  // The directory name wins over the document, as it does in the loader. Trusting
  // the manifest would let a plugin claim another plugin's table prefix and URL
  // space merely by being unpacked beside it.
  if (manifest.id !== id) {
    problems.push({
      check: "id",
      reason: `manifest id ${manifest.id} does not match its directory ${id}`,
      fatal: true,
    });
  }

  if (!isApiCompatible(manifest)) {
    problems.push({
      check: "api",
      reason: `plugin api ${manifest.api} is not supported by this host (api ${PLUGIN_API_VERSION})`,
      fatal: true,
    });
  }

  if (manifest.server !== undefined) {
    // Fatal: the loader's `import` of a missing entry throws, and a throw at
    // that point skips the plugin.
    const problem = checkEntry(deps.fs, home, manifest.server, "server", true);
    if (problem !== null) problems.push(problem);
  }

  if (manifest.ui !== undefined) {
    // Not fatal: the server half still loads and the UI 404s. Worth saying out
    // loud all the same, because a 404 from a static route is the least legible
    // way for an operator to learn a bundle was never built.
    const problem = checkEntry(deps.fs, home, manifest.ui, "ui", false);
    if (problem !== null) problems.push(problem);
  }

  const sdk = sdkProblem(deps, manifest);
  if (sdk !== null) problems.push(sdk);

  return {
    id,
    path: home,
    manifest,
    problems,
    loadable: !problems.some((problem) => problem.fatal),
  };
}

/**
 * The UI compatibility verdict, or null when there is nothing to say.
 *
 * Null covers two different silences on purpose: a plugin with no UI, and a host
 * that cannot state its own SDK version. Neither is a pass and neither is a
 * failure, and collapsing them into `false` would report every plugin as broken
 * on a build that simply has no dashboard SDK to compare against.
 */
function sdkProblem(deps: PluginDeps, manifest: PluginManifest): PluginProblem | null {
  if (manifest.ui === undefined || manifest.sdk === undefined) return null;
  if (deps.sdkVersion === undefined) return null;
  if (Bun.semver.satisfies(deps.sdkVersion, manifest.sdk)) return null;
  return {
    check: "sdk",
    reason: `requires dashboard sdk ${manifest.sdk}, host ships ${deps.sdkVersion}`,
    fatal: false,
  };
}

/* -------------------------------------------------------------------- list */

/**
 * Every plugin directory under `<root>/plugins`, and what it would do at boot.
 *
 * Never throws over one bad plugin. An installation with a broken manifest is
 * exactly the installation whose operator is running this command, and a listing
 * that dies on the row you are looking for is the same failure `keys.list()`
 * refuses over an unreadable `limits` column: the listing is how the thing gets
 * found, so the listing has to survive it.
 *
 * Sorted lexicographically, matching the loader's own order so the two print the
 * same sequence.
 */
export function listPlugins(deps: PluginDeps, root: string): PluginSummary[] {
  const dir = pluginsDir(root);
  const summaries: PluginSummary[] = [];

  for (const entry of [...deps.fs.readdir(dir)].sort()) {
    const home = join(dir, entry);
    if (!deps.fs.isDirectory(home)) continue;

    // A directory whose name could never be a plugin id is reported rather than
    // skipped. The loader will try it and fail on the id check, so hiding it
    // here would mean `list` shows nothing while boot logs a skipped plugin.
    if (!ID_PATTERN.test(entry)) {
      summaries.push({
        id: entry,
        path: home,
        manifest: null,
        problems: [
          {
            check: "id",
            reason: `directory name ${entry} is not a valid plugin id`,
            fatal: true,
          },
        ],
        loadable: false,
        name: null,
        version: null,
        api: null,
        sdk: null,
        capabilities: [],
        origins: [],
      });
      continue;
    }

    const report = reportFor(deps, home, entry);
    const manifest = report.manifest;
    summaries.push({
      ...report,
      name: manifest?.name ?? null,
      version: manifest?.version ?? null,
      api: manifest?.api ?? null,
      sdk: manifest?.sdk ?? null,
      capabilities: manifest?.capabilities ?? [],
      origins: manifest?.origins ?? [],
    });
  }

  return summaries;
}

/* -------------------------------------------------------------- tar reading */

const BLOCK = 512;
const decoder = new TextDecoder();

function fieldText(header: Uint8Array, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function fieldOctal(header: Uint8Array, offset: number, length: number): number {
  const text = fieldText(header, offset, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

/** A path in an archive, judged before it is joined onto anything. */
function isSafeArchivePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) return false;
  if (path.includes("\\")) return false;
  return !path.split("/").includes("..");
}

/**
 * Reads a tar archive into memory, refusing anything that is not a plain file
 * tree.
 *
 * Written here rather than shelled out to `tar` for the reason `install` exists
 * at all: the promise is that installing a plugin runs no code from the package,
 * and the cheapest way to keep that promise is for the installer to have no way
 * of running anything. A subprocess would also make the deps a lie — the point
 * of injecting the filesystem is that a test cannot escape its temp directory,
 * and `tar` invoked on the archive's own paths could.
 *
 * Only ustar regular files and directories survive. A symlink or a hard link
 * ends the whole install: it is the one entry type that can point outside the
 * tree after the path check has already passed, and a plugin that needs one is a
 * plugin nobody has audited.
 *
 * pax headers (`x`, `g`) and GNU long *link* names (`K`) are skipped rather than
 * refused. bsdtar — which is `tar` on macOS — emits a pax header before every
 * entry by default, so refusing them would reject most archives built on a Mac.
 * Their metadata is ignored; the ustar header that follows carries a usable name
 * in every case this installer accepts.
 *
 * A GNU long *file* name (`L`) is the one extended header that is read rather
 * than skipped, because its ustar successor does not carry a usable name — GNU
 * writes a truncated placeholder there. The name it carries is then judged by
 * exactly the same `isSafeArchivePath` call as any other, which is the point:
 * an entry does not get a laxer path check for having arrived by a longer route.
 */
function readTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let longName: string | null = null;
  let offset = 0;

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const size = fieldOctal(header, 124, 12);
    if (size < 0) throw new GatewayError("BAD_REQUEST", "archive has an unreadable entry size");
    const type = String.fromCharCode(header[156] ?? 0);
    const name = fieldText(header, 0, 100);
    const prefix = fieldText(header, 345, 155);

    offset += BLOCK;

    // The ceiling is judged on what the header *declares*, before anything asks
    // whether those bytes are present, and it counts every entry body rather
    // than only the files that survive the filters below. Both halves matter. A
    // bomb is refused for declaring the size, so no version of it has to be read
    // to be refused; and a thousand pax headers cannot carry between them what a
    // single entry would be refused for, which counting only kept files would
    // allow. Declared sizes are also what makes this check cheap: it fires on the
    // header, not on the copy.
    total += size;
    if (total > MAX_PLUGIN_BYTES) {
      throw new GatewayError(
        "BAD_REQUEST",
        `archive unpacks to more than ${MAX_PLUGIN_BYTES} bytes`,
      );
    }

    // A short archive is a corrupt download, not a small plugin. `subarray`
    // clamps rather than throwing, so without this a truncated tarball installs
    // a truncated file and says nothing — the plugin then fails later, somewhere
    // that cannot tell a bad download from bad code. Compared unpadded: the two
    // zero blocks that close an archive are conventional, and some writers omit
    // the padding after the final entry, so requiring it would refuse archives
    // that carry every byte they promised.
    if (offset + size > bytes.length) {
      throw new GatewayError(
        "BAD_REQUEST",
        `archive is truncated: entry ${name || "(unnamed)"} declares ${size} bytes and the archive ends before them`,
      );
    }
    const data = bytes.subarray(offset, offset + size);
    // Entry bodies are padded out to a block boundary.
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (type === "1" || type === "2") {
      throw new GatewayError(
        "BAD_REQUEST",
        `archive contains a link (${name}); plugin packages must be plain files`,
      );
    }
    if (type === "L") {
      longName = decoder.decode(data).replace(/\0+$/, "");
      continue;
    }
    if (type === "K" || type === "x" || type === "g") continue;
    if (type !== "0" && type !== "\u0000") {
      // Directories ('5') and anything exotic. Directories are implied by the
      // paths of the files inside them, so nothing is lost by ignoring them.
      longName = null;
      continue;
    }

    const path = longName ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
    longName = null;
    if (!isSafeArchivePath(path)) {
      throw new GatewayError("BAD_REQUEST", `archive contains an unsafe path: ${path}`);
    }

    // Copied out of the archive buffer rather than referenced into it, so the
    // whole tarball is not held alive by one small file.
    files.set(path, new Uint8Array(data));
  }

  return files;
}

/** gzip's two magic bytes. npm tarballs are always gzipped; a bare `.tar` is not. */
function gunzipIfNeeded(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  try {
    // Copied into an array backed by a plain `ArrayBuffer`. `Bun.gunzipSync`
    // refuses a `SharedArrayBuffer`-backed view at the type level, and a
    // `Uint8Array` read off disk carries `ArrayBufferLike` — which includes one.
    return Bun.gunzipSync(new Uint8Array(bytes));
  } catch (error) {
    const detail = describeError(error, String(error));
    throw new GatewayError("BAD_REQUEST", `could not decompress the archive: ${detail}`);
  }
}

/* ----------------------------------------------------------------- install */

/** A file tree held in memory, keyed by POSIX-relative path. */
type Payload = {
  files: Map<string, Uint8Array> /** What the source calls this plugin, if anything. */;
  claimedId: string | null;
};

/**
 * Strips a single wrapping directory, and reports what it was called.
 *
 * npm's is always `package` and names nothing, so it is stripped and forgotten.
 * Anything else is the author's own directory name, and that *is* a claim about
 * the plugin's id — the claim `install` refuses to let disagree with the
 * manifest.
 */
function stripRoot(files: Map<string, Uint8Array>): Payload {
  const roots = new Set<string>();
  for (const path of files.keys()) {
    const slash = path.indexOf("/");
    // A file at the top level means there is no single wrapping directory.
    if (slash <= 0) return { files, claimedId: null };
    roots.add(path.slice(0, slash));
  }
  const [only] = [...roots];
  if (roots.size !== 1 || only === undefined) return { files, claimedId: null };

  const stripped = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) stripped.set(path.slice(only.length + 1), bytes);
  return { files: stripped, claimedId: only === NPM_TARBALL_ROOT ? null : only };
}

/** Reads a source directory into memory, so nothing is written before it is judged. */
function readTree(fs: PluginFs, dir: string, prefix = ""): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of fs.readdir(dir)) {
    const path = join(dir, entry);
    const relative = prefix.length === 0 ? entry : `${prefix}/${entry}`;
    if (fs.isDirectory(path)) {
      for (const [nested, bytes] of readTree(fs, path, relative)) files.set(nested, bytes);
      continue;
    }
    const bytes = fs.readBytes(path);
    // Sockets, fifos, and a file swept between the listing and the read. Not
    // part of the plugin either way.
    if (bytes === null) continue;
    total += bytes.byteLength;
    if (total > MAX_PLUGIN_BYTES) {
      throw new GatewayError("BAD_REQUEST", `${dir} holds more than ${MAX_PLUGIN_BYTES} bytes`);
    }
    files.set(relative, bytes);
  }
  return files;
}

/* ------------------------------------------------------------ npm registry */

/** Where a bare package name resolves when the caller names no registry. */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * What the packument request asks for.
 *
 * The abbreviated document is a different document, not a truncated one: it
 * drops READMEs and maintainer records and keeps `dist-tags`, `versions`, and
 * every `dist` field this resolver reads. Asking for it is the difference
 * between a few kilobytes and several megabytes on a popular name. The full
 * document is accepted too — every field read below is present in both — so a
 * registry that has never heard of the abbreviated type still works.
 */
export const NPM_PACKUMENT_ACCEPT =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

/**
 * An npm package name, and the version the operator typed after it.
 *
 * Lowercase only, which is stricter than the registry's own rule for names
 * published before it tightened. That is deliberate: this pattern is the gate
 * between "this is a package name" and "this is a path that does not exist",
 * and a mistyped path should get the path error rather than a 404 from a
 * registry it was never meant to reach. Nothing that carries a `/` outside a
 * scope, a leading dot, or a backslash can pass, so no spec that is really a
 * filesystem path resolves as a name.
 */
const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * An exact version, and only an exact version.
 *
 * `^1.2.3`, `~1.2`, `1.x`, `*`, and a dist-tag like `next` are all refused by
 * this, and the refusal is the feature. Resolving any of them means comparing a
 * range against every version in the packument, which is a semver resolver —
 * something this project does not have and should not grow inside an installer.
 * `Bun.semver` could satisfy a range, but choosing the *best* match from a set,
 * with prerelease rules, is the part that is not one call. Refusing names what
 * is accepted, so the operator's next command is the right one.
 */
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/** Hashes an SRI string may name that this installer knows how to compute. */
const SRI_ALGORITHMS = ["sha512", "sha384", "sha256"] as const;
type SriAlgorithm = (typeof SRI_ALGORITHMS)[number];

type NpmSpec = { name: string; version: string | null };

/** The `dist` block, narrowed to the three fields that decide anything. */
type NpmDist = { tarball: string; integrity: string | null; shasum: string | null };

/** One hash to check the downloaded bytes against, expected value in hex. */
type Digest = { algorithm: SriAlgorithm | "sha1"; expected: string; source: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Splits `<name>` or `<name>@<version>`, or returns null for anything that is
 * not a package name at all.
 *
 * The two `@` characters in `@scope/name@1.2.3` mean different things and the
 * split is `lastIndexOf`, never `indexOf`. A scope's `@` is at index 0 and is
 * part of the name, which is exactly why the guard is `at <= 0` rather than
 * `at === -1`: `@scope/name` with no version has its only `@` at 0, and reading
 * that as a separator would ask the registry for the empty package and call
 * `scope/name` a version.
 */
function parseNpmSpec(spec: string): NpmSpec | null {
  const at = spec.lastIndexOf("@");
  const name = at <= 0 ? spec : spec.slice(0, at);
  const version = at <= 0 ? null : spec.slice(at + 1);
  // 214 is the registry's own ceiling, scope included.
  if (name.length > 214 || !NPM_NAME_PATTERN.test(name)) return null;
  return { name, version };
}

/**
 * The registry to talk to, refused here rather than at the socket.
 *
 * Plaintext is refused for the reason the `http://` spec is: a packument
 * arriving over plaintext chooses both the tarball URL and the digest it will
 * be checked against, so an attacker on that wire picks what the gateway
 * imports and then certifies it. Checked before any request is made, so a
 * misconfigured registry costs nothing and leaks nothing.
 */
function registryUrl(deps: PluginDeps): URL {
  const raw = deps.registry ?? DEFAULT_NPM_REGISTRY;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayError("BAD_REQUEST", `registry ${raw} is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new GatewayError(
      "BAD_REQUEST",
      `plugins may only be installed over https; ${raw} is not`,
    );
  }
  return url;
}

/**
 * Where the packument lives.
 *
 * A scope's slash is percent-encoded rather than left as a path separator: it
 * is one path segment on the registry, and leaving it raw would also be the
 * only way a name could reach outside the registry's package space. The name
 * has already passed `NPM_NAME_PATTERN`, so there is nothing else in it to
 * encode; this is belt and braces on the one character that pattern allows.
 */
function packumentUrl(registry: URL, name: string): string {
  return `${registry.href.replace(/\/+$/, "")}/${name.replace("/", "%2f")}`;
}

/** Reads the one version's `dist` block out of whatever the registry served. */
function resolveDist(document: unknown, spec: NpmSpec): { version: string; dist: NpmDist } {
  const root = asRecord(document);
  if (root === null) {
    throw new GatewayError(
      "BAD_REQUEST",
      `the registry's answer for ${spec.name} is not a package`,
    );
  }
  const versions = asRecord(root.versions);
  if (versions === null) {
    throw new GatewayError("BAD_REQUEST", `the registry lists no versions of ${spec.name}`);
  }

  let wanted = spec.version;
  if (wanted === null) {
    // No version means the tag npm itself defaults to. Only `latest`: any other
    // tag is a moving name that would have to be typed, and typing one is the
    // range case this installer refuses.
    const tags = asRecord(root["dist-tags"]);
    wanted = tags === null ? null : asString(tags.latest);
    if (wanted === null) {
      throw new GatewayError(
        "BAD_REQUEST",
        `the registry names no dist-tags.latest for ${spec.name}; install ${spec.name}@<exact version>`,
      );
    }
  }

  const entry = asRecord(versions[wanted]);
  if (entry === null) {
    throw new GatewayError("BAD_REQUEST", `the registry has no version ${wanted} of ${spec.name}`);
  }
  const dist = asRecord(entry.dist);
  const tarball = dist === null ? null : asString(dist.tarball);
  if (dist === null || tarball === null) {
    throw new GatewayError(
      "BAD_REQUEST",
      `the registry's entry for ${spec.name}@${wanted} names no tarball`,
    );
  }
  return {
    version: wanted,
    dist: { tarball, integrity: asString(dist.integrity), shasum: asString(dist.shasum) },
  };
}

/**
 * Judges the advertised tarball URL against the registry that advertised it.
 *
 * **The host is pinned to the registry's.** A packument is a document that
 * names the URL its own bytes will be fetched from, so an off-host `tarball` is
 * an origin chosen by whoever served that document — and the fetcher follows
 * redirects, so leaving the choice open would let a mirror aim the install at
 * anything and the request would go there before any digest was consulted.
 * Pinning does not make the bytes trustworthy; the digest does that. It bounds
 * *where the gateway is made to connect*, which the digest cannot.
 *
 * The cost is real and is accepted: a registry that proxies another one's
 * tarballs by URL rather than by mirroring them will be refused. That operator
 * still has `omni plugin install https://<that host>/<tarball>`, which is the
 * same install with the origin typed by the person who chose it instead of by
 * the document. Port is part of `host`, so a private registry on `:4873` serves
 * its own tarballs from `:4873` and nothing else.
 */
function checkTarballUrl(tarball: string, registry: URL, what: string): void {
  let url: URL;
  try {
    url = new URL(tarball);
  } catch {
    throw new GatewayError("BAD_REQUEST", `the registry gave ${what} a tarball that is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new GatewayError(
      "BAD_REQUEST",
      `plugins may only be installed over https; the registry points ${what} at ${tarball}`,
    );
  }
  if (url.host !== registry.host) {
    throw new GatewayError(
      "BAD_REQUEST",
      `registry ${registry.host} points ${what} at ${url.host}; ` +
        "install that URL directly if it is the one you meant",
    );
  }
}

/**
 * Every hash the packument advertised, or a refusal when it advertised none.
 *
 * Computed *before* the tarball is fetched, so a package that cannot be checked
 * is refused without downloading it. Absent metadata is refused rather than
 * shrugged at: these bytes become a module the gateway process `import`s, and
 * "the registry did not say" is not a reason to run something — it is the exact
 * state a mirror stripping its own metadata would produce.
 *
 * `integrity` wins when it is present and names an algorithm this can compute.
 * `shasum` is a sha1 and is the fallback rather than the equal, because it is
 * all the registry has for packages published before SRI existed; a registry
 * that omits `integrity` has already chosen sha1 for us either way, so refusing
 * it here would buy nothing and would refuse real packages.
 */
function digestsFor(dist: NpmDist, what: string): Digest[] {
  const digests: Digest[] = [];
  if (dist.integrity !== null) {
    // SRI allows several, whitespace separated. Any one matching is a pass, per
    // the spec: they are alternatives, not a set that must all hold.
    for (const entry of dist.integrity.trim().split(/\s+/)) {
      const dash = entry.indexOf("-");
      const algorithm = dash === -1 ? "" : entry.slice(0, dash);
      const value = dash === -1 ? "" : entry.slice(dash + 1);
      if (value.length === 0) continue;
      const known = SRI_ALGORITHMS.find((candidate) => candidate === algorithm);
      // An unknown algorithm is skipped rather than refused *here*: it may sit
      // beside one that is known, and the empty-list refusal below catches the
      // case where it does not. A `md5-` on its own therefore still refuses.
      if (known === undefined) continue;
      digests.push({
        algorithm: known,
        expected: Buffer.from(value, "base64").toString("hex"),
        source: `${known} integrity`,
      });
    }
  }
  if (digests.length === 0 && dist.shasum !== null && /^[0-9a-f]{40}$/i.test(dist.shasum)) {
    digests.push({ algorithm: "sha1", expected: dist.shasum.toLowerCase(), source: "sha1 shasum" });
  }
  if (digests.length === 0) {
    throw new GatewayError(
      "BAD_REQUEST",
      `the registry advertises no usable integrity or shasum for ${what}; ` +
        "refusing to install bytes nothing vouches for",
    );
  }
  return digests;
}

/** Refuses bytes that are not what the packument said they would be. */
function verifyDigests(bytes: Uint8Array, digests: readonly Digest[], what: string): void {
  for (const digest of digests) {
    const actual = new Bun.CryptoHasher(digest.algorithm).update(bytes).digest("hex");
    if (actual === digest.expected) return;
  }
  const first = digests[0];
  throw new GatewayError(
    "BAD_REQUEST",
    `${what} does not match the ${first?.source ?? "digest"} the registry advertised; ` +
      "the download was corrupted or the registry served something else",
  );
}

/**
 * Resolves a package name through a registry and returns its unpacked tree.
 *
 * Two fetches and no third: the packument, then the one tarball it named. No
 * dependency resolution, no `node_modules`, no lifecycle script, no subprocess
 * — a plugin is a self-contained tree, and everything that makes `npm install`
 * a code-execution event is absent by construction rather than by flag.
 */
async function npmPayload(deps: PluginDeps, spec: NpmSpec): Promise<Payload> {
  if (spec.version !== null && !EXACT_VERSION_PATTERN.test(spec.version)) {
    throw new GatewayError(
      "BAD_REQUEST",
      `${spec.name}@${spec.version} is not an exact version; this installer resolves no ranges ` +
        `or tags — install ${spec.name}@1.2.3, or ${spec.name} for the registry's latest`,
    );
  }
  const fetchBytes = deps.fetchBytes;
  if (fetchBytes === undefined) {
    throw new GatewayError("BAD_REQUEST", "this caller cannot install from a registry");
  }
  // Before the first request, so a plaintext registry is refused rather than
  // consulted and then refused.
  const registry = registryUrl(deps);

  const document: unknown = parseJson(
    await fetchBytes(packumentUrl(registry, spec.name), NPM_PACKUMENT_ACCEPT),
    `the registry's answer for ${spec.name}`,
  );
  const { version, dist } = resolveDist(document, spec);
  const what = `${spec.name}@${version}`;

  checkTarballUrl(dist.tarball, registry, what);
  // Both of these refuse before the download rather than after it.
  const digests = digestsFor(dist, what);

  const bytes = await fetchBytes(dist.tarball);
  verifyDigests(bytes, digests, what);

  return stripRoot(readTar(gunzipIfNeeded(bytes)));
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    const detail = describeError(error, String(error));
    throw new GatewayError("BAD_REQUEST", `${what} is not valid JSON: ${detail}`);
  }
}

async function loadPayload(deps: PluginDeps, spec: string): Promise<Payload> {
  // Plaintext is refused rather than upgraded. What arrives over this fetch is
  // code the gateway process will `import`, so a network position between the
  // operator and the host is a position that chooses what the gateway runs;
  // there is no integrity check downstream that would notice. Silently rewriting
  // to `https://` would be worse than refusing — it would install *something*
  // from a URL the operator did not type. A URL typed by hand carries no digest
  // for anything downstream to check, which is the whole difference between
  // this branch and the registry one below: there, the packument advertises a
  // hash and a mismatch is refused; here, TLS to the host the operator named is
  // the only assurance there is, so it is not optional.
  if (spec.startsWith("http://")) {
    throw new GatewayError("BAD_REQUEST", "plugins may only be installed over https");
  }
  if (spec.startsWith("https://")) {
    if (deps.fetchBytes === undefined) {
      throw new GatewayError("BAD_REQUEST", "this caller cannot install from a URL");
    }
    return stripRoot(readTar(gunzipIfNeeded(await deps.fetchBytes(spec))));
  }

  const source = resolve(spec);
  if (deps.fs.isDirectory(source)) {
    const files = readTree(deps.fs, source);
    // The source directory's own name is a claim about the id, in the same way a
    // non-npm tarball root is. `resolve` first so a trailing slash or a `.` does
    // not turn the basename into something the operator never typed.
    const claimed = basename(source);
    return { files, claimedId: ID_PATTERN.test(claimed) ? claimed : null };
  }

  const bytes = deps.fs.readBytes(source);
  if (bytes !== null) return stripRoot(readTar(gunzipIfNeeded(bytes)));

  // The registry is the last thing tried, and that order is the safe one. A
  // spec naming something that is on this disk installs what is on this disk;
  // only a spec that names nothing local can reach the network. The reverse —
  // registry first — would let a published package shadow the directory an
  // operator is standing in and turn `omni plugin install poke-dex` into a
  // download without anyone typing a URL. A local file shadowing a package is
  // the same ambiguity pointing the harmless way.
  const npm = parseNpmSpec(spec);
  if (npm !== null) return npmPayload(deps, npm);

  throw new GatewayError(
    "BAD_REQUEST",
    `no directory or archive at ${source}, and "${spec}" is not a package name`,
  );
}

/**
 * Unpacks a plugin into `<root>/plugins/<id>`.
 *
 * The order is the whole design. The payload is read into memory, the manifest
 * is parsed out of memory, the id is agreed, and only then does anything touch
 * `<root>/plugins`. A refusal therefore cannot leave a partial directory behind,
 * because at the moment of refusal nothing has been created — not a half-written
 * tree the operator has to clean up, and not an empty `<id>/` that the loader
 * would report as a plugin with no manifest at the next boot.
 *
 * **No code from the package runs.** Not a `postinstall`, not the server entry,
 * not a `package.json` `prepare`. The installer parses tar and writes bytes; it
 * has no path to a subprocess and never imports the entry. Verifying a plugin is
 * `omni plugin verify`, which also runs nothing, and the first time any of it
 * executes is the gateway's next boot — which is why the result says so. That
 * holds for a package name too: resolving one through a registry is two fetches
 * and a digest check, never `npm`, so nothing about the remote path reintroduces
 * the execution the local path was careful to avoid.
 *
 * A `spec` is a directory, a tarball path, an `https://` URL, or an npm name
 * with an optional exact version — tried in that order, so nothing reaches the
 * network while something local answers.
 *
 * Replacing an existing install is allowed and is done by swapping directories:
 * the new tree is written beside the old one and renamed over it, so an install
 * that fails halfway leaves the previous version serving rather than a mixture
 * of two.
 */
export async function installPlugin(
  deps: PluginDeps,
  root: string,
  spec: string,
): Promise<PluginInstallResult> {
  const payload = await loadPayload(deps, spec);

  const raw = payload.files.get(MANIFEST_FILENAME);
  if (raw === undefined) {
    throw new GatewayError("BAD_REQUEST", `${spec} has no ${MANIFEST_FILENAME} at its root`);
  }

  let document: unknown;
  try {
    document = JSON.parse(decoder.decode(raw)) as unknown;
  } catch (error) {
    const detail = describeError(error, String(error));
    throw new GatewayError("BAD_REQUEST", `${MANIFEST_FILENAME} is not valid JSON: ${detail}`);
  }

  const parsed = safeParseManifest(document);
  if (!parsed.ok)
    throw new GatewayError("BAD_REQUEST", `invalid ${MANIFEST_FILENAME}: ${parsed.reason}`);
  const manifest = parsed.manifest;

  // The directory this will live in is named by the source, not by the manifest,
  // when the source names one at all. Deriving it from the manifest instead would
  // make this check impossible to fail and would install a package called
  // `poke-dex` under whatever id its document happened to claim. The loader reads
  // the *directory*, so a disagreement here is a plugin that installs cleanly and
  // is silently skipped at the next boot — the failure this refusal exists to
  // convert into an error the operator sees now.
  const targetId = payload.claimedId ?? manifest.id;
  if (manifest.id !== targetId) {
    throw new GatewayError(
      "BAD_REQUEST",
      `manifest id ${manifest.id} does not match its directory ${targetId}; ` +
        "rename one of them so the gateway loads what you installed",
    );
  }

  const dir = pluginsDir(root);
  const target = join(dir, targetId);
  const replaced = deps.fs.isDirectory(target);

  // Staged beside the target rather than in the system temp directory, so the
  // rename that finishes the install is on one filesystem and is therefore
  // atomic. A leftover stage from a crashed install is named unmistakably and is
  // removed by the next one.
  const staging = join(dir, `.staging-${targetId}`);
  deps.fs.rm(staging);
  try {
    for (const [path, bytes] of payload.files) {
      const destination = join(staging, path);
      deps.fs.mkdir(join(destination, ".."));
      deps.fs.writeBytes(destination, bytes);
    }
    deps.fs.rm(target);
    deps.fs.rename(staging, target);
  } finally {
    // Reached on the success path too, where the stage no longer exists and this
    // is the no-op the deps promise it is.
    deps.fs.rm(staging);
  }

  return {
    id: targetId,
    name: manifest.name,
    version: manifest.version,
    path: target,
    replaced,
    restartRequired: true,
  };
}

/* ------------------------------------------------------------------ remove */

export type PluginRemoveOptions = {
  /**
   * Also drop this plugin's tables and its migration ledger rows.
   *
   * Off by default, and that default is the decision. A plugin being uninstalled
   * is not evidence its data is unwanted — the commonest reason to uninstall one
   * is to install a different build of it a minute later, and a `remove` that
   * took the data with it would make that a restore-from-backup. There is no
   * undo, which is why the CLI asks first.
   */
  purge?: boolean;
};

export function removePlugin(
  deps: PluginDeps,
  root: string,
  id: string,
  options: PluginRemoveOptions = {},
): PluginRemoveResult {
  // Checked before anything is joined onto a path or handed to the store. An id
  // that fails this could never have created a table and could never have been
  // loaded, so there is nothing it names.
  if (!ID_PATTERN.test(id)) {
    throw new GatewayError("BAD_REQUEST", `"${id}" is not a valid plugin id`);
  }

  const target = join(pluginsDir(root), id);
  const present = deps.fs.isDirectory(target);
  const purge = options.purge === true;

  if (purge && deps.store === undefined) {
    throw new GatewayError("INTERNAL", "purging a plugin's data needs a database");
  }

  // With `--purge` an absent directory is still worth acting on: that is exactly
  // the state `doctor` reports as orphan tables, and refusing here would leave
  // the one command that can clear them unable to run.
  const tables = purge && deps.store !== undefined ? deps.store.plugins.listTables(id) : [];
  if (!present && tables.length === 0) {
    throw new GatewayError("BAD_REQUEST", `no plugin "${id}" installed under ${pluginsDir(root)}`);
  }

  if (present) deps.fs.rm(target);
  if (purge && deps.store !== undefined) deps.store.plugins.dropAll(id);

  return { id, removed: present, droppedTables: tables };
}

/**
 * `plugin_*` tables belonging to nothing installed under `<root>/plugins`.
 *
 * A thin pairing of the two halves — what is on disk, what is in the database —
 * so `doctor` does not have to know that the store wants ids and the filesystem
 * has directories. The store's method reports and never drops, and nothing here
 * changes that: a restore is exactly when a plugin is most likely to be
 * temporarily missing.
 */
export function orphanPluginTables(deps: PluginDeps, root: string, store: PluginStore): string[] {
  const installed = listPlugins(deps, root).map((plugin) => plugin.id);
  return store.plugins.orphanTables(installed);
}
