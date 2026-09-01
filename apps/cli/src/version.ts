/**
 * The one place the CLI's own version comes from.
 *
 * Its own module rather than a constant on `run.ts`, because two commands read
 * it and one of them — `doctor` — is reached *through* `run.ts`'s command
 * registry. Importing back would make a cycle whose only symptom is an
 * initialisation order that happens to work, and `VERSION` is evaluated at
 * module scope, which is exactly the shape that stops working when the graph is
 * entered from a different entry point. Both `run.ts` and `doctor` import it
 * from here, so there is still one name and one value.
 */

/**
 * Substituted by `scripts/build-npm.ts` at bundle time; absent everywhere else.
 *
 * The release tag is the sole version source and it comes into existence after
 * the source does, so there is no moment at which this file could hold the real
 * number. `typeof` rather than a plain read because outside the bundle the
 * identifier is not merely undefined, it is undeclared — a direct read throws.
 */
declare const OMNI_CLI_VERSION: string | undefined;

/**
 * What `omni --version` prints, and what `omni doctor` names on its first line.
 *
 * The literal below is what a checkout reports, and it says so: a build reached
 * npm as `omnigateway@1.2.3` while its own `--version` answered `0.0.0`,
 * because the release version was written into the generated manifest and
 * nowhere the CLI could read. An operator reporting a bug then names a version
 * that never shipped. `-dev` makes the two cases tell themselves apart rather
 * than differing by a number nobody has memorised.
 *
 * The gateway's version is this same number by construction — one tag builds
 * both bundles, through one `define` — so nothing prints a second one.
 */
export const VERSION = typeof OMNI_CLI_VERSION === "string" ? OMNI_CLI_VERSION : "0.0.0-dev";
