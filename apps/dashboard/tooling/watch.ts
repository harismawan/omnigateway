import { existsSync, watch } from "node:fs";
import { join } from "node:path";

/** Coalesce edits without overlapping builds or dropping the final edit. */
export function createRebuilder(build: () => Promise<void>, onError: (error: unknown) => void) {
  let pending = false;
  let running: Promise<void> | undefined;
  async function drain() {
    while (pending) {
      pending = false;
      try {
        await build();
      } catch (error) {
        onError(error);
      }
    }
  }
  return {
    request(): Promise<void> {
      pending = true;
      running ??= drain().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

export function watchDashboard(root: string, changed: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = (name: string | undefined) => {
    if (!name || /(?:^|\/)routeTree\.gen\.ts$/.test(name)) return;
    if (
      !/^(?:src\/|public\/|shared\/|tooling\/|index\.html$|package\.json$|tsr\.config\.json$|tsconfig\.json$)/.test(
        name,
      )
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(changed, 75);
  };
  const watchers = [watch(root, (_event, filename) => notify(filename?.toString()))];
  // Never recursively watch node_modules, dist or test trees.
  for (const name of ["src", "public", "shared", "tooling"]) {
    if (existsSync(join(root, name)))
      watchers.push(
        watch(join(root, name), { recursive: true }, (_event, filename) =>
          notify(`${name}/${filename?.toString().replaceAll("\\", "/") ?? ""}`),
        ),
      );
  }
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
