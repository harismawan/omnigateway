const ORIGINS = new Set([
  "https://api1.qoder.sh",
  "https://api2.qoder.sh",
  "https://api3.qoder.sh",
]);

export function trustedInferenceOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Compare raw text too: URL normalization would hide dot paths, whitespace and empty queries.
  const origin = value.endsWith("/") ? value.slice(0, -1) : value;
  return ORIGINS.has(origin) ? origin : null;
}
