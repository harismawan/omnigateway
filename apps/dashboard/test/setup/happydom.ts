import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
  return new DOMRect(0, 0, -1, -1);
};

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
