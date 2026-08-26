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

/**
 * The size of a regular file, or null when there is no such file.
 *
 * What a forward reader starts from when it must not replay what is already
 * there: a gateway that begins streaming its own log at offset 0 pushes the
 * whole existing file at the first subscriber, which is precisely the
 * allocation `tailFile` exists to avoid.
 */
export function fileSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * What a forward read found, and where the next one resumes.
 *
 * `offset` is always where this read stopped, so a caller stores it and hands
 * it straight back; it never computes one itself.
 */
export type ForwardRead = {
  /** The bytes between the offset asked for and where the read stopped. */
  text: string;
  /** Where to resume. What the next call passes as `offset`. */
  offset: number;
  /**
   * True when the reader lost its place, so `text` is not continuous with what
   * the previous call returned.
   *
   * Two causes, one meaning. The file shrank below the offset held — truncated
   * in place, or rotated away and replaced — so the bytes at that offset are
   * not the bytes that were there. Or the delta was larger than `MAX_BYTES` and
   * its head was skipped rather than allocated. A caller that reacted to one
   * and not the other would present a rotated file's contents as if they simply
   * continued the old one, which is the silent skip this codebase forbids
   * everywhere else it appears.
   */
  gap: boolean;
};

/**
 * Reads from a byte offset to the end of a file, and reports the new offset.
 *
 * `tailFile` cannot serve this. It seeks *backward* from EOF to satisfy a line
 * count, which is the right primitive for a page and the wrong one for a delta:
 * a caller holding an offset wants exactly the bytes after it, and asking for
 * "the last N lines" instead either repeats lines it already has or drops ones
 * it does not, depending on how fast the file grew.
 *
 * Pure in the sense this package requires: one open, one read, one close, no
 * timer and no watcher. Whatever notices that the file changed lives in the
 * gateway, which is the only part of this system with a process to hold one.
 */
export function readFrom(path: string, offset: number): ForwardRead | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    // Absent or unreadable, same as `tailFile`: nothing to show, not an error
    // for a console reader to raise.
    return null;
  }

  try {
    const size = fstatSync(fd).size;
    const shrank = size < offset;
    const from = shrank ? 0 : offset;
    const available = size - from;
    // Nothing new. Reported with the current size rather than the offset asked
    // for, so a reader that started past EOF settles onto the real end.
    if (available <= 0) return { text: "", offset: size, gap: shrank };

    const span = Math.min(available, MAX_BYTES);
    const start = from + (available - span);
    const buffer = Buffer.allocUnsafe(span);
    // The count returned, not `span`: the file is being written to while this
    // runs, and an offset advanced past bytes that were never read would skip
    // them permanently on the next call.
    const read = readSync(fd, buffer, 0, span, start);

    return {
      text: buffer.subarray(0, read).toString("utf8"),
      offset: start + read,
      gap: shrank || span < available,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
