/**
 * The plugin SDK, shared so that the console and every panel hold the same one.
 *
 * `export *` rather than a destructured default, unlike the React shims beside
 * it: this package is real ESM written in TypeScript, so a bundler can
 * enumerate its exports statically and the CommonJS trap those files exist to
 * work around does not apply here.
 *
 * The other four entries are shared for *instance* identity — one React, one
 * stylesheet, one query cache. This one is shared for **context** identity. The
 * SDK's `live.ts` calls `createContext` at module scope, and a second copy of
 * the module would produce a second context object: a panel reading it would
 * find no provider, fall through to the "polling is off" default, and never
 * poll again without throwing anything. That failure is invisible in a way the
 * others are not, which is the reason this entry exists.
 */
export * from "@omnigateway/dashboard-sdk";
