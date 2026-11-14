import { readFileSync } from "node:fs";
export function performanceEnvironment(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .split("\0")
      .filter((s) => /^(OMNI_|MIMALLOC_)/.test(s))
      .map((s) => {
        const i = s.indexOf("=");
        const name = s.slice(0, i);
        return [
          name,
          /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) ? "<set>" : s.slice(i + 1),
        ];
      }),
  );
}
export function processEnvironment(pid: number) {
  return performanceEnvironment(readFileSync(`/proc/${pid}/environ`, "utf8"));
}
