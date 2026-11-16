"""Fail before fixtures run when the launching environment is contaminated."""
import os
import sys

# Same explicit, comma-separated opt-in as driver-env.ts.
allowed = set(os.environ.get("CLI_CONFORMANCE_ALLOW_OMNI", "").split(","))
for name in os.environ:
    if name.startswith("OMNI_") and name not in allowed:
        print(f"CLI conformance refuses inherited {name}; unset it and run bun --no-env-file.", file=sys.stderr)
        sys.exit(2)
