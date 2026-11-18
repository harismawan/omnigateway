import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { deriveKey, encrypt, decrypt } from "../../packages/store/src/encryption.ts";
import { isDeepStrictEqual as equal } from "node:util";
const [binary, work] = process.argv.slice(2).map((p) => resolve(p));
const env = {
  PATH: process.env.PATH!,
  HOME: join(work!, "home"),
  TMPDIR: join(work!, "tmp"),
  OMNI_ENCRYPTION_KEY: "e3-quota-fixture-secret",
  NO_COLOR: "1",
  NODE_EXTRA_CA_CERTS: join(work!, "cert.pem"),
  SSL_CERT_FILE: join(work!, "cert.pem"),
};
const key = await deriveKey(env.OMNI_ENCRYPTION_KEY);
let mode = "ok";
let requests: { path: string; body: string; head: string }[] = [];
const server = Bun.listen<{ bytes: Buffer }>({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: Bun.file(join(work!, "cert.pem")), key: Bun.file(join(work!, "key.pem")) },
  socket: {
    open(s) {
      s.data = { bytes: Buffer.alloc(0) };
    },
    data(s, chunk) {
      s.data.bytes = Buffer.concat([s.data.bytes, chunk]);
      const end = s.data.bytes.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = s.data.bytes.subarray(0, end).toString();
      const len = Number(head.match(/content-length: (\d+)/i)?.[1] ?? 0);
      if (s.data.bytes.length < end + 4 + len) return;
      const path = head.split(" ")[1]!;
      const body = s.data.bytes.subarray(end + 4, end + 4 + len).toString();
      requests.push({ path, body, head });
      let status =
        mode === "limited"
          ? 429
          : mode === "nothing"
            ? 401
            : mode === "redeem-failed" &&
                (path.includes("consume") || path.includes("reset_rate_limits"))
              ? 409
              : mode === "reread-failed" &&
                  requests.some(
                    (r) => r.path.includes("consume") || r.path.includes("reset_rate_limits"),
                  ) &&
                  !path.includes("consume") &&
                  !path.includes("reset_rate_limits")
                ? 503
                : 200;
      let result: unknown = {};
      if (path.includes("consume")) result = { windows_reset: 2 };
      else if (path.includes("reset_rate_limits"))
        result =
          mode === "conflict"
            ? { result: "already_used" }
            : { result: "reset", cleared: ["five_hour"] };
      else if (path.includes("/profile")) result = { organization: { uuid: "fixture-org" } };
      else if (path.includes("reset-credits"))
        result = {
          credits:
            mode === "empty"
              ? []
              : [
                  {
                    id: "credit",
                    status: "available",
                    title: "banked",
                    granted_at: null,
                    expires_at: "2030-01-01T00:00:00Z",
                  },
                ],
        };
      else if (path.includes("cedar_ember"))
        result = {
          cedar_ember: {
            grants: [{ id: "grant", resets_left: 2, usable_now: true, label: "banked" }],
          },
        };
      else if (path.includes("/oauth/token"))
        result = { access_token: "renewed", refresh_token: "rotated", expires_in: 3600 };
      else if (path.includes("QuotaSummary"))
        result = {
          groups: [
            {
              displayName: "Gemini models",
              buckets: [
                { bucketId: "weekly", remainingFraction: 0.75, resetTime: "2030-01-01T00:00:00Z" },
              ],
            },
          ],
        };
      else if (head.includes("chatgpt.com"))
        result = {
          rate_limit: {
            primary_window: { used_percent: 25, reset_at: 1893456000, limit_window_seconds: 18000 },
          },
        };
      else result = { five_hour: { utilization: 25, resets_at: "2030-01-01T00:00:00Z" } };
      const raw = JSON.stringify(result);
      s.end(
        `HTTP/1.1 ${status} OK\r\nContent-Length: ${Buffer.byteLength(raw)}\r\nConnection: close\r\n\r\n${raw}`,
      );
    },
  },
});
let count = 0;
const failures: unknown[] = [];
const results: unknown[] = [];
for (const provider of ["openai", "anthropic", "antigravity"])
  for (const test of [
    "refresh",
    "human",
    "all",
    "noData",
    "limited",
    "resets",
    "list-human",
    "redeem",
    "credit",
    "redeem-failed",
    "reread-failed",
    "refuse",
    "cancel",
    "confirm",
    "expired",
    "repeat",
    "disabled",
    "unsupported",
    ...(provider === "openai" ? ["empty"] : []),
  ]) {
    if (provider === "antigravity" && !["refresh", "noData", "limited"].includes(test)) continue;
    const pair: unknown[] = [];
    for (const [index, command] of [
      [
        "bun",
        "--no-env-file",
        resolve(process.env.E3_ORACLE_ROOT ?? "/tmp/opencode/e3/oracle", "apps/cli/src/index.ts"),
      ],
      [binary!],
    ].entries()) {
      const root = join(work!, `${provider}-${test}-${index}`);
      mkdirSync(root);
      let p = Bun.spawn([...command, "--root", root, "usage", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await p.exited;
      const db = new Database(join(root, "omnigateway.db"));
      db.run(
        "INSERT INTO credentials(id,provider,label,auth_type,access_token,refresh_token,expires_at,provider_data,created_at,updated_at) VALUES('c',?,'account','oauth',?,?,?,?,1,1)",
        [
          provider,
          await encrypt(key, "access"),
          await encrypt(key, "refresh"),
          test === "expired" ? 1 : 1893456000000,
          JSON.stringify({
            accountId: "workspace",
            projectId: "project",
            installationId: "11111111-1111-4111-8111-111111111111",
            idSalt: "a".repeat(64),
          }),
        ],
      );
      if (test === "disabled") db.run("UPDATE credentials SET enabled=0");
      if (test === "unsupported") db.run("UPDATE credentials SET auth_type='apiKey'");
      db.close();
      mode =
        test === "noData"
          ? "nothing"
          : test === "limited"
            ? "limited"
            : test === "empty"
              ? "empty"
              : ["redeem-failed", "reread-failed"].includes(test)
                ? test
                : "ok";
      requests = [];
      let args = [
        "quota",
        ["resets", "list-human"].includes(test)
          ? "resets"
          : [
                "redeem",
                "credit",
                "redeem-failed",
                "reread-failed",
                "refuse",
                "cancel",
                "confirm",
                "empty",
              ].includes(test)
            ? "reset"
            : "refresh",
        "c",
      ];
      if (!["refuse", "cancel", "confirm", "human", "list-human"].includes(test))
        args.push("--json");
      if (["redeem", "credit", "redeem-failed", "reread-failed", "empty"].includes(test))
        args.push("--yes");
      if (test === "credit") args.push("--credit", provider === "openai" ? "credit" : "grant-u2");
      if (test === "all") args = ["quota", "refresh", "--all", "--json"];
      let argv = [...command, "--root", root, ...args];
      if (["cancel", "confirm"].includes(test))
        argv = [
          "python3",
          resolve("conformance/cli/pty.py"),
          test === "cancel" ? "n" : "y",
          ...argv,
        ];
      const start = Date.now();
      p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (test === "repeat") {
        const again = Bun.spawn([...command, "--root", root, ...args], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        await again.exited;
      }
      const end = Date.now();
      const d = new Database(join(root, "omnigateway.db"));
      let windows = d.query("SELECT * FROM quota_windows").all() as Record<string, unknown>[];
      let samples = d.query("SELECT * FROM quota_samples").all() as Record<string, unknown>[];
      for (const row of [...windows, ...samples])
        for (const k of ["starts_at", "observed_at"])
          if (k in row) {
            if (typeof row[k] !== "number" || row[k] < start || row[k] > end)
              throw Error("clock outside call");
            row[k] = "<clock>";
          }
      const access = d
        .query("SELECT access_token,token_version FROM credentials WHERE id='c'")
        .get() as { access_token: string; token_version: number };
      access.access_token = await decrypt(key, access.access_token);
      d.close();
      if (
        test === "expired" &&
        code === 0 &&
        !requests.some((r) => r.path.includes("/oauth/token"))
      )
        throw Error("refresh not reused");
      if (
        test === "expired" &&
        code === 0 &&
        !requests.some((r) => r.head.includes("Bearer renewed"))
      )
        throw Error("renewed access not used");
      const projected = requests.map((r) => {
        const body: unknown = r.body
          ? r.head.toLowerCase().includes("application/x-www-form-urlencoded")
            ? Object.fromEntries(new URLSearchParams(r.body))
            : JSON.parse(r.body)
          : null;
        if (r.path.includes("consume") || r.path.includes("reset_rate_limits")) {
          if (body === null || typeof body !== "object") throw Error("reset body missing");
          const fields = body as Record<string, unknown>;
          const name = "redeem_request_id" in fields ? "redeem_request_id" : "request_id";
          if (
            typeof fields[name] !== "string" ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
              fields[name],
            )
          )
            throw Error("invalid request UUID");
          fields[name] = "<validated-request-uuid>";
        }
        return { path: r.path, body };
      });
      if (index === 0) {
        const terminal = ["cancel", "confirm"].includes(test)
          ? (JSON.parse(out) as { code: number })
          : null;
        const expectedFailure = ["limited", "redeem-failed", "refuse", "cancel", "empty"].includes(
          test,
        );
        if ((terminal?.code ?? code) !== (expectedFailure ? 1 : 0))
          throw Error(`oracle unexpected exit ${provider}/${test}`);
        if (test === "cancel" && requests.length !== 0) throw Error("cancel made provider request");
        if (test === "repeat" && samples.length !== 1) throw Error("idle history not deduplicated");
      }
      pair.push({ out, err, code, windows, samples, access, requests: projected });
    }
    count++;
    results.push({ provider, test, pair });
    if (!equal(pair[0], pair[1])) failures.push(results.at(-1));
  }
server.stop(true);
writeFileSync(join(work!, "results.json"), JSON.stringify(results, null, 2));
writeFileSync(join(work!, "failures.json"), JSON.stringify(failures, null, 2));
console.log({ count, failures: failures.length });
if (failures.length) process.exit(1);
