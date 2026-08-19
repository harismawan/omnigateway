import type { PluginEvents } from "./events.ts";

/**
 * What a plugin may put in a log line.
 *
 * Not `LogFields`. That type is the gateway's redaction boundary and has no
 * index signature precisely so a body or a credential cannot typecheck as an
 * argument; handing it to third-party code would give that guarantee away. This
 * is the narrow subset a plugin has a reason to want.
 *
 * `plugin` is absent here on purpose — the host binds it to the id it validated,
 * and a plugin cannot set or forge it.
 *
 * `event` is the one free-text field, and the host sanitises it: capped in
 * length and reduced to a conservative character set before it reaches the log,
 * so it can carry a label like `hatch.completed` and cannot carry a prompt.
 */
export type PluginLogFields = {
  event?: string | undefined;
  count?: number | undefined;
  durationMs?: number | undefined;
};

export type PluginLogger = {
  debug(message: string, fields?: PluginLogFields): void;
  info(message: string, fields?: PluginLogFields): void;
  warn(message: string, fields?: PluginLogFields): void;
  error(message: string, fields?: PluginLogFields): void;
};

/** One numbered schema step. Applied in order, each in its own transaction. */
export type PluginMigration = { version: number; sql: string };

/**
 * SQL against the plugin's own tables.
 *
 * Tables are named with `{{name}}` placeholders, expanded by the host to
 * `plugin_<id>_<name>`. A plugin never writes its own prefix and cannot
 * accidentally address another plugin's table or a core one.
 */
export type PluginStorage = {
  run(sql: string, params?: readonly unknown[]): void;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  get<T>(sql: string, params?: readonly unknown[]): T | null;
  transaction<T>(fn: () => T): T;
};

export type PluginFiles = {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
};

export type PluginFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A request as a plugin route handler sees it.
 *
 * Deliberately not Elysia's context, and deliberately not a raw `Request`. The
 * framework is an implementation detail of the gateway, and putting it in this
 * type would make every plugin's build depend on the gateway's choice of one —
 * a version contract nobody asked for. A raw `Request` would carry headers,
 * which is how a plugin ends up holding a session cookie or an Authorization
 * header it has no business seeing.
 */
export type PluginRequest = {
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  /** Parsed JSON body, or null for a request that carried none. */
  body: unknown;
};

export type PluginResponse = {
  status?: number;
  /** Serialised as JSON. Mutually exclusive with `bytes`. */
  json?: unknown;
  /** Returned verbatim, for a plugin serving cached assets. */
  bytes?: Uint8Array;
  contentType?: string;
  /**
   * A conservative subset: caching directives only.
   *
   * A plugin cannot set arbitrary response headers, because those are how a
   * route sets a cookie, relaxes CORS, or overrides a security header on a
   * surface that is otherwise uniformly admin-gated.
   */
  cacheControl?: string;
};

export type PluginRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export type PluginRoute = {
  method: PluginRouteMethod;
  /** Relative to the plugin's mount, e.g. `/keys/:id/purchase`. */
  path: string;
  handler: (request: PluginRequest) => PluginResponse | Promise<PluginResponse>;
};

/**
 * Everything a plugin is handed.
 *
 * Optional members are present exactly when the manifest declared the matching
 * capability, so reaching a surface a plugin did not declare is a type error
 * rather than a runtime surprise. Never present at all: the `Store`, the
 * `HttpClient`, `AdminAuth`, decrypted credentials, `process.env`.
 *
 * Worth restating where a plugin author will read it: this is a guardrail, not
 * a sandbox. A plugin shares the gateway's process and can import past all of
 * it. The context makes accidental overreach impossible and makes a plugin's
 * intent auditable from its manifest; it does not contain hostile code.
 */
export type PluginContext = {
  id: string;
  now: () => number;
  logger: PluginLogger;
  storage?: PluginStorage;
  files?: PluginFiles;
  net?: PluginFetch;
  events?: PluginEvents;
  /** The plugin's own settings, seeded from the manifest's `defaults`. */
  config: Readonly<Record<string, unknown>>;
};

/** `undefined` rather than `void`: a plugin with no routes simply returns nothing. */
export type PluginSetupResult =
  | {
      routes?: readonly PluginRoute[];
    }
  | undefined;

export type PluginDefinition = {
  migrations?: readonly PluginMigration[];
  setup(context: PluginContext): PluginSetupResult | Promise<PluginSetupResult>;
};

/**
 * Identity, for the type inference and for the grep.
 *
 * A plugin's server entry default-exports the result of this call, so the host
 * has one shape to check for and an author has one symbol to look up.
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
