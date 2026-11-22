//! `packages/rtk/src/catalog.ts`: the filter-family vocabulary. A storage
//! contract — `request_logs.rtk_filters` holds these spellings.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RtkFilterId {
    GitDiff,
    GitStatus,
    GitLog,
    Grep,
    PathList,
    NumberedRead,
    BuildOutput,
    TestOutput,
    DeduplicateLog,
    SmartTruncate,
    LintOutput,
    PackageOutput,
    TreeOutput,
    GitOperation,
    DockerBuild,
}

/// `RTK_FILTER_IDS`, in catalog order.
pub const RTK_FILTER_IDS: [RtkFilterId; 15] = [
    RtkFilterId::GitDiff,
    RtkFilterId::GitStatus,
    RtkFilterId::GitLog,
    RtkFilterId::Grep,
    RtkFilterId::PathList,
    RtkFilterId::NumberedRead,
    RtkFilterId::BuildOutput,
    RtkFilterId::TestOutput,
    RtkFilterId::DeduplicateLog,
    RtkFilterId::SmartTruncate,
    RtkFilterId::LintOutput,
    RtkFilterId::PackageOutput,
    RtkFilterId::TreeOutput,
    RtkFilterId::GitOperation,
    RtkFilterId::DockerBuild,
];

impl RtkFilterId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GitDiff => "git-diff",
            Self::GitStatus => "git-status",
            Self::GitLog => "git-log",
            Self::Grep => "grep",
            Self::PathList => "path-list",
            Self::NumberedRead => "numbered-read",
            Self::BuildOutput => "build-output",
            Self::TestOutput => "test-output",
            Self::DeduplicateLog => "deduplicate-log",
            Self::SmartTruncate => "smart-truncate",
            Self::LintOutput => "lint-output",
            Self::PackageOutput => "package-output",
            Self::TreeOutput => "tree-output",
            Self::GitOperation => "git-operation",
            Self::DockerBuild => "docker-build",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        RTK_FILTER_IDS.into_iter().find(|id| id.as_str() == value)
    }
}

/// `isRtkFilterId`.
pub fn is_rtk_filter_id(value: &Value) -> bool {
    value.as_str().and_then(RtkFilterId::parse).is_some()
}
