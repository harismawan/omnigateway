"use strict";
// Shared by the launcher and postinstall. No dependencies: this runs under
// whatever Node npm used.
const { join, dirname } = require("node:path");

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
      `omnigateway: no native build for ${key} (supported: ${SUPPORTED.join(", ")}).`,
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

module.exports = { SUPPORTED, platformKey, binaryPath };
