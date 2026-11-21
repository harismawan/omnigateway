"use strict";
// Runs after npm extracted this package. Always exits 0: a failing postinstall
// fails the whole install, and by now the old TS files are already gone.
//
// 1. Replace bin/omni and bin/omnigateway with symlinks to the native binary,
//    so ordinary use has no Node process in the way.
// 2. On a global Linux install, run `omni service migrate --from-npm`, which
//    moves a 0.x systemd service onto the binary and records the outcome.
const { spawnSync } = require("node:child_process");
const { existsSync, renameSync, symlinkSync, unlinkSync } = require("node:fs");
const { join, relative } = require("node:path");
const { binaryPath } = require("./lib/platform.js");

function linkBins(binary, binDir) {
  for (const name of ["omni", "omnigateway"]) {
    const target = join(binDir, name);
    const temp = join(binDir, `.${name}.${process.pid}.tmp`);
    try {
      if (existsSync(temp)) unlinkSync(temp);
      symlinkSync(relative(binDir, binary), temp);
      renameSync(temp, target);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {}
      process.stderr.write(`omnigateway: kept the ${name} launcher (${error.message})\n`);
    }
  }
}

function main(env = process.env) {
  const binary = binaryPath();
  if (binary instanceof Error) {
    process.stderr.write(`${binary.message}\n`);
    return;
  }
  if (process.platform !== "win32") linkBins(binary, join(__dirname, "bin"));
  if (env.npm_config_global !== "true" || process.platform !== "linux") return;
  const result = spawnSync(binary, ["omni", "service", "migrate", "--from-npm"], {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    process.stderr.write(`omnigateway: service migration did not run: ${result.error.message}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`omnigateway: postinstall: ${error.message}\n`);
  }
  process.exitCode = 0;
}

module.exports = { linkBins, main };
