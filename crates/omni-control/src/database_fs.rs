//! Frozen nodeFs read semantics: every stat/readdir error becomes absence.
//! Mutations (mkdir, write, unlink, rename) are fallible and remain propagated
//! by their callers; unlink alone tolerates a missing target, like rm(force).
use std::{fs, path::Path};

pub fn stat(path: &Path) -> Option<fs::Metadata> {
    fs::metadata(path).ok()
}

pub fn readdir(path: &Path) -> Vec<fs::DirEntry> {
    fs::read_dir(path)
        .and_then(|entries| entries.collect::<Result<Vec<_>, _>>())
        .unwrap_or_default()
}
