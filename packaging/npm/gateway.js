// The 0.x → Rust migration bridge.
//
// Every omnigateway 0.x systemd unit runs `ExecStart=<bun> …/omnigateway/gateway.js`.
// npm replaced that package with this one, so the next time systemd starts the
// old unit it lands here. `omni service migrate --bridge` backs the database
// up, points the unit at the native binary, and asks systemd to restart the
// unit, which then runs the binary itself (a one-shot ExecStartPost verifies
// that start and removes itself).
//
// Plain CommonJS so both Bun (the old unit's interpreter) and Node run it.
"use strict";
// A launch failure exits 0: the old unit has Restart=on-failure, and retrying
// a missing binary every two seconds helps nobody. The service stays stopped.
require("./lib/run.js").run(["omni", "service", "migrate", "--bridge"], { failureCode: 0 });
