import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers a DOM before any module that needs one is evaluated.
 *
 * A preload rather than a call inside the test file, mirroring
 * `apps/dashboard/test/setup/happydom.ts`. The difference matters: registration
 * mutates process-wide globals, and doing it from inside a file that the root
 * suite also runs means every other test in that process sees a DOM appear
 * partway through. That is a cross-file effect, and it showed up as a one-in-
 * several-runs failure before this file existed.
 *
 * The companion's UI tests are therefore excluded from the root suite in
 * `bunfig.toml` and run under their own script, exactly as the console's are.
 */
GlobalRegistrator.register();
