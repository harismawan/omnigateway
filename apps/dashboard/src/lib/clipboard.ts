/**
 * What a copy attempt actually achieved.
 *
 * `selected` is the honest middle case: the value is highlighted and one
 * keystroke away, but nothing reached the clipboard. Reporting it as success
 * would be the dangerous answer for a value shown only once.
 */
export type CopyOutcome = "copied" | "selected" | "failed";

/** Highlights an element's text so the operator can copy it by hand. */
export function selectText(node: HTMLElement | null): boolean {
  if (node === null || typeof getSelection !== "function") return false;

  const selection = getSelection();
  if (selection === null) return false;

  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies a value, reporting what happened rather than assuming it worked.
 *
 * The async clipboard API exists only in a secure context — HTTPS, or
 * localhost. A self-hosted gateway reached over plain HTTP on a LAN has no
 * `navigator.clipboard` at all, so the modern path is simply absent for a large
 * share of this project's deployments and the legacy path below carries them.
 *
 * Either way the value ends up selected, so a browser that refuses both still
 * leaves the operator one keystroke from the value.
 */
export async function copyText(
  value: string,
  fallbackNode?: HTMLElement | null,
): Promise<CopyOutcome> {
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(value);
      return "copied";
    } catch {
      // Blocked by permissions policy, or the document was not focused.
      // Fall through rather than reporting a copy that did not happen.
    }
  }

  const selected = selectText(fallbackNode ?? null);
  if (selected && typeof document.execCommand === "function") {
    try {
      if (document.execCommand("copy")) return "copied";
    } catch {
      // Some browsers throw here instead of returning false.
    }
  }

  return selected ? "selected" : "failed";
}
