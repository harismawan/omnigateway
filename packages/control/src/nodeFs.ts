import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseDeps } from "./database.ts";
import type { PluginFs } from "./plugins.ts";

/**
 * The real filesystem, shaped the way `database.ts` asks for it.
 *
 * `database.ts` takes every filesystem effect as a dependency so its own tests
 * never touch a directory; this is the implementation both callers that are not
 * a test hand it. It lives here rather than in either app for the same reason
 * `tail.ts` does: the gateway and the CLI each run these operations against a
 * local installation, and the one that is a copy would be the one that stops
 * agreeing about what an absent directory means.
 *
 * The two conventions the deps type documents are honoured rather than
 * reimplemented per caller: an absent directory reads as empty, and unlinking a
 * path that is not there is a no-op. Node's fs rather than Bun's, again as
 * `tail.ts`: this is called from a Bun server and from the CLI, and it must not
 * assume either runtime's file API.
 */
export function nodeDatabaseFs(): DatabaseDeps["fs"] {
  const dirBytes = (dir: string): number => {
    let entries: readonly { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      // Never created, or swept while it was being read. Zero either way.
      return 0;
    }

    let total = 0;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirBytes(path);
        continue;
      }
      try {
        total += statSync(path).size;
      } catch {
        // Swept between the listing and the stat. Not part of the total.
      }
    }
    return total;
  };

  return {
    readdir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    stat: (path) => {
      try {
        const stat = statSync(path);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },
    unlink: (path) => {
      rmSync(path, { force: true });
    },
    rename: (from, to) => renameSync(from, to),
    copyFile: (from, to) => copyFileSync(from, to),
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        // Not there, or a link with nothing on the end of it. Either way there
        // is no real path to contain, and the caller reports the absence.
        return null;
      }
    },
    freeBytes: (dir) => {
      try {
        const stat = statfsSync(dir);
        // What an unprivileged process may actually use, not the raw free
        // count: the reserve blocks root keeps are not room for a backup.
        return Number(stat.bavail) * Number(stat.bsize);
      } catch {
        return null;
      }
    },
    dirBytes,
  };
}

/**
 * The real filesystem, shaped the way `plugins.ts` asks for it.
 *
 * Here rather than in the CLI for the reason `nodeDatabaseFs` is: the gateway
 * and the CLI both administer a local installation's plugin directory, and a
 * second copy would be the one that stops agreeing about what an absent
 * directory means. Node's fs rather than Bun's, again for the same reason — this
 * runs under a Bun server and under the CLI and must assume neither.
 *
 * Every convention `PluginFs` documents is honoured here and nowhere else: an
 * absent directory reads as empty, an unreadable file reads as null, and
 * removing a path that is not there is a no-op. Callers that had to check first
 * would each be free to check differently.
 */
export function nodePluginFs(): PluginFs {
  return {
    readdir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    readBytes: (path) => {
      try {
        // A `Buffer` is a `Uint8Array`, but a *view* into a pooled allocation
        // for small reads. Copied so the returned array's byteOffset is zero and
        // a caller slicing it cannot see a neighbouring read's bytes.
        return new Uint8Array(readFileSync(path));
      } catch {
        return null;
      }
    },
    writeBytes: (path, bytes) => {
      writeFileSync(path, bytes);
    },
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    rm: (path) => {
      rmSync(path, { force: true, recursive: true });
    },
    rename: (from, to) => renameSync(from, to),
  };
}
