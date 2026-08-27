/**
 * Prints the header and body order this process assembled, as JSON.
 *
 * Its own file rather than a string written to a temp path, so it typechecks and
 * lints with everything else. Imported by `profileEnvOverride.test.ts`, which
 * runs it in a subprocess under a chosen environment.
 *
 * The import order matters and is not incidental: `body.ts` first, matching what
 * every `<id>/index.ts` does. Module initialisation order is the thing under
 * test.
 */
import { BODY_ORDER } from "../../src/body.ts";
import { PROFILES } from "../../src/profile.ts";

process.stdout.write(
  JSON.stringify({
    anthropicOrder: [...PROFILES.anthropic.order],
    kiloBodyOrderLength: BODY_ORDER.kilo.length,
  }),
);
