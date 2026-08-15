/**
 * Lets a recharts panel measure itself, for the few assertions that are about
 * the geometry a chart actually draws.
 *
 * The suite pins every element to the -1 sentinel of `setup/happydom.ts` so
 * responsive containers stay unrendered and nothing schedules resize work
 * outside an act boundary. A test that needs a real path has to opt back in,
 * and put both globals back when it is done.
 */
export function measureCharts(width = 480, height = 200): () => void {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  const observer = globalThis.ResizeObserver;

  HTMLElement.prototype.getBoundingClientRect = function measured(): DOMRect {
    return new DOMRect(0, 0, width, height);
  };

  class Measured implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ target, contentRect: new DOMRect(0, 0, width, height) } as ResizeObserverEntry],
        this,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = Measured as unknown as typeof ResizeObserver;

  return () => {
    HTMLElement.prototype.getBoundingClientRect = rect;
    globalThis.ResizeObserver = observer;
  };
}

/** The `d` of every line drawn, one per series, in render order. */
export function linePaths(container: HTMLElement): string[] {
  return [...container.querySelectorAll("path.recharts-line-curve")].map(
    (path) => path.getAttribute("d") ?? "",
  );
}

/** The corners of a path. Only `M`/`L` commands have them; a curve has none. */
export function vertices(d: string): Array<[x: number, y: number]> {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
}
