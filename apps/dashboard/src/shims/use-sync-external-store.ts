/**
 * `useSyncExternalStore`, as ESM.
 *
 * No port needed: React has shipped this hook natively since 18, and the
 * `use-sync-external-store` package exists only as a backport for React 17 and
 * below. The console is on 19, so the shim's whole job is already done by the
 * import it forwards to — this file is a re-export wearing the package's name so
 * the alias in `vite.config.ts` has somewhere to point.
 *
 * See `use-sync-external-store-with-selector.ts` beside this for why the package
 * is aliased away at all: it is CommonJS, it requires React, React is external,
 * and a bundler cannot reconcile those three.
 */

import { useSyncExternalStore } from "react";

export { useSyncExternalStore };

export default { useSyncExternalStore };
