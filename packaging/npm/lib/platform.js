"use strict";
// Shared by the launcher, postinstall and the gateway.js bridge. No
// dependencies: this runs under whatever Node npm used, or under Bun when an
// old 0.x systemd unit starts gateway.js.
const { join, dirname } = require("node:path");

/** The last TS release: rollback target, and the version Windows stays on. */
const LAST_TS_VERSION = "0.15.5";

const SUPPORTED = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * The platform package's `omnigateway`, or an Error that says what to do.
 * `resolve` is injected for tests; production uses this module's require.
 */
function binaryPath(options = {}) {
  const key = platformKey(options.platform, options.arch);
  const resolve = options.resolve ?? ((id) => require.resolve(id));
  if (!SUPPORTED.includes(key)) {
    return new Error(
      `omnigateway: no native build for ${key} (supported: ${SUPPORTED.join(", ")}).\n` +
        `Stay on the TS release: npm i -g omnigateway@${LAST_TS_VERSION}`,
    );
  }
  try {
    return join(dirname(resolve(`@omnigateway/${key}/package.json`)), "omnigateway");
  } catch {
    return new Error(
      `omnigateway: the platform package @omnigateway/${key} is not installed.\n` +
        "Reinstall without omitting optional dependencies: npm i -g omnigateway",
    );
  }
}

module.exports = { LAST_TS_VERSION, SUPPORTED, platformKey, binaryPath };
