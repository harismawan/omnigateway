import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginFetch, createPluginFiles } from "../../src/plugins/capabilities.ts";

/** Present-or-not, without importing a second fs surface into the assertions. */
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omni-plugin-cap-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- files

test("a plugin reads back what it wrote, under its own root", async () => {
  const files = createPluginFiles(join(root, "data"));
  await files.write("sprites/25.gif", new Uint8Array([1, 2, 3]));
  expect(await files.read("sprites/25.gif")).toEqual(new Uint8Array([1, 2, 3]));
  expect(await files.exists("sprites/25.gif")).toBe(true);
});

test("a missing file is a null, not a throw", async () => {
  // Cached derived data is the point of this capability, so a miss is the normal
  // case and must not read as corruption. After a restore every file is a miss.
  const files = createPluginFiles(join(root, "data"));
  expect(await files.read("nope.gif")).toBeNull();
  expect(await files.exists("nope.gif")).toBe(false);
});

test("a traversing path is refused on every operation", async () => {
  const files = createPluginFiles(join(root, "data"));
  for (const path of ["../escape", "a/../../escape", "/etc/passwd", "..", "a/./../../x"]) {
    await expect(files.read(path)).rejects.toThrow(/outside/);
    await expect(files.write(path, new Uint8Array([1]))).rejects.toThrow(/outside/);
  }
});

test("a WRITE through a symlinked file is refused, not only a read", async () => {
  // The direction that matters, and the one that was missing. A read-only guard
  // means a plugin can overwrite a file it can then never read back — and an
  // operator symlinking data/cache onto a bigger disk, an ordinary thing to do,
  // gets that behaviour silently.
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "victim.txt"), "original");

  const files = createPluginFiles(join(root, "data"));
  await files.write("keep.txt", new Uint8Array([1]));
  await symlink(join(outside, "victim.txt"), join(root, "data", "link.txt"));

  await expect(files.write("link.txt", new TextEncoder().encode("PWNED"))).rejects.toThrow(
    /outside/,
  );
  expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("original");
});

test("a write through a symlinked DIRECTORY is refused", async () => {
  // The target does not exist yet, so resolving only the target finds nothing to
  // check. The deepest existing ancestor is the symlink, and that is what has to
  // be resolved.
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });

  const files = createPluginFiles(join(root, "data"));
  await files.write("keep.txt", new Uint8Array([1]));
  await symlink(outside, join(root, "data", "linkdir"));

  await expect(files.write("linkdir/new.txt", new TextEncoder().encode("PWNED"))).rejects.toThrow(
    /outside/,
  );
  expect(await exists(join(outside, "new.txt"))).toBe(false);
});

test("a symlink pointing out of the root is refused", async () => {
  // The lexical check above passes for this one — the path has no `..` in it.
  // Only resolving the link catches it, which is why the host reuses the
  // realpath guard rather than trusting string arithmetic.
  const outside = join(root, "outside.txt");
  await writeFile(outside, "secret");
  const files = createPluginFiles(join(root, "data"));
  await files.write("keep.txt", new Uint8Array([1]));
  await symlink(outside, join(root, "data", "link.txt"));

  await expect(files.read("link.txt")).rejects.toThrow(/outside/);
});

// ---------------------------------------------------------------- net

test("a request to a declared origin is allowed through", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    return new Response("ok");
  };
  const bound = createPluginFetch(["https://pokeapi.co"], { fetchImpl });

  const response = await bound("https://pokeapi.co/api/v2/pokemon/25");
  expect(await response.text()).toBe("ok");
  expect(calls).toEqual(["https://pokeapi.co/api/v2/pokemon/25"]);
});

test("a request to an undeclared origin is refused by the host, not by convention", async () => {
  let called = false;
  const fetchImpl = async (): Promise<Response> => {
    called = true;
    return new Response("ok");
  };
  const bound = createPluginFetch(["https://pokeapi.co"], { fetchImpl });

  await expect(bound("https://evil.example/steal")).rejects.toThrow(/not in the allowlist/);
  expect(called).toBe(false);
});

test("a sibling host that merely shares a suffix is not the declared origin", async () => {
  // The check is origin equality, never a prefix or suffix compare. Under a
  // `endsWith` test "pokeapi.co.evil.example" passes, and that is the entire
  // attack.
  const bound = createPluginFetch(["https://pokeapi.co"], {
    fetchImpl: async () => new Response("ok"),
  });

  await expect(bound("https://pokeapi.co.evil.example/x")).rejects.toThrow(/not in the allowlist/);
  await expect(bound("https://notpokeapi.co/x")).rejects.toThrow(/not in the allowlist/);
});

test("scheme and port are part of the origin", async () => {
  // Downgrading to http, or reaching a different port on the same host, is a
  // different origin and a different trust decision.
  const bound = createPluginFetch(["https://pokeapi.co"], {
    fetchImpl: async () => new Response("ok"),
  });

  await expect(bound("http://pokeapi.co/x")).rejects.toThrow(/not in the allowlist/);
  await expect(bound("https://pokeapi.co:8443/x")).rejects.toThrow(/not in the allowlist/);
});

test("a redirect off the allowlist is not followed", async () => {
  // Following redirects would let one allowed origin hand a plugin any origin at
  // all, which makes the manifest a suggestion. The host asks for manual
  // redirect handling and surfaces the hop rather than chasing it.
  const seen: RequestInit[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    seen.push(init ?? {});
    return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
  };
  const bound = createPluginFetch(["https://pokeapi.co"], { fetchImpl });

  const response = await bound("https://pokeapi.co/redirect");
  expect(response.status).toBe(302);
  expect(seen[0]?.redirect).toBe("manual");
});

test("a malformed url is refused rather than passed to fetch", async () => {
  const bound = createPluginFetch(["https://pokeapi.co"], {
    fetchImpl: async () => new Response("ok"),
  });
  await expect(bound("not-a-url")).rejects.toThrow();
});
