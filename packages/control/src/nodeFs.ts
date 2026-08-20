import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GatewayError } from "@omni/ir";
import type { DatabaseDeps } from "./database.ts";
import { MAX_PLUGIN_BYTES, type PluginDeps, type PluginFs } from "./plugins.ts";

/**
 * The real filesystem, shaped the way `database.ts` asks for it.
 *
 * `database.ts` takes every filesystem effect as a dependency so its own tests
 * never touch a directory; this is the implementation both callers that are not
 * a test hand it. It lives here rather than in either app for the same reason
 * `tail.ts` does: the gateway and the CLI each run these operations against a
 * local installation, and the one that is a copy would be the one that stops
 * agreeing about what an absent directory means.
 *
 * The two conventions the deps type documents are honoured rather than
 * reimplemented per caller: an absent directory reads as empty, and unlinking a
 * path that is not there is a no-op. Node's fs rather than Bun's, again as
 * `tail.ts`: this is called from a Bun server and from the CLI, and it must not
 * assume either runtime's file API.
 */
export function nodeDatabaseFs(): DatabaseDeps["fs"] {
  const dirBytes = (dir: string): number => {
    let entries: readonly { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      // Never created, or swept while it was being read. Zero either way.
      return 0;
    }

    let total = 0;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirBytes(path);
        continue;
      }
      try {
        total += statSync(path).size;
      } catch {
        // Swept between the listing and the stat. Not part of the total.
      }
    }
    return total;
  };

  return {
    readdir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    stat: (path) => {
      try {
        const stat = statSync(path);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },
    unlink: (path) => {
      rmSync(path, { force: true });
    },
    rename: (from, to) => renameSync(from, to),
    copyFile: (from, to) => copyFileSync(from, to),
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        // Not there, or a link with nothing on the end of it. Either way there
        // is no real path to contain, and the caller reports the absence.
        return null;
      }
    },
    freeBytes: (dir) => {
      try {
        const stat = statfsSync(dir);
        // What an unprivileged process may actually use, not the raw free
        // count: the reserve blocks root keeps are not room for a backup.
        return Number(stat.bavail) * Number(stat.bsize);
      } catch {
        return null;
      }
    },
    dirBytes,
  };
}

/**
 * The real filesystem, shaped the way `plugins.ts` asks for it.
 *
 * Here rather than in the CLI for the reason `nodeDatabaseFs` is: the gateway
 * and the CLI both administer a local installation's plugin directory, and a
 * second copy would be the one that stops agreeing about what an absent
 * directory means. Node's fs rather than Bun's, again for the same reason — this
 * runs under a Bun server and under the CLI and must assume neither.
 *
 * Every convention `PluginFs` documents is honoured here and nowhere else: an
 * absent directory reads as empty, an unreadable file reads as null, and
 * removing a path that is not there is a no-op. Callers that had to check first
 * would each be free to check differently.
 */
export function nodePluginFs(): PluginFs {
  return {
    readdir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    readBytes: (path) => {
      try {
        // A `Buffer` is a `Uint8Array`, but a *view* into a pooled allocation
        // for small reads. Copied so the returned array's byteOffset is zero and
        // a caller slicing it cannot see a neighbouring read's bytes.
        return new Uint8Array(readFileSync(path));
      } catch {
        return null;
      }
    },
    writeBytes: (path, bytes) => {
      writeFileSync(path, bytes);
    },
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    rm: (path) => {
      rmSync(path, { force: true, recursive: true });
    },
    rename: (from, to) => renameSync(from, to),
  };
}

export type FetchBytesOptions = {
  /**
   * The `fetch` to use. Injected for one reason: it is how this function is
   * tested without a network. Production passes nothing.
   */
  fetchImpl?: typeof fetch;
  /** Transfer ceiling. Defaults to `MAX_PLUGIN_BYTES`. */
  maxBytes?: number;
};

/**
 * Downloads bytes for the plugin installer, and refuses everything else.
 *
 * Here rather than in the CLI for the reason `nodePluginFs` is: the deps say a
 * remote install needs a fetcher, and one implementation is how every caller
 * gets the same refusals. `plugins.ts` never imports this — it holds the
 * *policy* (https only, host pinning, digests) and this holds the transport, so
 * control still knows nothing about HTTP beyond a function that returns bytes.
 *
 * Deliberately not `HttpClient`, and the boundary rule that mandates it is not
 * being bent: rule 8 governs the provider path, where header order is a
 * fingerprint and every request carries a `ProviderId`. A registry is not a
 * provider — there is no id to give it — and it needs redirects, which that
 * transport does not follow.
 *
 * Redirects *are* followed, and that is safe only because of what sits above
 * this: the registry's tarball URL is pinned to the registry's own host before
 * the request is made, and the bytes are checked against a digest the packument
 * advertised. A redirect can therefore change which server answers but not what
 * ends up installed.
 *
 * The ceiling is enforced while reading rather than from `content-length`,
 * which a hostile server simply omits. `MAX_PLUGIN_BYTES` is the same ceiling
 * the unpacker uses: nothing that would be refused after unpacking is worth
 * finishing the download for.
 */
export function nodeFetchBytes(
  options: FetchBytesOptions = {},
): NonNullable<PluginDeps["fetchBytes"]> {
  const impl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_PLUGIN_BYTES;

  return async (url: string, accept?: string): Promise<Uint8Array> => {
    // Restated here rather than trusted from the caller. This function is the
    // one that opens the socket, so it is the last place the guarantee can
    // still be made, and a future caller that forgets is a plaintext download
    // of code the gateway will import.
    if (!url.startsWith("https://")) {
      throw new GatewayError(
        "BAD_REQUEST",
        `plugins may only be fetched over https; ${url} is not`,
      );
    }

    const response = await impl(url, {
      headers: accept === undefined ? {} : { accept },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new GatewayError("BAD_REQUEST", `${url} answered ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (reader === undefined) return new Uint8Array(0);

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancelled rather than left to drain: the refusal is supposed to stop
        // the transfer, not merely stop reading the rest of it.
        await reader.cancel();
        throw new GatewayError("BAD_REQUEST", `${url} sent more than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };
}
