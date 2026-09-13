/**
 * `Secure` on the session cookie, which the backend request URL cannot decide.
 *
 * The documented deployment terminates TLS at a reverse proxy, so an HTTPS
 * login arrives at Bun over plain HTTP and `new URL(request.url).protocol` says
 * `http:`. Reading the flag off that URL — which is what this did until
 * `docs/2026-08-08-engineering-audit.md:157` — strips `Secure` from a live admin
 * session, and the next plain-HTTP request to the same public host hands it to
 * anyone on the path. `HttpOnly` and `SameSite=Strict` do not encrypt anything.
 *
 * Two sources, either sufficient, because either can be the one that is absent:
 * an operator who set `OMNI_BASE_URL` may sit behind a proxy that strips
 * forwarding headers, and an operator who left it at its derived default may
 * still have a proxy that sets them. The cases below are written one source at a
 * time so that deleting either branch fails a test rather than being covered by
 * the other.
 */

import { describe, expect, test } from "bun:test";
import { sessionCookie } from "../../src/routes/http.ts";

/** A request as it reaches the gateway behind a TLS-terminating proxy. */
function behindProxy(headers: Record<string, string> = {}): Request {
  return new Request("http://10.0.0.7:9000/api/login", { headers });
}

const HTTP_ORIGIN = "http://localhost:9000";
const HTTPS_ORIGIN = "https://gateway.example.com";

describe("sessionCookie", () => {
  test("omits Secure when nothing claims https", () => {
    // The control. Without this the suite passes on a `sessionCookie` that
    // appends `Secure` unconditionally, which would break every plain-HTTP
    // install by making the cookie unreturnable.
    expect(sessionCookie(behindProxy(), HTTP_ORIGIN, "t", 60)).not.toContain("Secure");
  });

  test("sets Secure from the configured public origin alone", () => {
    // No forwarding header: the proxy stripped it, and the config is all there is.
    expect(sessionCookie(behindProxy(), HTTPS_ORIGIN, "t", 60)).toContain("Secure");
  });

  test("sets Secure from X-Forwarded-Proto alone", () => {
    // OMNI_BASE_URL unset, so `baseUrl` fell back to its derived http default.
    const cookie = sessionCookie(
      behindProxy({ "x-forwarded-proto": "https" }),
      HTTP_ORIGIN,
      "t",
      60,
    );
    expect(cookie).toContain("Secure");
  });

  test("reads an https origin whatever case it was configured in", () => {
    // URL schemes are case-insensitive and `OMNI_BASE_URL` is typed by a person.
    // A prefix test against the literal `https:` reads this as plain HTTP and
    // drops `Secure` for the one operator who did configure TLS.
    expect(sessionCookie(behindProxy(), "HTTPS://gateway.example.com", "t", 60)).toContain(
      "Secure",
    );
  });

  test("does not mistake https appearing elsewhere in the origin", () => {
    // Substring-matching the scheme instead of parsing it would call this https.
    const cookie = sessionCookie(behindProxy(), "http://gateway.example.com/https:/x", "t", 60);
    expect(cookie).not.toContain("Secure");
  });

  test("ignores a malformed configured origin rather than throwing", () => {
    // `baseUrl` is operator input reaching this on the login path. An origin
    // that cannot be parsed is not https, and it is certainly not a 500.
    expect(sessionCookie(behindProxy(), "not a url", "t", 60)).not.toContain("Secure");
  });

  test("reads a forwarded scheme in any case, with any padding", () => {
    // Proxies write this header by hand and are inconsistent about both.
    //
    // The padding has to be *inside* the list to test anything: `Headers` strips
    // leading and trailing whitespace from a header value on the way in, so
    // `"  https  "` arrives already trimmed and a test using it would pass with
    // the trim deleted. Whitespace after a comma survives, because it is part of
    // the value rather than around it.
    const cookie = sessionCookie(
      behindProxy({ "x-forwarded-proto": "HTTPS , http" }),
      HTTP_ORIGIN,
      "t",
      60,
    );
    expect(cookie).toContain("Secure");
  });

  test("an empty forwarded header claims nothing", () => {
    // Proxies do emit this. Treating a header that is present but says nothing
    // as https would put `Secure` on every cookie of a plain-HTTP install, and
    // the browser then refuses to send it back — a login that silently never
    // takes, which reads as the gateway being broken rather than as a cookie
    // policy bug.
    expect(
      sessionCookie(behindProxy({ "x-forwarded-proto": "" }), HTTP_ORIGIN, "t", 60),
    ).not.toContain("Secure");
  });

  test("an empty client-facing hop does not fall through to the next one", () => {
    // The first entry is the leg that matters and an empty one is unknown, not
    // an invitation to read further down the list. Scanning for the first
    // *non-empty* entry would report the internal hop's scheme as the browser's.
    const cookie = sessionCookie(
      behindProxy({ "x-forwarded-proto": ", https" }),
      HTTP_ORIGIN,
      "t",
      60,
    );
    expect(cookie).not.toContain("Secure");
  });

  test("reads the client-facing hop when the header lists several", () => {
    // Two proxies: browser→https→edge→http→gateway. The first entry is the leg
    // the cookie has to survive; taking the last would drop the flag exactly
    // where the extra hop made it matter.
    const cookie = sessionCookie(
      behindProxy({ "x-forwarded-proto": "https, http" }),
      HTTP_ORIGIN,
      "t",
      60,
    );
    expect(cookie).toContain("Secure");
  });

  test("keeps Secure when the origin is https and the header disagrees", () => {
    // Either source is sufficient, so a proxy reporting the internal leg cannot
    // talk the configured origin out of its flag.
    const cookie = sessionCookie(
      behindProxy({ "x-forwarded-proto": "http" }),
      HTTPS_ORIGIN,
      "t",
      60,
    );
    expect(cookie).toContain("Secure");
  });

  test("still honours a genuinely https request URL", () => {
    // The pre-existing source, kept: a gateway exposed directly over TLS has
    // neither a configured origin nor a proxy header to go on.
    const direct = new Request("https://gateway.example.com/api/login");
    expect(sessionCookie(direct, HTTP_ORIGIN, "t", 60)).toContain("Secure");
  });

  test("carries the rest of the policy unchanged", () => {
    const cookie = sessionCookie(behindProxy(), HTTPS_ORIGIN, "tok", 43_200);
    expect(cookie).toContain("omni_admin=tok");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=43200");
  });

  test("clears with Max-Age=0 and keeps Secure", () => {
    // Logout writes an empty cookie, and it goes out under the same policy as
    // the one it replaces. `Secure` is not part of a cookie's identity — name,
    // domain and path are — so the deletion lands either way; this is about the
    // deletion not being the one response in the flow that ships a session
    // cookie value, however empty, with weaker transport rules than the rest.
    const cookie = sessionCookie(behindProxy(), HTTPS_ORIGIN, "", 0);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
  });
});
