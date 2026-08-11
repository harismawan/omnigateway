export const RTK_FILTER_IDS = [
  "git-diff",
  "git-status",
  "git-log",
  "grep",
  "path-list",
  "numbered-read",
  "build-output",
  "test-output",
  "deduplicate-log",
  "smart-truncate",
  "lint-output",
  "package-output",
  "tree-output",
  "git-operation",
  "docker-build",
] as const;

export type RtkFilterId = (typeof RTK_FILTER_IDS)[number];

const FILTER_IDS: ReadonlySet<unknown> = new Set(RTK_FILTER_IDS);

export function isRtkFilterId(value: unknown): value is RtkFilterId {
  return FILTER_IDS.has(value);
}
