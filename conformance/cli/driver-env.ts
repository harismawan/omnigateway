// Drivers must start clean: Bun otherwise silently loads the checkout's .env.
// Child fixtures set their own variables after this guard has run.
for (const name of ["OMNI_DB_PATH", "OMNI_ENCRYPTION_KEY"]) {
  if (process.env[name] !== undefined) {
    console.error(`CLI conformance refuses inherited ${name}; unset it and run bun --no-env-file.`);
    process.exit(2);
  }
}
