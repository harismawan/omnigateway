"""Fail before fixtures run when the launching environment is contaminated."""
import os
import sys

for name in ("OMNI_DB_PATH", "OMNI_ENCRYPTION_KEY"):
    if name in os.environ:
        print(f"CLI conformance refuses inherited {name}; unset it and run bun --no-env-file.", file=sys.stderr)
        sys.exit(2)
