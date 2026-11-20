import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

// Keep Bun's runtime compilation cache out of both CLI fixture environments.
// Otherwise HOME=root makes TS execution itself populate .bun/install/cache.
process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";

// Excludes mtime, inode and allocation: these vary across cloned fixture roots
// and runtimes without changing logical contents. Special nodes are never read.
type Entry = {
  path: string;
  type: "file" | "directory" | "symlink" | "fifo" | "socket" | "block" | "char" | "other";
  mode?: number;
  bytes?: Buffer;
  target?: string;
};
// Capture everything before opening inspection handles; never follow links.
export function fileState(root: string, _bodies = true): Entry[] {
  const entries: Entry[] = [];
  function visit(path: string) {
    const absolute = join(root, path),
      stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
      entries.push({ path, type: "symlink", target: readlinkSync(absolute) });
    else if (stat.isDirectory()) {
      entries.push({ path, type: "directory", mode: stat.mode & 0o7777 });
      for (const name of readdirSync(absolute).sort()) visit(path ? `${path}/${name}` : name);
    } else if (stat.isFile())
      entries.push({ path, type: "file", mode: stat.mode & 0o7777, bytes: readFileSync(absolute) });
    else
      entries.push({
        path,
        type: stat.isFIFO()
          ? "fifo"
          : stat.isSocket()
            ? "socket"
            : stat.isBlockDevice()
              ? "block"
              : stat.isCharacterDevice()
                ? "char"
                : "other",
        mode: stat.mode & 0o7777,
      });
  }
  visit("");
  return entries;
}
export function frozenPostState(root: string, bodies = true) {
  const state = fileState(root, bodies);
  const db = state.find((e) => e.path === "db")?.bytes;
  if (db && db.length >= 100) db.fill(0, 96, 100);
  return state;
}
// Clock-derived undo names and writer-version fields are the existing masks.
export function restorePostState(root: string, undo: string | string[]) {
  const state = frozenPostState(root),
    undos = typeof undo === "string" ? [undo] : undo;
  for (const entry of state) {
    const index = undos.findIndex((name) => entry.path === `snapshots/${name}`);
    if (index < 0) continue;
    entry.path = `snapshots/<undo${index || ""}>`;
    if (entry.bytes && entry.bytes.length >= 100) entry.bytes.fill(0, 96, 100);
  }
  return state.sort((a, b) => a.path.localeCompare(b.path));
}
