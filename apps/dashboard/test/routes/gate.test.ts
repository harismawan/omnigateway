import { describe, expect, test } from "bun:test";
import type { StatusResponse } from "../../src/api/types.ts";
import { homeFor, requireClient, requireConsole } from "../../src/routes/-gate.ts";

function status(patch: Partial<StatusResponse> = {}): StatusResponse {
  return {
    configured: true,
    authenticated: true,
    principal: { kind: "admin" },
    viewerConfigured: false,
    ...patch,
  };
}

/** What `redirect()` threw, as a plain destination. */
function destinationOf(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (thrown) {
    const target = thrown as { to?: string; options?: { to?: string } };
    return target.to ?? target.options?.to ?? "threw something that is not a redirect";
  }
}

describe("session gate", () => {
  test("each principal has one home", () => {
    expect(homeFor(status({ principal: { kind: "admin" } }))).toBe("/");
    expect(homeFor(status({ principal: { kind: "viewer" } }))).toBe("/");
    expect(homeFor(status({ principal: { kind: "client", apiKeyId: "k1" } }))).toBe("/client");
  });

  test("an unauthenticated session goes to login however it is spelled", () => {
    expect(homeFor(status({ authenticated: false, principal: null }))).toBe("/login");
    // Belt and braces: a response claiming to be authenticated with no
    // principal is malformed, and the safe reading of malformed is "signed out".
    expect(homeFor(status({ authenticated: true, principal: null }))).toBe("/login");
    expect(homeFor(status({ authenticated: false, principal: { kind: "admin" } }))).toBe("/login");
  });

  test("the console admits the operator and the read-only administrator", () => {
    expect(destinationOf(() => requireConsole(status({ principal: { kind: "admin" } }), "/"))).toBe(
      null,
    );
    expect(
      destinationOf(() => requireConsole(status({ principal: { kind: "viewer" } }), "/")),
    ).toBe(null);
  });

  /**
   * A client on the console goes to its own branch, not to the login screen.
   *
   * It is authenticated. Sending it to `/login` would ask it to sign in again
   * while it already is, which reads as a broken session rather than as a page
   * that is not for it.
   */
  test("a client on a console route lands on the client branch", () => {
    expect(
      destinationOf(() =>
        requireConsole(status({ principal: { kind: "client", apiKeyId: "k1" } }), "/usage"),
      ),
    ).toBe("/client");
  });

  test("the client branch admits only a client", () => {
    expect(
      destinationOf(() =>
        requireClient(status({ principal: { kind: "client", apiKeyId: "k1" } }), "/client"),
      ),
    ).toBe(null);
    expect(
      destinationOf(() => requireClient(status({ principal: { kind: "admin" } }), "/client")),
    ).toBe("/");
    expect(
      destinationOf(() => requireClient(status({ principal: { kind: "viewer" } }), "/client")),
    ).toBe("/");
  });

  test("an unauthenticated session reaches login from either branch", () => {
    const signedOut = status({ authenticated: false, principal: null });
    expect(destinationOf(() => requireConsole(signedOut, "/usage"))).toBe("/login");
    expect(destinationOf(() => requireClient(signedOut, "/client"))).toBe("/login");
  });

  /**
   * The two guards must not send a session at each other.
   *
   * Both read `homeFor`, so a session's destination is decided once. Written as
   * a loop over every principal so that adding a fourth cannot introduce a pair
   * that bounces without this failing.
   */
  test("no principal is redirected by both guards", () => {
    const principals: StatusResponse["principal"][] = [
      { kind: "admin" },
      { kind: "viewer" },
      { kind: "client", apiKeyId: "k1" },
    ];
    for (const principal of principals) {
      const where = status({ principal });
      const console = destinationOf(() => requireConsole(where, "/"));
      const client = destinationOf(() => requireClient(where, "/client"));
      // Exactly one guard admits it, so exactly one of the two is null.
      expect([console, client].filter((value) => value === null)).toHaveLength(1);
    }
  });
});

/**
 * The malformed cases, spelled the way a wire response can actually spell them.
 *
 * `get<StatusResponse>()` casts unvalidated JSON, so the type is a claim about
 * the gateway rather than a guarantee about the bytes. The existing test above
 * covers `principal: null` — but a JSON body cannot produce `null` by omitting
 * a key, it produces `undefined`, and `undefined === null` is false. The strict
 * check fell through and threw inside `beforeLoad`.
 *
 * Cast at the boundary here on purpose: the whole point is a value the type
 * says cannot exist.
 */
describe("session gate, malformed status", () => {
  const malformed = (body: unknown): StatusResponse => body as StatusResponse;

  test("an absent principal reaches login rather than throwing", () => {
    expect(homeFor(malformed({ configured: true, authenticated: true }))).toBe("/login");
    expect(
      homeFor(malformed({ configured: true, authenticated: true, principal: undefined })),
    ).toBe("/login");
  });

  test("an absent authenticated flag reaches login", () => {
    expect(homeFor(malformed({ configured: true, principal: { kind: "admin" } }))).toBe("/login");
  });

  test("a principal kind this bundle does not know reaches login", () => {
    // A gateway newer than this bundle. Guessing "/" would put an unknown
    // session in front of the operator's console.
    expect(
      homeFor(malformed({ authenticated: true, principal: { kind: "machine", pluginId: "rc" } })),
    ).toBe("/login");
  });

  test("neither guard throws on any malformed shape", () => {
    for (const body of [
      {},
      { authenticated: true },
      { authenticated: true, principal: null },
      { authenticated: true, principal: {} },
      { authenticated: "yes", principal: { kind: "admin" } },
    ]) {
      // Throwing a redirect is the correct outcome; throwing a TypeError is not.
      expect(() => homeFor(malformed(body))).not.toThrow();
    }
  });
});
