import type { AnthropicToolDef, CustomToolDef, ToolDef } from "@omni/ir";
import { GatewayError } from "@omni/ir";
import {
  ANTHROPIC_CUSTOM_TOOL_OPTIONS,
  ANTHROPIC_TOOL_CALLERS,
  anthropicToolSpec,
} from "@omni/providers";
import { z } from "zod";
import { cacheControlSchema, irCacheControl } from "./schemas.ts";

/**
 * Per-field schemas for Anthropic tool definitions, named once and shared by
 * every version that accepts the field.
 *
 * Which fields a given version accepts is the table's business
 * (`ANTHROPIC_TOOL_SPECS`); what a field is allowed to contain is this map's.
 * Splitting them that way is what keeps adding a version to a data edit rather
 * than a code change.
 *
 * `null` is accepted wherever Anthropic's own union does, because a client
 * serialising an absent option as `null` is sending a legal request.
 */
const TOOL_FIELDS: Readonly<Record<string, z.ZodType>> = {
  cache_control: cacheControlSchema.nullable(),
  strict: z.boolean().nullable(),
  defer_loading: z.boolean().nullable(),
  allowed_callers: z.array(z.enum(ANTHROPIC_TOOL_CALLERS)).nullable(),
  input_examples: z.array(z.record(z.string(), z.unknown())).nullable(),
  eager_input_streaming: z.boolean().nullable(),

  max_uses: z.number().int().positive().nullable(),
  allowed_domains: z.array(z.string()).nullable(),
  blocked_domains: z.array(z.string()).nullable(),
  user_location: z
    .object({
      type: z.literal("approximate"),
      city: z.string().optional(),
      region: z.string().optional(),
      country: z.string().optional(),
      timezone: z.string().optional(),
    })
    .nullable(),

  citations: z.object({ enabled: z.boolean() }).nullable(),
  max_content_tokens: z.number().int().positive().nullable(),
  use_cache: z.boolean().nullable(),
  response_inclusion: z.enum(["full", "excluded"]).nullable(),

  display_width_px: z.number().int().positive(),
  display_height_px: z.number().int().positive(),
  display_number: z.number().int().nullable(),
  enable_zoom: z.boolean().nullable(),

  max_characters: z.number().int().positive().nullable(),

  model: z.string().min(1),
  caching: cacheControlSchema.nullable(),
  max_tokens: z.number().int().positive().nullable(),

  mcp_server_name: z.string().min(1),
  configs: z.record(z.string(), z.unknown()).nullable(),
  default_config: z.record(z.string(), z.unknown()).nullable(),
};

const customToolSchema = z.object({
  type: z.literal("custom").nullish(),
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
  cache_control: cacheControlSchema.nullish(),
});

function fail(path: string, message: string): never {
  throw new GatewayError("BAD_REQUEST", `${path}: ${message}`);
}

/** Runs one field's schema, reporting the failure at that field's own path. */
function field(path: string, name: string, value: unknown): unknown {
  const schema = TOOL_FIELDS[name];
  if (schema === undefined) fail(`${path}.${name}`, `unsupported field "${name}"`);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    fail(`${path}.${name}`, parsed.error.issues[0]?.message ?? "invalid value");
  }
  return parsed.data;
}

/**
 * Reads one Anthropic-defined tool.
 *
 * Validation is exact on purpose: an unknown dated `type` is refused rather
 * than forwarded, because forwarding one would have the gateway advertise
 * support for semantics it has never seen — and a field that belongs to a
 * different version of the same family is refused for the same reason. Both
 * failures name the path so the client can see which entry it got wrong.
 */
