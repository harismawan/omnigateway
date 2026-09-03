/**
 * The gateway's own version, mirroring `apps/cli/src/version.ts`.
 *
 * Substituted by `scripts/build-npm.ts` at bundle time — one tag, one `define`,
 * both bundles — so the npm build carries the number inline. The Docker image
 * runs the source, not a bundle, so it arrives there as `OMNI_VERSION`, set from
 * the same tag by the release workflow. A checkout reports `-dev`, so the two
 * tell themselves apart rather than differing by a number nobody memorised.
 */
declare const OMNI_CLI_VERSION: string | undefined;

export const VERSION =
  typeof OMNI_CLI_VERSION === "string"
    ? OMNI_CLI_VERSION
    : (process.env.OMNI_VERSION ?? "0.0.0-dev");
