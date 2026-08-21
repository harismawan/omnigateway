# Federating the dashboard SDK

Written 2026-08-21. Amends the plugin-host design of 2026-08-19, which recorded
the SDK as a leaf a plugin bundles for itself.

## The problem

The console has one polling control: a LIVE switch in the chassis bar, backed by
a React context, feeding every board's `refetchInterval` through `cadence(ms)`.
Its own comment states the principle — polling is the gateway's only push
mechanism, so pausing it has to be one deliberate control rather than a setting
hidden per screen.

Plugin panels were outside that. Not by decision: a panel renders under
`LiveProvider` (the provider wraps the whole authenticated shell), so the
context is above it in the tree, but the panel had no way to name it. The SDK
was bundled into each plugin, so a context created there would be a different
object from the console's, and `useLive` would fall through to its
no-provider default.

That default is `live: false`. So the naive version of this feature — put
`useLive` in the SDK, leave the SDK bundled — does not produce a panel that
ignores the switch. It produces a panel that **stops polling permanently**, with
nothing thrown and nothing logged. The symptom is a screen that no longer
updates, which is also what a working pause looks like.

## The decision

`@omnigateway/dashboard-sdk` joins `SHARED_IMPORTS`, and `useLive` moves into
it. The two halves ship together or not at all.

### Why the SDK, and not a console export

`apps/dashboard/src/features/plugins/api.ts` already draws the line this follows:
the console *mirrors* shapes (checked structurally when a bundle loads) and
*imports* rules, because "a rule about what may leave a plugin's prefix held in
two places is a rule that will eventually be true in only one of them." Which
control pauses polling, and what its cadence means, is a rule. The console now
has two SDK imports instead of one, for the same stated reason.

### Why sharing is required rather than tidy

The other shared specifiers are about *instance* identity, and each breach
announces itself: two Reacts throw "invalid hook call", two styled-components
render from different stylesheets. This one is about **context** identity, and
its breach is silent. That asymmetry is the entire argument for putting the SDK
on the list rather than documenting "please externalise it".

It is also why the version bump is `0.1.1` and not `0.2.0`. Pre-1.0, `^0.1.0`
means `>=0.1.0 <0.2.0`, so a minor would disable the UI of every already-published
plugin with a version mismatch it did nothing to earn. The change is additive.

### What this costs

A plugin that does not externalise the SDK keeps working exactly as before — it
carries a private copy, never reads the context, and polls at whatever interval
it hardcoded. Nothing breaks on upgrade. What it does not get is the switch, and
it gets no warning about that, which is the residual sharp edge: the failure
mode for "forgot to externalise" is silence in both directions.

The mitigation is a test on the plugin side asserting the built bundle keeps the
SDK external. This repository cannot run that test for plugins it does not own,
so it is documented in `docs/writing-a-plugin.md` and in the SDK README, both of
which now print the SDK's own `--external` flag and say why it is the one an
author is most likely to leave off.

## What was ruled out

**A `globalThis` key holding the context**, so duplicate SDK copies still find
one object. This works and needs no federation change, and it was rejected for
the reason this codebase generally rejects that shape: it makes the safety a
convention enforced by a string rather than a structural property. The same
argument that made `ITEM_SPRITE_NAMES` a `Map` rather than an object literal.

**Leaving the switch console-side and giving panels their own toggle.** Two
controls that each look like *the* control, neither governing the other. It
contradicts the principle the switch was built on.

## Consequences to keep in view

- The host now supplies the SDK at runtime **to plugins that externalise it**,
  and for those the `sdk` semver range starts describing what will actually be
  handed over. For a plugin that still bundles its own copy the range gets
  *less* accurate, not more: the host reports 0.1.1, the gate says compatible,
  and the panel runs the 0.1.0 code inside its own bundle. That is the price of
  keeping old plugins loading, and it is worth naming rather than implying the
  gate became precise for everyone.
- `/shared/*.js` entry filenames are unhashed and served `no-cache`, so a bump
  needs no cache-busting — but an open tab keeps the resolved module for the
  document's lifetime, the same caveat `apps/gateway/src/plugins/ui.ts` records
  for plugin bundles.
- The import map is injected at build only, so under `vite dev` the console's
  own source resolves the SDK from `node_modules` — one copy, safe. Plugin
  panels do not run under the dev server at all, and did not before this
  change: `mount.tsx` loads a bundle with `import(/* @vite-ignore */ entry)`,
  which Vite deliberately does not touch, so its bare specifiers have no import
  map to resolve against — and the dev server proxies only `/api` and
  `/health`, not `/plugin-assets`, so the bundle is never fetched either way.
