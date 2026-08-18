import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseDeps } from "./database.ts";

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
