"use strict";
// Runs after npm extracted this package. Always exits 0: a failing postinstall
// fails the whole install.
//
// Replaces bin/omni and bin/omnigateway with symlinks to the native binary, so
// ordinary use has no Node process in the way. With install scripts blocked
// (npm 12's default) the Node launchers stay and work the same, one process
// deeper.
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

function main() {
  const binary = binaryPath();
  if (binary instanceof Error) {
    process.stderr.write(`${binary.message}\n`);
    return;
  }
  if (process.platform !== "win32") linkBins(binary, join(__dirname, "bin"));
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
