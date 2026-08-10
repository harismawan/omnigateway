import { dirname } from "node:path";

export type AtomicWriteOps = {
  mkdir: (path: string) => void;
  write: (path: string, contents: string) => void;
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
};

/** Replace a setup file only after its complete contents exist beside it. */
export function atomicWriteFile(path: string, contents: string, ops: AtomicWriteOps): void {
  const temporary = `${path}.${process.pid}.tmp`;
  ops.mkdir(dirname(path));
  try {
    ops.write(temporary, contents);
    ops.rename(temporary, path);
  } catch (error) {
    ops.remove(temporary);
    throw error;
  }
}
