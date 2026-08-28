import { expect, test } from "bun:test";
import type { Principal } from "@omni/control";
import { authorised } from "../../src/routes/stream.ts";
import type { ChannelRegistry } from "../../src/stream/channels.ts";

/** A registry where exactly one plugin channel has been opened. */
const channels = {
  opened: (topic: string) => topic === "plugin:rc:events",
} as unknown as ChannelRegistry;

const ADMIN: Principal = { kind: "admin" };
const VIEWER: Principal = { kind: "viewer" };
const CLIENT: Principal = { kind: "client", apiKeyId: "k1" };
const MACHINE: Principal = { kind: "machine", tokenId: "t1", pluginId: "rc" };

const TOPICS = [
  "res:usage",
  "res:logs",
  "res:keys",
  "res:credentials",
  "res:models",
  "res:settings",
  "res:quota",
  "stream:console",
  "plugin:rc:events",
  "plugin:other:events",
  "nonsense",
  "res:",
  "",
];

/**
 * The whole grid, written out.
 *
 * A per-principal test asserting its grants would pass for an implementation
 * that grants everything; what makes this worth having is that every cell is
 * named, so a widened arm shows up as a cell that flipped rather than as a
 * test nobody wrote.
 */
const GRID: Record<string, Record<string, boolean>> = {
  admin: {
    "res:usage": true,
    "res:logs": true,
    "res:keys": true,
    "res:credentials": true,
    "res:models": true,
    "res:settings": true,
    "res:quota": true,
    "stream:console": true,
    "plugin:rc:events": true,
    // Refused for everyone: nothing has opened it, and a topic with no owner
    // must not read as one that is merely quiet.
    "plugin:other:events": false,
    nonsense: false,
    "res:": false,
    "": false,
  },
  viewer: {
    "res:usage": true,
    "res:logs": true,
    "res:keys": true,
    "res:credentials": true,
    "res:models": true,
    "res:settings": true,
    "res:quota": true,
    // A diagnostic, and a viewer is the operator minus mutations and secrets.
    "stream:console": true,
    // Opened by third-party code rather than declared by the host.
    "plugin:rc:events": false,
    "plugin:other:events": false,
    nonsense: false,
    "res:": false,
    "": false,
  },
  client: {
    // Two, and only two. Both are invalidation signals carrying `{ keys }`, so
    // holding one leaks nothing — the refetch goes to a scoped endpoint.
    "res:usage": true,
    "res:logs": true,
    "res:keys": false,
    "res:credentials": false,
    "res:models": false,
    "res:settings": false,
    "res:quota": false,
    "stream:console": false,
    "plugin:rc:events": false,
    "plugin:other:events": false,
    nonsense: false,
    "res:": false,
    "": false,
  },
  machine: {
    "res:usage": false,
    "res:logs": false,
    "res:keys": false,
    "res:credentials": false,
    "res:models": false,
    "res:settings": false,
    "res:quota": false,
    "stream:console": false,
    // Its own plugin's opened channel, and nothing else.
    "plugin:rc:events": true,
    "plugin:other:events": false,
    nonsense: false,
    "res:": false,
    "": false,
  },
};

test("every principal holds exactly the topics named for it", () => {
  const principals: Record<string, Principal> = {
    admin: ADMIN,
    viewer: VIEWER,
    client: CLIENT,
    machine: MACHINE,
  };

  const wrong: string[] = [];
  for (const [name, principal] of Object.entries(principals)) {
    for (const topic of TOPICS) {
      const expected = GRID[name]?.[topic];
      const actual = authorised(channels, principal, topic);
      if (actual !== expected) {
        wrong.push(`${name} + ${JSON.stringify(topic)}: expected ${expected}, got ${actual}`);
      }
    }
  }
  expect(wrong).toEqual([]);
});

/**
 * The argument that makes the client arm safe is about *these two* topics, so
 * the set is enumerated in the source rather than derived from a prefix. If a
 * third `res:` topic is ever added, this fails and someone has to decide
 * whether the argument still holds for it.
 */
test("the client's topic set is an allowlist, not a res: prefix test", () => {
  expect(authorised(channels, CLIENT, "res:usage")).toBe(true);
  expect(authorised(channels, CLIENT, "res:anything-else")).toBe(false);
  expect(authorised(channels, CLIENT, "res:usage-extra")).toBe(false);
  // Prefix confusion in the other direction, too.
  expect(authorised(channels, CLIENT, "res:log")).toBe(false);
  expect(authorised(channels, CLIENT, "res:logsX")).toBe(false);
});

test("a machine token cannot name another plugin's topic", () => {
  const other: Principal = { kind: "machine", tokenId: "t2", pluginId: "other" };
  // `plugin:other:events` is not opened, so this is refused for two reasons; the
  // one being asserted is that `rc`'s opened channel is closed to `other`.
  expect(authorised(channels, other, "plugin:rc:events")).toBe(false);
});
