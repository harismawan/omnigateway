import { GatewayError, HTTP_STATUS, type ProviderId } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { ADMIN_COOKIE, type AdminAuth } from "../auth/admin.ts";
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
  /** Origin the provider redirects back to, e.g. `http://localhost:8787`. */
  baseUrl: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deviceIdFrom(start: ReturnType<OAuthProvider["start"]>): string {
  const deviceId = start.pending.extra?.deviceId;
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
    throw new GatewayError("INTERNAL", "device authorization did not provide a device id");
  }
  return deviceId;
}

const page = (title: string, message: string, status: number): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px system-ui;padding:3rem;max-width:34rem">` +
      `<h1>${title}</h1><p>${message}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

export function connectRoutes(deps: ConnectDeps) {
  const flows = createPendingFlows({ now: deps.now, ttlMs: FLOW_TTL_MS });
  const redirectUri = `${deps.baseUrl}/oauth/callback`;

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

  return (
    new Elysia()
      .post("/api/connect/start", async ({ request }) => {
        try {
          await requireAdmin(request);
          flows.sweep();

          const body: unknown = await request.json();
          const providerId = isRecord(body) ? body.provider : undefined;
          const inputLabel = isRecord(body) ? body.label : undefined;
          if (!isProviderId(providerId)) {
            throw new GatewayError(
              "BAD_REQUEST",
              "provider must be one of anthropic, openai, kimi",
            );
          }
          const label =
            typeof inputLabel === "string" && inputLabel.trim().length > 0
              ? inputLabel.trim()
              : providerId;

          const provider = deps.providers[providerId];
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

          return await complete(flow, code);
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

          const flow = flows.peek(flowId);
          if (flow === null)
            throw new GatewayError("BAD_REQUEST", "unknown or expired authorization");

          try {
            const created = await complete(flow, "");
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
        } catch (error) {
          return errorResponse(error);
        }
      })

      /**
       * Unauthenticated by design: the provider redirects a browser here, and
       * that browser may not carry the admin cookie. The single-use `state`
       * parameter — minted by this process moments earlier — is the credential.
       */
      .get("/oauth/callback", async ({ query }) => {
        const state = typeof query.state === "string" ? query.state : "";
        const found = flows.byState(state);
        if (found === null) {
          return page(
            "Authorization failed",
            "This authorization link is unknown or has expired.",
            400,
          );
        }

        // Find by state only to identify the candidate; consume it immediately so
        // concurrent callbacks cannot exchange or persist the same authorization twice.
        const flow = flows.take(found.id);
        if (flow === null || flow.pending.state !== state) {
          return page(
            "Authorization failed",
            "This authorization link is unknown or has expired.",
            400,
          );
        }

        if (typeof query.error === "string") {
          return page("Authorization declined", `The provider reported: ${query.error}.`, 400);
        }

        const code = typeof query.code === "string" ? query.code : "";
        if (code.length === 0) {
          return page("Authorization failed", "The provider returned no authorization code.", 400);
        }

        try {
          await complete(flow, code);
          return page(
            "Account connected",
            "You can close this tab and return to OmniGateway.",
            200,
          );
        } catch (error) {
          const message = error instanceof GatewayError ? error.message : "the exchange failed";
          return page(
            "Authorization failed",
            `The provider could not finish authorization: ${message}.`,
            400,
          );
        }
      })
  );
}
