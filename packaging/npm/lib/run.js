"use strict";
// Runs the native binary as a child: Node has no exec(), so this process
// stays as a thin parent that forwards signals and the exit status.
const { spawn } = require("node:child_process");
const { binaryPath } = require("./platform.js");

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

function run(args, options = {}) {
  const binary = options.binary ?? binaryPath();
  const exit = options.exit ?? ((code) => process.exit(code));
  if (binary instanceof Error) {
    process.stderr.write(`${binary.message}\n`);
    exit(1);
    return;
  }
  const child = spawn(binary, args, { stdio: "inherit" });
  const handlers = FORWARDED.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  child.on("error", (error) => {
    process.stderr.write(`omnigateway: could not run ${binary}: ${error.message}\n`);
    exit(1);
  });
  child.on("exit", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    if (signal !== null) {
      // Die the same way, so a supervisor sees the signal, not a code.
      process.kill(process.pid, signal);
      return;
    }
    exit(code ?? 1);
  });
}

module.exports = { run };
