import { z } from "zod";

// Re-exported from the dependency-free module they live in; see version.ts for
// why they are not declared here beside the schema.
export { DASHBOARD_SDK_VERSION, PLUGIN_API_VERSION } from "./version.ts";

import { PLUGIN_API_VERSION } from "./version.ts";

/**
 * Every capability the host knows how to construct.
 *
 * A manifest is authored outside this repository, so this list is a
 * compatibility contract rather than an internal enum, in the same class as
 * `RTK_FILTER_IDS` and `DIMENSIONS` — with the opposite failure direction.
 * `isRtkFilterId` may drop an id it does not recognise because the worst case is
 * a gap in reported history. A dropped capability hands the plugin a context
 * missing a surface it believes it has, and the crash that follows names the
 * missing method rather than the typo that removed it. So this fails closed:
 * unknown capability, rejected manifest, one legible startup line.
 *
 * Adding a name is free. Renaming or removing one silently strips the capability
 * from every plugin that declared it.
 */
export const CAPABILITIES = [
  "storage",
  "files",
  "net:outbound",
  "events:request",
  "events:limit",
  "channels",
  "provider",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The id pattern, which is three constraints wearing one coat.
 *
 * The value becomes a URL path segment under `/api/plugins/`, a SQL table name
 * prefix in `plugin_<id>_<name>`, and a log field value. Lowercase alphanumeric
 * with interior dashes is the intersection of what all three accept without
 * escaping, and the leading-letter rule keeps a table name from starting with a
 * digit. Refusing here means no downstream site has to quote, escape, or
 * re-validate it.
 */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const idSchema = z.string().regex(ID_PATTERN, "id must match /^[a-z][a-z0-9-]{0,31}$/");

/**
 * A relative POSIX path inside the plugin directory.
 *
 * Rejected rather than resolved: the loader joins this onto the plugin root, and
 * a `..` segment or a leading slash is how that join escapes. The loader checks
 * the resolved path too — this is the cheaper of the two checks and the one that
 * produces a comprehensible message.
 */
const entrySchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
    message: "entry must be a relative path with no '..' segment",
  });

/**
 * An origin: scheme and host, nothing else.
 *
 * A path is refused rather than trimmed. Coercing `https://pokeapi.co/api/v2`
 * down to its origin would silently widen the allowlist past what the author
 * wrote and past what an operator reading the manifest believes is enforced —
 * and the whole value of this field is that reading it tells you the truth.
 *
 * Only http and https. A `file:` origin in an allowlist is a local file read
 * wearing a network capability's clothes.
 */
const originSchema = z.string().refine(
  (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.hostname === "") return false;
    // `new URL("https://host")` normalises to a "/" pathname, so a trailing
    // slash is the same origin and anything longer is a path.
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
    return value === url.origin || value === `${url.origin}/`;
  },
  { message: "origin must be scheme://host with no path, query or fragment" },
);

/**
 * No `icon`. The field existed, was validated, was carried all the way to the
 * console, and was then ignored — every plugin got the same glyph.
 *
 * Choosing an icon means agreeing on the set a manifest may name, and nothing
 * has made that decision. A field that silently does nothing is worse than an
 * absent one: it reads as supported and produces a bug report. Adding it back
 * once the set exists is additive and breaks no manifest, because `.strict()`
 * only rejects keys it does not know.
 */
const navSchema = z
  .object({
    label: z.string().min(1).max(32),
  })
  .strict();

/**
 * `.strict()` throughout, for the reason `limits` uses it: a misspelled key is
 * otherwise a capability or an entry point that silently does not exist, and the
 * plugin author's next hour goes into debugging the wrong thing.
 */
const manifestSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(32),
    api: z.number().int().nonnegative(),
    sdk: z.string().min(1).max(32).optional(),
    server: entrySchema.optional(),
    ui: entrySchema.optional(),
    nav: navSchema.optional(),
    // Absent means the empty set, never the full one. A missing key granting
    // everything would make the least attentive plugin the most privileged.
    capabilities: z.array(z.enum(CAPABILITIES)).default([]),
    origins: z.array(originSchema).min(1).optional(),
    defaults: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((m) => m.server !== undefined || m.ui !== undefined, {
    message: "manifest must declare a server entry, a ui entry, or both",
  })
  .refine((m) => m.ui === undefined || m.sdk !== undefined, {
    // Without a range the host cannot decide UI compatibility, and the failure
    // it cannot decide becomes a white screen at render rather than a disabled
    // nav entry at load.
    message: "a ui entry requires an sdk range",
  })
  .refine((m) => !m.capabilities.includes("net:outbound") || m.origins !== undefined, {
    message: "net:outbound requires origins",
  })
  .refine((m) => m.capabilities.includes("net:outbound") || m.origins === undefined, {
    // The reverse direction matters as much. Origins that nothing enforces read
    // to an operator as a promise the host never made.
    message: "origins requires the net:outbound capability",
  });

export type PluginManifest = z.infer<typeof manifestSchema>;

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; reason: string };

/**
 * Validates a manifest, reporting the reason as data.
 *
 * The loader turns every rejection into one startup line and one `omni doctor`
 * entry, so a thrown error would have to be caught and stringified at every call
 * site. Returning the reason keeps that in one place.
 */
export function safeParseManifest(input: unknown): ManifestResult {
  const parsed = manifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const first = parsed.error.issues[0];
  const path = first?.path.join(".") ?? "";
  const message = first?.message ?? "invalid manifest";
  return { ok: false, reason: path === "" ? message : `${path}: ${message}` };
}

/** Throwing form, for callers that have already established the input is a manifest. */
export function parseManifest(input: unknown): PluginManifest {
  const result = safeParseManifest(input);
  if (!result.ok) throw new Error(result.reason);
  return result.manifest;
}

/**
 * Whether a manifest's declared API major is one this host can load.
 *
 * Separate from the schema because it is a property of the running host rather
 * than of the document, and because `omni plugin verify` reports the two
 * differently: a malformed manifest is the author's bug, an API mismatch is the
 * operator's upgrade.
 */
export function isApiCompatible(manifest: PluginManifest): boolean {
  return manifest.api === PLUGIN_API_VERSION;
}
