import type { HeaderPair } from "./types.ts";

/**
 * The header vocabulary every per-provider profile is built from.
 *
 * Split out of `profile.ts` because the dependency has to run one way only.
 * `profile.ts` imports each `<id>/profile.ts` to assemble `PROFILES`, so if
 * those files read their helpers back out of `profile.ts` the two form a cycle,
 * and a cycle here does not surface as a type error. It surfaces as
 * `Cannot access 'SAFE' before initialization` — thrown from `env`, at module
 * scope, and *only on the branch that reads an env override*, because `env`
 * returns its fallback before touching `SAFE` when the variable is unset. A
 * suite with no overrides set stays green while every operator who sets one
 * gets a gateway that will not boot.
 *
 * Nothing in here imports anything but a type, which is what keeps that true.
 */
export type ClientProfile = {
  /** Headers with the CLI's own name casing, in declaration order. */
  readonly headers: readonly HeaderPair[];
  /** Canonical wire order. Matched case-insensitively; unlisted names append. */
  readonly order: readonly string[];
};

/** Rejects anything that cannot go in a header value. */
const SAFE = /^[\x20-\x7E]{1,200}$/;

export function env(name: string, fallback: string): string {
  const raw = Bun.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  return SAFE.test(raw) ? raw : fallback;
}

/** Blank means "derive from host", so this distinguishes unset from set. */
export function envOrNull(name: string): string | null {
  const raw = Bun.env[name];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return SAFE.test(raw) ? raw : null;
}

export function envOrder(name: string, fallback: readonly string[]): readonly string[] {
  const raw = Bun.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && SAFE.test(s));
  return parts.length > 0 ? parts : fallback;
}

/** Stainless spells the platform differently from node:process. */
export function stainlessHost(platform: string, arch: string): { os: string; arch: string } {
  const os =
    platform === "darwin"
      ? "MacOS"
      : platform === "linux"
        ? "Linux"
        : platform === "win32"
          ? "Windows"
          : "Unknown";
  return { os, arch };
}

/**
 * Grok spells the platform differently again: lowercase OS, and `arm64` under
 * its GNU name. Deliberately not folded into {@link stainlessHost} — the two
 * agree on nothing but the input, and one helper serving both would have to
 * branch on the caller anyway.
 */
export function grokHost(platform: string, arch: string): { os: string; arch: string } {
  return { os: platform.toLowerCase(), arch: arch === "arm64" ? "aarch64" : arch };
}

/**
 * Reorders headers to a canonical wire order.
 *
 * Names are matched case-insensitively but emitted with the casing they were
 * given, because the casing is itself part of the fingerprint. Names not in
 * `order` are appended in their original relative order.
 */
export function orderHeaders(pairs: readonly HeaderPair[], order: readonly string[]): HeaderPair[] {
  const remaining = [...pairs];
  const out: HeaderPair[] = [];
  for (const name of order) {
    const lower = name.toLowerCase();
    const at = remaining.findIndex(([n]) => n.toLowerCase() === lower);
    if (at !== -1) out.push(...remaining.splice(at, 1));
  }
  out.push(...remaining);
  return out;
}

/**
 * Overlays headers onto a base set.
 *
 * A replaced header keeps the base's position but takes the override's value
 * and casing. New headers append. Position is preserved because reordering
 * happens later, against the profile's `order`, and a header that arrived
 * out of band should not jump the queue on its own.
 */
export function mergeHeaders(
  base: readonly HeaderPair[],
  overrides: readonly HeaderPair[],
): HeaderPair[] {
  const out: HeaderPair[] = [...base];
  for (const [name, value] of overrides) {
    const lower = name.toLowerCase();
    const at = out.findIndex(([n]) => n.toLowerCase() === lower);
    if (at === -1) out.push([name, value]);
    else out[at] = [name, value];
  }
  return out;
}