function parseAnthropicTool(
  raw: Record<string, unknown>,
  type: string,
  path: string,
  mcpServerNames: ReadonlySet<string>,
): AnthropicToolDef {
  const spec = anthropicToolSpec(type);
  if (spec === undefined) fail(`${path}.type`, `unrecognized tool type "${type}"`);

  if (spec.name !== undefined && raw.name !== spec.name) {
    fail(`${path}.name`, `${type} must be declared with name "${spec.name}"`);
  }
  if (spec.name === undefined && raw.name !== undefined) {
    fail(`${path}.name`, `${type} does not take a name`);
  }

  for (const required of spec.required) {
    if (raw[required] === undefined) fail(`${path}.${required}`, `${type} requires ${required}`);
  }

  const allowed = new Set([...spec.required, ...spec.optional]);
  const wire: Record<string, unknown> = {};
  let cacheControl: CustomToolDef["cacheControl"];

  for (const [key, value] of Object.entries(raw)) {
    if (key === "type" || key === "name") continue;
    if (!allowed.has(key)) fail(`${path}.${key}`, `${type} does not accept "${key}"`);
    const parsed = field(path, key, value);
    // Lifted out of the wire payload: a breakpoint is caller intent the whole
    // gateway reads, and every encoder renders it from the canonical field.
    if (key === "cache_control") {
      cacheControl = irCacheControl(
        parsed === null ? undefined : (parsed as z.infer<typeof cacheControlSchema>),
      ).cacheControl;
      continue;
    }
    // An option explicitly set to null is the same request as one that omitted
    // it, and sending the null back adds a field the caller never wrote.
    if (parsed !== null) wire[key] = parsed;
  }

  // Anthropic rejects a request that narrows in both directions at once, and it
  // is worth catching here: the two lists together read as "allow these, block
  // those", which is not what either field means.
  if (wire.allowed_domains !== undefined && wire.blocked_domains !== undefined) {
    fail(`${path}.blocked_domains`, "allowed_domains and blocked_domains are mutually exclusive");
  }

  // A toolset naming a server the request never declared configures nothing.
  // Checkable from this one request, so it is checked here rather than upstream.
  if (spec.family === "mcpToolset") {
    const server = wire.mcp_server_name;
    if (typeof server === "string" && !mcpServerNames.has(server)) {
      fail(`${path}.mcp_server_name`, `no mcp_servers entry named "${server}"`);
    }
  }

  return {
    provider: "anthropic",
    family: spec.family,
    type,
    name: spec.name ?? "",
    wire,
    ...(cacheControl === undefined ? {} : { cacheControl }),
  };
}

function parseCustomTool(raw: Record<string, unknown>, path: string): CustomToolDef {
  const parsed = customToolSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      `${path}${issue?.path.length ? `.${issue.path.join(".")}` : ""}`,
      issue?.message ?? "invalid tool",
    );
  }

  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (["type", "name", "description", "input_schema", "cache_control"].includes(key)) continue;
    if (!(ANTHROPIC_CUSTOM_TOOL_OPTIONS as readonly string[]).includes(key)) {
      fail(`${path}.${key}`, `unsupported field "${key}"`);
    }
    const value_ = field(path, key, value);
    if (value_ !== null) options[key] = value_;
  }

  return {
    provider: "custom",
    name: parsed.data.name,
    ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
    inputSchema: parsed.data.input_schema,
    ...irCacheControl(parsed.data.cache_control ?? undefined),
    ...(Object.keys(options).length === 0 ? {} : { options }),
  };
}

/**
 * Reads the `tools` array from an Anthropic request.
 *
 * An entry with no `type`, or with `type: "custom"`, is the portable shape and
 * normalizes to the same variant; anything else is looked up in Anthropic's own
 * table. Order is preserved because cache breakpoints are positional.
 */
export function parseTools(raw: unknown[], mcpServerNames: ReadonlySet<string>): ToolDef[] {
  return raw.map((entry, index) => {
    const path = `tools.${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(path, "expected a tool definition object");
    }
    const tool = entry as Record<string, unknown>;
    const type = tool.type;
    if (type === undefined || type === null || type === "custom") {
      return parseCustomTool(tool, path);
    }
    if (typeof type !== "string") fail(`${path}.type`, "expected a string");
    return parseAnthropicTool(tool, type, path, mcpServerNames);
  });
}

/** Names declared in top-level `mcp_servers`, which a toolset may reference. */
export function mcpServerNames(body: Record<string, unknown>): ReadonlySet<string> {
  const servers = body.mcp_servers;
  if (!Array.isArray(servers)) return new Set();
  const names = new Set<string>();
  for (const server of servers) {
    if (typeof server === "object" && server !== null) {
      const name = (server as { name?: unknown }).name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}
