import { afterEach, describe, expect, test } from "bun:test";
import { copyText, selectText } from "../../src/lib/clipboard.ts";

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  });
}

function stubExecCommand(result: boolean | (() => boolean)) {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: typeof result === "function" ? result : () => result,
  });
}

function node(text: string): HTMLElement {
  const element = document.createElement("code");
  element.textContent = text;
  document.body.append(element);
  return element;
}

afterEach(() => {
  Reflect.deleteProperty(document, "execCommand");
  document.body.innerHTML = "";
});

describe("copyText", () => {
  test("uses the clipboard API when the page is a secure context", async () => {
    const written: string[] = [];
    stubClipboard((text) => {
      written.push(text);
      return Promise.resolve();
    });

    await expect(copyText("omni_sk_secret", node("omni_sk_secret"))).resolves.toBe("copied");
    expect(written).toEqual(["omni_sk_secret"]);
  });

  test("falls back to the legacy path when there is no clipboard API", async () => {
    // A gateway on plain HTTP is not a secure context, so navigator.clipboard
    // is undefined rather than merely restricted.
    stubClipboard(undefined);
    stubExecCommand(true);

    await expect(copyText("omni_sk_secret", node("omni_sk_secret"))).resolves.toBe("copied");
  });

  test("falls back when the clipboard API rejects", async () => {
    stubClipboard(() => Promise.reject(new Error("document is not focused")));
    stubExecCommand(true);

    await expect(copyText("omni_sk_secret", node("omni_sk_secret"))).resolves.toBe("copied");
  });

  test("reports `selected`, not success, when the copy itself is refused", async () => {
    stubClipboard(undefined);
    stubExecCommand(false);

    await expect(copyText("omni_sk_secret", node("omni_sk_secret"))).resolves.toBe("selected");
  });

  test("survives an execCommand that throws", async () => {
    stubClipboard(undefined);
    stubExecCommand(() => {
      throw new Error("not allowed");
    });

    await expect(copyText("omni_sk_secret", node("omni_sk_secret"))).resolves.toBe("selected");
  });

  test("reports `failed` when there is nothing to select and nothing to copy with", async () => {
    stubClipboard(undefined);

    await expect(copyText("omni_sk_secret", null)).resolves.toBe("failed");
  });

  test("never reports a copy the browser did not make", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));

    // No fallback node and no execCommand: the only honest answer is failure.
    await expect(copyText("omni_sk_secret", null)).resolves.toBe("failed");
  });
});

describe("selectText", () => {
  test("selects an element's contents", () => {
    const element = node("omni_sk_secret");
    expect(selectText(element)).toBe(true);
    expect(getSelection()?.toString()).toBe("omni_sk_secret");
  });

  test("reports failure rather than throwing on a missing node", () => {
    expect(selectText(null)).toBe(false);
  });
});
