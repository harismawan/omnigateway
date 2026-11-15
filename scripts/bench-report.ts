/** Failed observations expose diagnostics, never performance numbers. */
export function showPerformance(matrix: boolean, classification?: string): boolean {
  return !matrix || classification === "supported";
}
