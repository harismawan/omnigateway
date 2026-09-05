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
 *
 * **`2` because `ctx.provider.register` was removed.** A plugin supplying a
 * provider now declares it as `PluginDefinition.providers`; one written against
 * generation 1 calls a member of `PluginContext` that no longer exists. That is
 * exactly what this counter is for, and the commit that removed the capability
 * left it at `1` — so `omni plugin verify`, the command whose entire purpose is
 * confidence before a restart, answered "this plugin would load", and the
 * gateway then reported `undefined is not an object (evaluating
 * 'ctx.provider.register')`. A raw TypeError where a version mismatch belongs.
 *
 * The rule above is easy to read as being about *additions* to the context and
 * to skip for a removal. Both directions break an existing plugin; a removal
 * breaks it louder.
 *
 * **`3` because `ctx.storage` became asynchronous.** Every method returns a
 * promise, and `transaction` takes an async function. A plugin written
 * against generation 2 reads a promise where it expects rows and finds
 * `undefined` members on it — a shape change, not a removal, and the counter
 * covers both. The change is what lets a store other than SQLite serve
 * plugin storage at all.
 *
 * **Still `3` after `PluginChannel.broadcast`**, which is the rule above read
 * literally: an existing plugin survives an addition. One written against a
 * host that has it and run against one that does not calls a member that is
 * absent, so a plugin using it feature-detects — the same posture it already
 * has to take for a capability its manifest declared and the host did not
 * supply. What a generation may not do is rise for every addition, because
 * every bump refuses every plugin published against the one before it.
 */
export const PLUGIN_API_VERSION = 3;

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
 * `0.1.2` added the push transport: `cadence` gained an optional `topic` and
 * `LiveContextValue` gained `connection`. A patch for the same reason, and the
 * WebSocket design's own text calling it a minor is the thing being overruled
 * here rather than an oversight. Both halves are additive — `cadence(ms)` still
 * means what it meant, and `connection` is on a type plugins consume and cannot
 * construct, since `LiveContext` is not exported. A 0.1.1 panel keeps polling
 * on its interval, which is not a degradation but the fallback path this design
 * keeps permanently. What a patch costs is the mechanical signal: a plugin
 * author learns the topic argument exists from release notes rather than from a
 * version mismatch. That is the cheaper of the two costs. Reserve the minor for
 * the first genuine narrowing, with a deprecation window.
 *
 * `0.1.3` changed no API at all. It exists because `package.json` did: this
 * package's own dependency range on `@omnigateway/plugin-api` was `^0.1.0`,
 * which under 0.x means `>=0.1.0 <0.2.0` and so excluded the `0.2.0` published
 * beside it. Every `bun add @omnigateway/dashboard-sdk` therefore resolved
 * generation **1** transitively, against a gateway that refuses `api: 1` — an
 * install that could not produce a loadable plugin, with nothing in either
 * package's source to show for it. Correcting the range in the repository fixes
 * nobody's `node_modules`, because the release step skips a package whose
 * version has not moved; the version is the only part of the repair a consumer
 * can see. A patch, since the surface a plugin compiles against is unchanged and
 * every published `sdk: "^0.1.0"` range should go on matching.
 *
 * `0.1.4` added `usePluginChannel`, and with it the client half of plugin
 * channels: a panel can hold its own plugin's topic on the console's socket,
 * receive frames on it and publish back. A patch on the same reasoning as
 * `0.1.2` — the hook is new, `LiveContextValue.channels` is optional and sits
 * on a type a panel consumes but cannot construct, and a `0.1.3` panel keeps
 * doing exactly what it did. Reserve the minor for the first genuine
 * narrowing, with a deprecation window.
 *
 * `0.1.6` changed no API either, and exists for the reason `0.1.3` did: this
 * package moved to `0.4.0` for `PluginChannel.broadcast`, and the SDK's own
 * dependency range on it — `^0.3.0`, which under 0.x excludes `0.4.0` — had to
 * widen with it. A range corrected in the repository is invisible from a
 * stranger's `node_modules`; the version is the only part of that repair a
 * consumer can see.
 *
 * `0.1.7` changed no API either. It exists because `--p-antigravity` joined
 * `CSS_VARIABLES` — the list of palette names the console guarantees are
 * defined — which is an addition a panel can rely on and therefore a version a
 * panel can ask for. This package moved to `0.4.1` alongside it, for the reason
 * the paragraph below gives.
 *
 * `0.1.8` is `--p-muse`, on the same terms as the entry before it: additive, so
 * every earlier panel keeps resolving the names it already used. It moves
 * because `muse` landed after the release that carried `0.1.7`, not because
 * anything about that release was wrong.
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
export const DASHBOARD_SDK_VERSION = "0.1.8";
