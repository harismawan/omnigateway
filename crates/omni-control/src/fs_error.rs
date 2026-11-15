//! Node-compatible filesystem diagnostics shared by operator front ends.
pub fn fs_error(e: &std::io::Error, operation: &str, path: &std::path::Path) -> String {
    let (code, description) = match e.raw_os_error() {
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(17) => ("EEXIST", "file already exists"),
        Some(20) => ("ENOTDIR", "not a directory"),
        Some(21) => ("EISDIR", "illegal operation on a directory"),
        Some(28) => ("ENOSPC", "no space left on device"),
        Some(30) => ("EROFS", "read-only file system"),
        _ => return e.to_string(),
    };
    if operation == "write" || (operation == "read" && e.raw_os_error() == Some(21)) {
        return format!("{code}: {description}, {operation}");
    }
    format!("{code}: {description}, {operation} '{}'", path.display())
}
