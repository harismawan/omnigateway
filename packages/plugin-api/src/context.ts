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
 * One message a client sent on a channel.
 *
 * `connectionId` is an opaque handle the host assigned, and deliberately the
 * only thing a plugin ever learns about the far end: no socket, no upgrade
 * request, no header, no principal — the same posture as `PluginRequest`, and
 * for the same reason. It is meaningful until `onClose` reports it and
 * meaningless afterwards; it is not an identity and two connections from the
 * same operator share nothing.
 */
export type PluginChannelMessage = { connectionId: string; payload: unknown };

/**
 * One named channel on the gateway's push socket, owned by the plugin that
 * opened it.
 *
 * The wire topic is `plugin:<id>:<name>` and the `<id>` half is supplied by the
 * host from the manifest, never by the plugin — so a name cannot be chosen that
 * reaches into another plugin's namespace, and a plugin never writes a prefix,
 * exactly as it never writes its own table prefix.
 *
 * Delivery is best-effort in both directions and bounded: a subscriber that
 * cannot keep up drops frames rather than growing a queue. Nothing here is
 * durable and nothing is replayed, which is the same promise the event bus
 * makes.
 */
export type PluginChannel = {
  /** Called for each client frame on this channel. A handler that throws costs it that message. */
  onMessage(handler: (message: PluginChannelMessage) => void): void;
  /** Pushes a payload to one connection. A connection that is gone is a no-op, never an error. */
  send(connectionId: string, payload: unknown): void;
  /** Called when a connection holding this channel goes away. */
  onClose(handler: (connectionId: string) => void): void;
};

export type PluginChannels = {
  /**
   * Opens — or re-opens — the channel named `name`.
   *
   * Called from `setup`. A name outside `^[a-z0-9][a-z0-9:._-]{0,63}$` throws,
   * which skips the plugin and is reported like any other setup failure: a
   * channel a client can never name is a channel that would look merely quiet.
   */
  open(name: string): PluginChannel;
};

/**
 * A provider this plugin supplies, declared rather than registered.
 *
 * **Declared, and that is the whole point.** The first version was a
 * `ctx.provider.register(…)` capability called from `setup`, which meant a
 * descriptor existed only after arbitrary plugin code had run. That is fine for
 * the gateway, which runs `setup` anyway — and impossible for every other reader.
 * The CLI answers "what does this model advertise" (`omni setup`, whose figure is
 * written into an agent's configuration file and outlives the command) and "what
 * would route" (`omni models dry-run`), and it must not run `setup`: that opens
 * channels, applies migrations and registers routes, none of which a diagnostic
 * should do. With the capability, both answered from the six compiled-in
 * providers and silently omitted every plugin one.
 *
 * `migrations` below is the precedent and the reason this shape is not new: it
 * is static for exactly the same reason, that the host needs it before and
 * without running `setup`.
 *
 * **The CLI still imports the module**, and this comment is the wrong place to
 * imply otherwise. Reading this field means `await import(entry)`, which runs
 * the module's top-level code. What it does *not* do is construct a
 * `PluginContext` or call `setup`, so no store, channel, event bus or migration
 * is reachable from it. Narrower than before, not zero.
 *
 * `descriptor.id` must equal the plugin's own id. A plugin cannot supply a
 * provider named after another plugin, for the same reason it cannot open
 * another plugin's channel topic or name another plugin's table: the id comes
 * from the validated manifest and the host does not take the plugin's word for
 * it. A mismatch skips the plugin and is reported like any other load failure.
 *
 * **The types here are structural rather than the real ones**, and that is a
 * consequence of ordering rather than a design choice. The descriptor and codec
 * are defined in `@omni/providers`, in terms of `@omni/ir`, and this package is
 * published with no `@omni/*` imports — a single one would put an unresolvable
 * `workspace:*` into a stranger's dependency tree. `@omni/ir` is published in a
 * later sub-project; until then an in-repo provider can be typed against the
 * real contract and a third-party one cannot. The host validates the shape when
 * it reads this, so nothing is trusted merely because this type is loose.
 */
export type PluginProvider = {
  descriptor: unknown;
  codec: unknown;
};

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
  channels?: PluginChannels;
  /**
   * No `provider` member, and its absence is deliberate. Supplying a provider is
   * a `providers` field on `PluginDefinition` below, not a capability handed to
   * `setup` — see `PluginProvider` for why. The `provider` capability in the
   * manifest still gates it: intent stays auditable from the manifest, the
   * declaration just is not reached through here.
   */
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
  /**
   * The providers this plugin supplies, if any.
   *
   * Beside `migrations` rather than inside `setup`, and for the same reason: a
   * reader that is not the gateway needs this without running the plugin. See
   * `PluginProvider`.
   *
   * An array rather than one entry, because a plugin fronting several upstreams
   * is the obvious next request and a single-valued field would be widened by
   * whoever asked. Each `descriptor.id` must still equal the plugin's own id, so
   * today an array of more than one is refused — the shape is the room, not the
   * permission.
   */
  providers?: readonly PluginProvider[];
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
