import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

/**
 * Reads roughly the last `lines` lines of a file without loading all of it.
 *
 * The console log is documented as growing without bound — nothing rotates a
 * file named by `OMNI_LOG_FILE` — and the dashboard re-reads it every few
 * seconds. Slurping it would allocate the whole file on every poll and block
 * the event loop on a multi-gigabyte log, so this seeks backward from the end
 * and stops as soon as it has enough newlines.
 *
 * It may return more than `lines`; the caller tails the parsed result anyway,
 * and a chunk boundary is not worth a second pass to trim. It may return fewer
 * only when the file itself is shorter or `MAX_BYTES` is hit.
 *
 * Node's fs is used directly rather than Bun's, because this is the one piece
 * of `@omni/control` both a Bun server and the CLI call, and it must not
 * assume either runtime's file API.
 */
const CHUNK = 64 * 1024;

/**
 * The ceiling on how much of a log a single read may pull into memory.
 *
 * A log with very long lines — a stack trace, a truncated upstream body —
 * could otherwise satisfy far fewer lines per byte than expected. Stopping at
 * 8 MiB returns a short page instead of an unbounded allocation.
 */
const MAX_BYTES = 8 * 1024 * 1024;

export function tailFile(path: string, lines: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    // Absent, or unreadable by this process. Both mean "nothing to show" to a
    // console reader, which is not the place to raise a filesystem error.
    return null;
  }

  try {
    const size = fstatSync(fd).size;
    if (size === 0) return "";

    const budget = Math.min(size, MAX_BYTES);
    let read = 0;
    let newlines = 0;
    const chunks: Buffer[] = [];

    while (read < budget && newlines <= lines) {
      const span = Math.min(CHUNK, budget - read);
      const buffer = Buffer.allocUnsafe(span);
      const position = size - read - span;
      readSync(fd, buffer, 0, span, position);

      chunks.unshift(buffer);
      read += span;
      for (const byte of buffer) if (byte === 0x0a) newlines++;
    }

    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** True when the path exists and is a regular file this process can stat. */
export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
