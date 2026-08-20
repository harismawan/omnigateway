/**
 * `useSyncExternalStoreWithSelector`, as ESM.
 *
 * A port, not an invention: this is React's own
 * `use-sync-external-store-with-selector` implementation, MIT-licensed by Meta,
 * transcribed from the package's production build with its minifier-isms undone
 * and nothing about the algorithm changed. The header below is theirs.
 *
 * ## Why a port exists at all
 *
 * `use-sync-external-store` ships CommonJS and nothing else — no `module` field,
 * no `import` condition — and every file under its `cjs/` directory calls
 * `require("react")`. The console externalises React so that it and every plugin
 * share one instance through the import map, and those two facts cannot both
 * hold in a bundle: an external has no module for a `require` to resolve to, so
 * rolldown emits a stub that throws
 *
 *     Calling `require` for "react" in an environment that doesn't expose the
 *     `require` function
 *
 * and the console dies on load with a stack naming only a hashed chunk. That
 * shipped in 0.4.0 and 0.4.1.
 *
 * Nothing here imports this package deliberately. It arrives through `recharts`
 * → `react-redux`, and through `@reduxjs/toolkit` and `@tanstack/react-store`,
 * across six different specifiers — which is why `vite.config.ts` aliases the
 * package rather than any one entry point.
 *
 * ## Why a port rather than sharing it
 *
 * The federation machinery exists so React is a single instance. This module
 * holds no state: it calls React hooks and returns. Two copies of it in one page
 * are harmless as long as they call the *same* React, which they do, because
 * React stays external. So it does not belong in the shared build, and putting
 * it there would say something about it that is not true.
 *
 * @license React
 * use-sync-external-store-with-selector.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { useDebugValue, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

/** `Object.is`, with the pre-ES2015 fallback the original keeps. */
function is(x: unknown, y: unknown): boolean {
  // biome-ignore-start lint/suspicious/noSelfCompare: `x !== x` is the NaN test.
  // It is the whole reason this fallback exists — `Object.is` differs from `===`
  // on exactly two inputs, NaN and signed zero, and both are checked here.
  return (x === y && (x !== 0 || 1 / (x as number) === 1 / (y as number))) || (x !== x && y !== y);
  // biome-ignore-end lint/suspicious/noSelfCompare: as above.
}

const objectIs: (x: unknown, y: unknown) => boolean =
  typeof Object.is === "function" ? Object.is : is;

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: undefined | null | (() => Snapshot),
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  // Holds the last selection across renders so `isEqual` has something to
  // compare against. A ref rather than state: writing it must not re-render.
  const instRef = useRef<{ hasValue: boolean; value: Selection | null } | null>(null);
  let inst: { hasValue: boolean; value: Selection | null };
  if (instRef.current === null) {
    inst = { hasValue: false, value: null };
    instRef.current = inst;
  } else {
    inst = instRef.current;
  }

  const [getSelection, getServerSelection] = useMemo(() => {
    // Closed over by both getters below, so a snapshot that has not changed
    // identity skips the selector entirely.
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;

    const memoizedSelector = (nextSnapshot: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);
        if (isEqual !== undefined && inst.hasValue) {
          const currentSelection = inst.value as Selection;
          if (isEqual(currentSelection, nextSelection)) {
            memoizedSelection = currentSelection;
            return currentSelection;
          }
        }
        memoizedSelection = nextSelection;
        return nextSelection;
      }

      const currentSelection = memoizedSelection;
      if (objectIs(memoizedSnapshot, nextSnapshot)) return currentSelection;

      const nextSelection = selector(nextSnapshot);
      if (isEqual?.(currentSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return currentSelection;
      }

      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    };

    const maybeGetServerSnapshot = getServerSnapshot === undefined ? null : getServerSnapshot;
    return [
      () => memoizedSelector(getSnapshot()),
      maybeGetServerSnapshot === null
        ? undefined
        : () => memoizedSelector(maybeGetServerSnapshot()),
    ] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual, inst]);

  const value = useSyncExternalStore(subscribe, getSelection, getServerSelection);

  useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
  }, [value, inst]);

  useDebugValue(value);
  return value;
}

export default { useSyncExternalStoreWithSelector };
