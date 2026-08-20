/**
 * React, re-exported as a real ESM module.
 *
 * `export * from "react"` does NOT work here and silently produces a module
 * whose only export is `default`. React ships CommonJS, so a bundler cannot
 * enumerate its named exports statically, and the re-export collapses to
 * nothing — every `import { useState } from "react"` in a plugin then fails at
 * runtime with no build-time warning at all.
 *
 * Destructuring the default at runtime sidesteps the interop entirely. The list
 * being explicit is a feature rather than a chore: this is the federation
 * boundary, so what a plugin may import from React is a contract worth writing
 * down and versioning.
 *
 * Explicit and hand-written means it can also fall behind, in the same silent
 * way: React adds an export, the list does not, and a plugin importing it gets
 * `undefined` with no build error anywhere. `test/federation.test.ts` compares
 * this list against `Object.keys(React)` so an upgrade that widens React's
 * surface fails the suite instead of a plugin. Two names are held back on
 * purpose and are listed there with the reason.
 */
import React from "react";

export default React;

export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React;
