/**
 * `react-dom/client` is where React 19 keeps the DOM renderer, and it is a
 * separate specifier from `react-dom`. Missing it produces a shared bundle that
 * looks plausible — a few kilobytes of `react-dom` shim — and cannot mount an
 * application.
 */
import ReactDOMClient from "react-dom/client";

export const { createRoot, hydrateRoot } = ReactDOMClient;
