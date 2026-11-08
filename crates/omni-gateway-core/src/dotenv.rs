//! The environment the gateway sees: the ambient environment plus the
//! working directory's `.env` files, loaded the way Bun 1.4.4 auto-loads
//! them into `process.env` for `bun apps/gateway/src/index.ts`.
//!
//! Ported from Bun's own loader (`src/dotenv/env_loader.rs` at `bun-v1.4.4`)
//! and checked against `bun -e` in `tests/dotenv.rs`:
//!
//! - **Files**, highest priority first: `.env.<mode>.local`, `.env.local`
//!   (not under `test`), `.env.<mode>`, `.env`. The mode is `production` or
//!   `test` when `BUN_ENV` (else `NODE_ENV`) says so, and `development`
//!   otherwise.
//! - **Precedence.** The ambient environment wins over every file, and an
//!   earlier file wins over a later one. Inside one file a later line wins.
//! - **Expansion.** `$NAME`, `${NAME}` and `${NAME:-default}` expand against
//!   everything loaded so far (ambient included), in every value a file sets,
//!   single-quoted ones too. `\$` is a literal `$`. Ambient values are never
//!   expanded.
//! - **Parsing.** `export ` prefix, `KEY: value` with whitespace after the
//!   colon, keys of `[A-Za-z0-9_.-]`, `"`/`'`/`` ` `` quotes spanning lines,
//!   `\n`/`\r` escapes in double quotes only, `#` comments, a UTF-8 BOM.
//!
//! This is not the CLI's `parseEnvFile` (which has no expansion); the CLI
//! reads a root's `.env` itself.

use indexmap::IndexMap;
use std::path::Path;

const WHITESPACE: &[u8] = b"\t\x0B\x0C \n\r";

fn is_ws(b: u8) -> bool {
    WHITESPACE.contains(&b)
}

/// The env being built, in insertion order (which decides what a file may
/// override).
type Map = IndexMap<Vec<u8>, Vec<u8>>;

struct Parser<'a> {
    pos: usize,
    src: &'a [u8],
}

impl Parser<'_> {
    fn skip_line(&mut self) {
        match self.src[self.pos..]
            .iter()
            .position(|b| *b == b'\n' || *b == b'\r')
        {
            Some(i) => self.pos += i + 1,
            None => self.pos = self.src.len(),
        }
    }

    fn skip_whitespaces(&mut self) {
        while self.pos < self.src.len() && is_ws(self.src[self.pos]) {
            self.pos += 1;
        }
    }

    fn parse_key(&mut self, check_export: bool) -> Option<Vec<u8>> {
        if check_export {
            self.skip_whitespaces();
        }
        let start = self.pos;
        let mut end = start;
        while end < self.src.len()
            && matches!(self.src[end], b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-' | b'.')
        {
            end += 1;
        }
        if end < self.src.len() && start < end {
            self.pos = end;
            self.skip_whitespaces();
            if self.pos < self.src.len() {
                if check_export
                    && end < self.pos
                    && &self.src[start..end] == b"export"
                    && let Some(key) = self.parse_key(false)
                {
                    return Some(key);
                }
                match self.src[self.pos] {
                    b'=' => {
                        self.pos += 1;
                        return Some(self.src[start..end].to_vec());
                    }
                    b':' => {
                        let next = self.pos + 1;
                        if next < self.src.len() && is_ws(self.src[next]) {
                            self.pos += 2;
                            return Some(self.src[start..end].to_vec());
                        }
                    }
                    _ => {}
                }
            }
        }
        self.pos = start;
        None
    }

    /// The value between the quotes, or `None` when the quote never closes.
    fn parse_quoted(&mut self, quote: u8) -> Option<Vec<u8>> {
        let start = self.pos;
        let mut end = start + 1;
        while end < self.src.len() {
            let b = self.src[end];
            if b == b'\\' {
                end += 2;
                continue;
            }
            if b == quote {
                end += 1;
                self.pos = end;
                self.skip_line();
                let mut out = Vec::with_capacity(end - start);
                let mut i = start;
                while i < end {
                    match self.src[i] {
                        b'\\' if quote == b'"' => {
                            match self.src.get(i + 1) {
                                Some(b'n') => out.push(b'\n'),
                                Some(b'r') => out.push(b'\r'),
                                _ => out.extend_from_slice(&self.src[i..(i + 2).min(end)]),
                            }
                            i += 2;
                        }
                        b'\\' => {
                            out.push(b'\\');
                            i += 1;
                        }
                        b'\r' => {
                            i += 1;
                            if i >= end || self.src[i] != b'\n' {
                                out.push(b'\n');
                            }
                        }
                        c => {
                            out.push(c);
                            i += 1;
                        }
                    }
                }
                // Strip the quotes themselves.
                return Some(out[1..out.len() - 1].to_vec());
            }
            end += 1;
        }
        None
    }

    fn parse_value(&mut self) -> Vec<u8> {
        let start = self.pos;
        self.skip_whitespaces();
        if self.pos >= self.src.len() {
            return Vec::new();
        }
        let quote = self.src[self.pos];
        if matches!(quote, b'`' | b'"' | b'\'')
            && let Some(v) = self.parse_quoted(quote)
        {
            return v;
        }
        let mut end = start;
        while end < self.src.len() && !matches!(self.src[end], b'#' | b'\r' | b'\n') {
            end += 1;
        }
        self.pos = end;
        let raw = &self.src[start..end];
        let first = raw.iter().position(|b| !is_ws(*b)).unwrap_or(raw.len());
        let last = raw
            .iter()
            .rposition(|b| !is_ws(*b))
            .map_or(first, |i| i + 1);
        raw[first..last.max(first)].to_vec()
    }
}

