import { adminRoutes } from "../../apps/gateway/src/routes/admin.ts";
const cells = JSON.parse(await Bun.stdin.text());
const out = [];
for (const cell of cells) {
  const app = adminRoutes({
    store: { bodies: { get: async () => cell.read } },
    admin: { verify: async () => cell.role === "none" ? null : { kind: cell.role } },
    now: () => 0, sessionTtlMs: 60000, baseUrl: "http://localhost",
  } as any);
  const response = await app.handle(new Request(`http://localhost${cell.path}`, {
    headers: cell.role === "none" ? {} : { cookie: "omni_admin=token" },
  }));
  out.push({ status: response.status, type: response.headers.get("content-type"),
    cache: response.headers.get("cache-control"), body: await response.text() });
}
console.log(JSON.stringify(out));
