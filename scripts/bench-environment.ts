import { readFileSync } from "node:fs";
function redactValue(value: string): string {
  return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, (url) =>
    url.replace(/^(\w[\w+.-]*:\/\/)[^/?#]*@/, "$1<set>@")
      .replace(/([?&])([^=&#]+)=([^&#]*)/g, (parameter, separator, name) => {
        let decoded = name;
        try { decoded = decodeURIComponent(name); } catch { /* preserve malformed names */ }
        return /password|passwd|pwd|token|key|secret|credential|auth|signature/i.test(decoded)
          ? `${separator}${name}=<set>` : parameter;
      }),
  );
}
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
          /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) ? "<set>" : redactValue(s.slice(i + 1)),
        ];
      }),
  );
}
export function processEnvironment(pid: number) {
  return performanceEnvironment(readFileSync(`/proc/${pid}/environ`, "utf8"));
}
