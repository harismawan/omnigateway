import { GatewayError, HTTP_STATUS, type ProviderId } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { ADMIN_COOKIE, type AdminAuth } from "../auth/admin.ts";
import { isRecord } from "../ingress/schemas.ts";
import { isAuthorizationPending } from "../oauth/kimi.ts";
import { createPendingFlows, type StoredFlow } from "../oauth/pending.ts";
import type { OAuthProvider } from "../oauth/types.ts";

const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "kimi"];
const FLOW_TTL_MS = 600_000;

export type ConnectDeps = {
  store: Store;
  admin: AdminAuth;
  providers: Readonly<Record<ProviderId, OAuthProvider>>;
  http: HttpClient;
  now: () => number;
};

function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError("INTERNAL", error instanceof Error ? error.message : "internal error");
}

function errorResponse(error: unknown): Response {
  const gatewayError = asGatewayError(error);
  return new Response(
    JSON.stringify({ error: { code: gatewayError.code, message: gatewayError.message } }),
    {
      status: HTTP_STATUS[gatewayError.code],
      headers: { "content-type": "application/json" },
    },
  );
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.includes(value as ProviderId);
}

function deviceIdFrom(start: ReturnType<OAuthProvider["start"]>): string {
  const deviceId = start.pending.extra?.deviceId;
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
    throw new GatewayError("INTERNAL", "device authorization did not provide a device id");
  }
  return deviceId;
}

export function connectRoutes(deps: ConnectDeps) {
  const flows = createPendingFlows({ now: deps.now, ttlMs: FLOW_TTL_MS });
  const pollsInFlight = new Map<string, Promise<{ id: string }>>();
  const callbackUri = (provider: ProviderId) =>
    provider === "openai" ? "http://localhost:1455/auth/callback" : "";

  function normalizeAuthorizationCode(flow: StoredFlow, input: string): string {
    if (flow.provider !== "openai") return input;

    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return input;
    }

    if (url.origin !== "http://localhost:1455" || url.pathname !== "/auth/callback") {
      throw new GatewayError("BAD_REQUEST", "invalid OpenAI callback URL");
    }

    const code = url.searchParams.get("code")?.trim() ?? "";
    const state = url.searchParams.get("state")?.trim() ?? "";
    if (code.length === 0 || state.length === 0) {
      throw new GatewayError("BAD_REQUEST", "OpenAI callback URL must contain code and state");
    }
    if (state !== flow.pending.state) {
      throw new GatewayError("AUTH", "authorization state mismatch");
    }
    return `${code}#${state}`;
  }

  async function requireAdmin(request: Request): Promise<void> {
    const token = readCookie(request, ADMIN_COOKIE);
    if (token === null || !(await deps.admin.verify(token))) {
      throw new GatewayError("AUTH", "admin session required");
    }
  }

  /** Runs the exchange and persists the resulting credential. */
  async function complete(flow: StoredFlow, code: string): Promise<{ id: string }> {
    const provider = deps.providers[flow.provider];
    const result = await provider.exchange(
      { code, pending: flow.pending },
      { http: deps.http, now: deps.now },
    );

    const id = crypto.randomUUID();
    await deps.store.credentials.create({
      id,
      provider: flow.provider,
      label: flow.label,
      authType: "oauth",
      enabled: true,
      tier: 1,
      weight: 1,
      expiresAt: result.expiresAt,
      accountEmail: result.accountEmail,
      providerData: result.providerData,
      ...result.secrets,
    });
    return { id };
  }

  async function pollOutcome(
    flowId: string,
    poll: Promise<{ id: string }>,
    set: { status?: number | string },
  ) {
    try {
      const created = await poll;
      flows.take(flowId);
      return { status: "complete", ...created };
    } catch (error) {
      if (isAuthorizationPending(error)) {
        set.status = 202;
        return { status: "pending" };
      }
      flows.take(flowId);
      throw error;
    }
  }

  return new Elysia()
    .post("/api/connect/start", async ({ request }) => {
      try {
        await requireAdmin(request);
        flows.sweep();

        const body: unknown = await request.json();
        const providerId = isRecord(body) ? body.provider : undefined;
        const inputLabel = isRecord(body) ? body.label : undefined;
        if (!isProviderId(providerId)) {
          throw new GatewayError("BAD_REQUEST", "provider must be one of anthropic, openai, kimi");
        }
        const label =
          typeof inputLabel === "string" && inputLabel.trim().length > 0
            ? inputLabel.trim()
            : providerId;

        const provider = deps.providers[providerId];
        const redirectUri = callbackUri(providerId);
        const start =
          provider.begin === undefined
            ? provider.start({ redirectUri })
            : await (async () => {
                const initial = provider.start({ redirectUri });
                return provider.begin?.(
                  { deviceId: deviceIdFrom(initial) },
                  { http: deps.http, now: deps.now },
                );
              })();
        if (start === undefined) {
          throw new GatewayError("INTERNAL", "device authorization could not start");
        }

        const flowId = flows.put({
          provider: providerId,
          label,
          pending: start.pending,
          ...(start.userCode === undefined ? {} : { userCode: start.userCode }),
        });

        return {
          flowId,
          authorizeUrl: start.authorizeUrl,
          userCode: start.userCode ?? null,
          kind: provider.kind,
          supportsManualPaste: provider.supportsManualPaste,
          pollIntervalMs: (start.pending.interval ?? 5) * 1000,
        };
      } catch (error) {
        return errorResponse(error);
      }
    })

    .post("/api/connect/finish", async ({ request }) => {
      try {
        await requireAdmin(request);

        const body: unknown = await request.json();
        const flowId = isRecord(body) ? body.flowId : undefined;
        const code = isRecord(body) ? body.code : undefined;
        if (typeof flowId !== "string" || typeof code !== "string") {
          throw new GatewayError("BAD_REQUEST", "flowId and code are required");
        }

        const flow = flows.take(flowId);
        if (flow === null)
          throw new GatewayError("BAD_REQUEST", "unknown or expired authorization");

        return await complete(flow, normalizeAuthorizationCode(flow, code));
      } catch (error) {
        return errorResponse(error);
      }
    })

    .post("/api/connect/poll", async ({ request, set }) => {
      try {
        await requireAdmin(request);

        const body: unknown = await request.json();
        const flowId = isRecord(body) ? body.flowId : undefined;
        if (typeof flowId !== "string") {
          throw new GatewayError("BAD_REQUEST", "flowId is required");
        }

        const existing = pollsInFlight.get(flowId);
        if (existing !== undefined) return pollOutcome(flowId, existing, set);

        const flow = flows.peek(flowId);
        if (flow === null)
          throw new GatewayError("BAD_REQUEST", "unknown or expired authorization");

        const poll = complete(flow, "").finally(() => {
          pollsInFlight.delete(flowId);
        });
        pollsInFlight.set(flowId, poll);
        return pollOutcome(flowId, poll, set);
      } catch (error) {
        return errorResponse(error);
      }
    });
}
