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
 */
import React from "react";

export default React;

export const {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
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
