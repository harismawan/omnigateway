import type { Subprocess } from "bun";

export async function collectVerifierReport(child: Subprocess) {
  try {
    const text = await new Response(child.stdout as ReadableStream).text();
    await child.exited;
    const report = JSON.parse(text);
    if (
      !report ||
      !Number.isFinite(report.requests) ||
      !Array.isArray(report.errors) ||
      !report.errors.every((error: unknown) => typeof error === "string")
    )
      throw Error("invalid report");
    return report as { requests: number; errors: string[]; rate: number };
  } catch {
    return { requests: 0, errors: ["verifier produced no report"], rate: 4 };
  }
}
