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

/**
 * The `d` of every line drawn with one dash pattern; `null` selects the solid
 * ones. A chart that overlays inferred lines on measured ones tells them apart
 * by pattern rather than by colour, so this is how a test asks for one of them.
 */
export function dashedPaths(container: HTMLElement, pattern: string | null): string[] {
  return [...container.querySelectorAll("path.recharts-line-curve")]
    .filter((path) => (path.getAttribute("stroke-dasharray") ?? null) === pattern)
    .map((path) => path.getAttribute("d") ?? "");
}

/**
 * The tick labels one axis rendered, in document order.
 *
 * Labels sit in their own z-index layer rather than inside the axis group, and
 * the measurement sentinel makes every one of them look 480px wide, so recharts
 * drops all but the ones that still fit. What is left is enough to read the
 * end of a scale off, which is what a domain assertion needs.
 */
export function axisTicks(container: HTMLElement, axis: "xAxis" | "yAxis"): string[] {
  return [
    ...container.querySelectorAll(
      `.recharts-${axis}-tick-labels .recharts-cartesian-axis-tick-value`,
    ),
  ].map((tick) => tick.textContent ?? "");
}

/**
 * Where a path actually arrives, one point per command.
 *
 * `vertices` reads corners, which a smooth curve does not have. This reads the
 * endpoint of every `M`/`L`/`C` instead, so a test can still ask which readings
 * a curve passes through without caring how it got between them.
 */
export function curvePoints(d: string): Array<[x: number, y: number]> {
  return [...d.matchAll(/[MLC][^MLC]*?(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?=[MLC]|$)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
}

/**
 * Where every line dot was drawn, in document order.
 *
 * A run of one reading has no stroke to see — two points is the least a line
 * needs — so its dot is the whole of it, and counting dots is how a test asks
 * whether that run rendered at all.
 */
export function lineDots(container: HTMLElement): Array<[x: number, y: number]> {
  return [...container.querySelectorAll("circle.recharts-line-dot")].map((dot) => [
    Number(dot.getAttribute("cx")),
    Number(dot.getAttribute("cy")),
  ]);
}

/** The corners of a path. Only `M`/`L` commands have them; a curve has none. */
export function vertices(d: string): Array<[x: number, y: number]> {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
}
