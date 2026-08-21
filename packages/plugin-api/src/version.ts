/**
 * The two version numbers, alone in a module with no dependencies.
 *
 * Split out because `manifest.ts` imports zod, and anything that reaches for a
 * version number through it drags a validator along. The dashboard SDK re-exports
 * `DASHBOARD_SDK_VERSION`, and every plugin UI bundle imports the SDK — so with
 * these living beside the schema, half a megabyte of zod ended up in a bundle
 * whose only crime was wanting a string.
 */

/**
 * The plugin API generation the host implements.
 *
 * A manifest declares the generation it was built against and is skipped on
 * mismatch. Bump this whenever `PluginContext`, an event payload, or the
 * manifest schema changes in a way an existing plugin would not survive.
 *
 * **Deliberately not the npm major of `@omnigateway/plugin-api`.** The two moved
 * together while the package was heading for `1.0.0`, and tying them looked
 * tidy, but they cannot both be right across the `0.x` boundary: this is a
 * counter that only ever increases, and semver resets the major to 1 on the day
 * a `0.x` package stabilises. A rule mapping them would have to make this number
 * go backwards exactly once, which is the one thing a compatibility generation
 * may never do.
 *
 * So they are independent, and only this one decides whether a plugin loads.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * The dashboard SDK version the shipped console provides.
 *
 * A plugin's manifest declares an `sdk` semver range and the host checks it
 * against this. Separate from `PLUGIN_API_VERSION` on purpose: a backend-only
 * plugin should not stop loading because the console's React moved, and a UI
 * incompatibility should disable only the UI.
 *
 * `0.1.1` added `useLive` and made the SDK a shared module. A patch and not a
 * minor, and the difference is not cosmetic while this package is pre-1.0:
 * `^0.1.0` means `>=0.1.0 <0.2.0`, so `0.2.0` would disable the UI of every
 * plugin already published against `^0.1.0` — each one reported as a version
 * mismatch it did nothing to earn. The change is additive, so it does not get
 * to cost that.
 *
 * **Changing this line means republishing _this_ package, not just the SDK.**
 * It reads as an SDK fact and it lives here, so the obvious move — bump
 * `packages/dashboard-sdk`, tag, done — leaves the registry with a
 * `@omnigateway/plugin-api` that still reports the old number to every plugin
 * author who installs it. That shipped: `v0.4.8` published
 * `dashboard-sdk@0.1.1` while `plugin-api@0.1.0` went on exporting `"0.1.0"`,
 * because the release step skips a package whose version has not moved. The
 * gateway itself was unaffected — it reads this source — so nothing failed
 * until a plugin tested its own manifest against the version the registry
 * advertised. `publishable.test.ts` now refuses a state where this package
 * trails the SDK.
 */
export const DASHBOARD_SDK_VERSION = "0.1.1";
