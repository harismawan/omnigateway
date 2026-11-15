// Drivers must start clean: Bun otherwise silently loads the checkout's .env.
// Child fixtures set their own variables after this guard has run.
// Explicit opt-in for harness binary selectors or deliberate negative proofs:
// CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN,OMNI_PORT. No implicit exceptions.
const allowed = new Set((process.env.CLI_CONFORMANCE_ALLOW_OMNI ?? "").split(","));
for (const name of Object.keys(process.env)) {
  if (name.startsWith("OMNI_") && !allowed.has(name)) {
    console.error(`CLI conformance refuses inherited ${name}; unset it and run bun --no-env-file.`);
    process.exit(2);
  }
}