fn is_ident(b: u8) -> bool {
    matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_')
}

/// `expand_into`: left-to-right `$NAME` / `${NAME}` / `${NAME:-default}`.
fn expand_into(map: &Map, value: &[u8], out: &mut Vec<u8>, depth: u8) -> bool {
    let mut pos = 0;
    let mut changed = false;
    while pos < value.len() {
        let b = value[pos];
        if b == b'\\' && value.get(pos + 1) == Some(&b'$') {
            out.push(b'$');
            pos += 2;
            changed = true;
            continue;
        }
        if b != b'$' || pos + 1 >= value.len() {
            out.push(b);
            pos += 1;
            continue;
        }
        let next = value[pos + 1];
        if next == b'{' {
            let inner_start = pos + 2;
            let mut i = inner_start;
            let mut nest = 1usize;
            let close = loop {
                if i >= value.len() {
                    break None;
                }
                match value[i] {
                    b'\\' if i + 1 < value.len() => i += 2,
                    b'$' if value.get(i + 1) == Some(&b'{') => {
                        nest += 1;
                        i += 2;
                    }
                    b'}' => {
                        nest -= 1;
                        if nest == 0 {
                            break Some(i);
                        }
                        i += 1;
                    }
                    _ => i += 1,
                }
            };
            let Some(close) = close else {
                out.extend_from_slice(&value[pos..]);
                pos = value.len();
                continue;
            };
            changed = true;
            let inner = &value[inner_start..close];
            let key_end = inner
                .iter()
                .position(|c| !is_ident(*c))
                .unwrap_or(inner.len());
            let (key, rest) = inner.split_at(key_end);
            if rest.is_empty() {
                if let Some(v) = map.get(key) {
                    out.extend_from_slice(v);
                }
            } else if let Some(default) = rest.strip_prefix(b":-") {
                if let Some(v) = map.get(key) {
                    out.extend_from_slice(v);
                } else if depth < 200 {
                    expand_into(map, default, out, depth + 1);
                } else {
                    out.extend_from_slice(default);
                }
            } else {
                out.extend_from_slice(&value[pos..=close]);
            }
            pos = close + 1;
            continue;
        }
        if is_ident(next) {
            changed = true;
            let key_start = pos + 1;
            let mut k = key_start;
            while k < value.len() && is_ident(value[k]) {
                k += 1;
            }
            if let Some(v) = map.get(&value[key_start..k]) {
                out.extend_from_slice(v);
            }
            pos = k;
            continue;
        }
        out.push(b'$');
        pos += 1;
    }
    changed
}

/// One file into `map`: never overriding what was there before it, then
/// expanding what it added, in order.
fn parse_into(src: &[u8], map: &mut Map) {
    let src = src.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(src);
    let count = map.len();
    let mut p = Parser { pos: 0, src };
    while p.pos < src.len() {
        let Some(key) = p.parse_key(true) else {
            p.skip_line();
            continue;
        };
        let value = p.parse_value();
        match map.get_index_of(&key) {
            Some(index) if index < count => {}
            _ => {
                map.insert(key, value);
            }
        }
    }
    for idx in count..map.len() {
        let current = map[idx].clone();
        if current.len() < 2 {
            continue;
        }
        let mut out = Vec::new();
        if expand_into(map, &current, &mut out, 0) {
            map[idx] = out;
        }
    }
}

/// `DotEnvFileSuffix`, from `BUN_ENV` else `NODE_ENV`.
fn mode(map: &Map) -> &'static str {
    let node_env = map
        .get(b"BUN_ENV".as_slice())
        .or_else(|| map.get(b"NODE_ENV".as_slice()));
    match node_env.map(Vec::as_slice) {
        Some(b"production") => "production",
        Some(b"test") => "test",
        _ => "development",
    }
}

/// Reads a regular file; anything else (missing, a directory, unreadable)
/// contributes nothing, as in Bun.
fn read(dir: &Path, name: &str) -> Option<Vec<u8>> {
    let path = dir.join(name);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    std::fs::read(path).ok()
}

/// The environment the gateway would see started in `dir`.
///
/// I/O errors on the files are swallowed exactly where Bun swallows them,
/// so this only fails on nothing; it returns `Result` for the caller's
/// boot-error path should that change.
pub fn load_env(
    dir: &Path,
    ambient: impl IntoIterator<Item = (String, String)>,
) -> Result<std::collections::HashMap<String, String>, std::io::Error> {
    let mut map = Map::new();
    for (k, v) in ambient {
        if !k.is_empty() {
            map.insert(k.into_bytes(), v.into_bytes());
        }
    }
    let mode = mode(&map);
    let mut files = vec![format!(".env.{mode}.local")];
    if mode != "test" {
        files.push(".env.local".to_owned());
    }
    files.push(format!(".env.{mode}"));
    files.push(".env".to_owned());
    for name in files {
        if let Some(src) = read(dir, &name) {
            parse_into(&src, &mut map);
        }
    }
    Ok(map
        .into_iter()
        .map(|(k, v)| {
            (
                String::from_utf8_lossy(&k).into_owned(),
                String::from_utf8_lossy(&v).into_owned(),
            )
        })
        .collect())
}

/// [`load_env`] over the process environment and working directory.
pub fn load_process_env() -> Result<std::collections::HashMap<String, String>, std::io::Error> {
    let dir = std::env::current_dir()?;
    load_env(
        &dir,
        std::env::vars_os().map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        }),
    )
}
