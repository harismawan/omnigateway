/**
 * The automatic JSX runtime, re-exported for the same reason as `react.ts`:
 * it is CommonJS, so `export *` yields nothing.
 *
 * Both the console's own bundle and every plugin's compile to imports of `jsx`
 * and `jsxs` from here, so an omission surfaces as every component failing to
 * render rather than as a build error.
 */
import jsxRuntime from "react/jsx-runtime";

export const { Fragment, jsx, jsxs } = jsxRuntime;
