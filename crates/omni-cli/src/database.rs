use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};
pub fn run(
    command: &str,
    flags: &HashMap<String, String>,
    positional: &[String],
) -> Result<String, String> {
    if command == "db-clear-bodies" && !flags.contains_key("yes") {
        confirm("delete every captured body? there is no snapshot of them")?;
    }
    let ctx = crate::context::resolve(flags)?;
    if command == "db-migrate" {
        if let Some(to) = flags.get("to") {
            if !to.starts_with("postgres") {
                return Err("--to must be a postgres:// URL".into());
            }
            if crate::status::service_status(&ctx, flags)?["running"] == true {
                return Err("a gateway is running against this installation; run omni stop first, so the copy misses nothing it is writing".into());
            }
            if !flags.contains_key("yes") {
                confirm(&format!(
                    "copy {} into {}?",
                    ctx.path.display(),
                    omni_control::database::migrate_target_label(to)
                ))?;
            }
            // D4: never open either store or connect to the deferred target.
            return Err("db migrate --to is not yet available in the Rust CLI".into());
        }
        let path = ctx.path.clone();
        let existed = path.exists();
        let store = ctx.open_migrate()?;
        store
            .get_settings()
            .map_err(crate::context::migrate_error)?;
        return Ok(if flags.contains_key("json") {
            omni_ir::jsjson::to_string_pretty(&json!({"path": path, "created": !existed}))
        } else {
            format!(
                "database  {}\nschema    {}",
                path.display(),
                if existed { "up to date" } else { "created" }
            )
        });
    }
    if command == "db-restore" {
        let running = crate::status::service_status(&ctx, flags)?;
        if running["running"] == true {
            let supervisor = running["supervisor"].as_str().unwrap_or("none");
            let who = match running["pid"].as_f64() {
                Some(pid) => format!("{supervisor}, pid {pid}"),
                None => supervisor.to_string(),
            };
            return Err(format!(
                "a gateway is running ({who}) against this installation; run omni stop first, or restore from the dashboard, which swaps the file behind its own quiesce latch"
            ));
        }
    }
    let path = ctx.path.clone();
    if command == "db-vacuum" && !flags.contains_key("json") {
        eprintln!("compacting; the gateway's writes will block until this finishes…");
    }
    let store = ctx.open()?;
    if command == "db-restore" {
        let preview = omni_control::database::validate_restore(&path, &positional[0])?;
        if flags.contains_key("dry-run") {
            return Ok(if flags.contains_key("json") {
                omni_ir::jsjson::to_string_pretty(
                    &json!({"id": positional[0], "snapshot": preview["snapshot"], "live": preview["live"]}),
                )
            } else {
                preview_table(&preview)
            });
        }
        eprintln!("{}", preview_table(&preview));
        if !flags.contains_key("yes") {
            confirm(&format!(
                "replace {} with {}?",
                path.display(),
                positional[0]
            ))?;
        }
        const RESTORE_SWAP_ENABLED: bool = true;
        if !RESTORE_SWAP_ENABLED {
            return Err("db restore is not yet available in the Rust CLI".into());
        }
        let mut store = omni_control::database::SqliteRestoreStore::new(store, path.clone());
        let result = omni_control::database::restore_snapshot(
            &mut store,
            &mut omni_control::database::LocalRestoreFiles,
            &path,
            &positional[0],
            &|| chrono::Utc::now().timestamp_millis(),
        )
        .map_err(|e| e.to_string())?;
        return Ok(if flags.contains_key("json") {
            omni_ir::jsjson::to_string_pretty(&result)
        } else {
            let mut rows = vec![
                ("restored".to_string(), positional[0].clone()),
                (
                    "undo".to_string(),
                    result["preRestoreSnapshot"]["id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                ),
            ];
            rows.extend(
                result["counts"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(key, value)| (key.clone(), value.to_string())),
            );
            let width = rows.iter().map(|(key, _)| key.len()).max().unwrap_or(0);
            rows.iter()
                .map(|(key, value)| format!("{key:width$}  {value}"))
                .collect::<Vec<_>>()
                .join("\n")
        });
    }
    if command == "db-clear-bodies" {
        let result = omni_control::database::clear_bodies(
            store.connection(),
            &path
                .parent()
                .ok_or("database has no parent")?
                .join("request_bodies"),
            chrono::Utc::now().timestamp_millis(),
        )?;
        return Ok(if flags.contains_key("json") {
            omni_ir::jsjson::to_string_pretty(&result)
        } else {
            format!(
                "removed                 {}\norphaned files removed  {}",
                result["removed"], result["orphans"]
            )
        });
    }
    if command == "db-vacuum" {
        let result = omni_control::database::vacuum(store.connection(), &path, &|| {
            chrono::Utc::now().timestamp_millis()
        })?;
        return Ok(if flags.contains_key("json") {
            omni_ir::jsjson::to_string_pretty(&result)
        } else {
            format!(
                "reclaimed  {}\ntook       {} ms",
                bytes(result["reclaimedBytes"].as_u64().unwrap_or(0)),
                result["durationMs"]
            )
        });
    }
    let dir = path.parent().ok_or("database has no parent")?;
    if command == "db-backup" {
        let snapshot = omni_control::database::create_snapshot(
            store.connection(),
            &path,
            &|| chrono::Utc::now().timestamp_millis(),
            &|| {
                let settings = omni_control::settings_value::read(&store)?;
                let setting = |key| {
                    omni_control::database::retention_number(omni_control::settings_value::get(
                        &settings, key,
                    ))
                };
                Ok((
                    setting("snapshotKeepLatest")?,
                    setting("snapshotMaxAgeDays")?,
                ))
            },
        )?;
        return Ok(if flags.contains_key("json") {
            omni_ir::jsjson::to_string_pretty(&snapshot)
        } else {
            eprintln!(
                "a snapshot carries encrypted credentials and key hashes; captured bodies are not in it"
            );
            format!(
                "snapshot  {}\nsize      {}\ntaken     {}",
                snapshot["id"].as_str().unwrap_or(""),
                bytes(snapshot["sizeBytes"].as_u64().unwrap_or(0)),
                time(snapshot["createdAt"].as_i64())
            )
        });
    }
    let snaps = snapshots(&dir.join("snapshots"));
    if command == "db-snapshots" {
        return Ok(if flags.contains_key("json") {
            omni_ir::jsjson::to_string_pretty(&json!({"snapshots":snaps}))
        } else if snaps.is_empty() {
            format!(
                "no snapshots in {}; take one with omni db backup",
                dir.join("snapshots").display()
            )
        } else {
            table(
                &["ID", "TAKEN", "SIZE", "REASON"],
                &snaps
                    .iter()
                    .map(|s| {
                        vec![
                            s["id"].as_str().unwrap_or("").into(),
                            time(s["createdAt"].as_i64()),
                            bytes(s["sizeBytes"].as_u64().unwrap_or(0)),
                            s["reason"].as_str().unwrap_or("").into(),
                        ]
                    })
                    .collect::<Vec<_>>(),
                &[2],
            )
        });
    }
    let conn = store.connection();
    let scalar = |sql: &str| {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0).map(|n| n as u64))
            .map_err(|e| e.to_string())
    };
    let size = scalar("PRAGMA page_size")?;
    let pages = scalar("PRAGMA page_count")?;
    let free = scalar("PRAGMA freelist_count")?;
    let version = scalar("SELECT COALESCE(MAX(id),0) FROM migrations")?;
    let mut statement=conn.prepare("SELECT m.tbl_name AS name,SUM(s.pgsize) AS bytes,SUM(CASE WHEN s.pagetype = 'leaf' AND s.name = m.tbl_name THEN s.ncell ELSE 0 END) AS rows FROM dbstat s JOIN sqlite_master m ON m.name = s.name WHERE m.tbl_name NOT LIKE 'sqlite_%' GROUP BY m.tbl_name ORDER BY bytes DESC,name").map_err(|e|e.to_string())?;
    let tables=statement.query_map([],|r|Ok(json!({"name":String::from_utf8_lossy(r.get_ref(0)?.as_bytes()?),"bytes":r.get::<_,i64>(1)?,"rows":r.get::<_,i64>(2)?,"deadRows":null}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let settings = omni_control::settings_value::read(&store)?;
    let setting = |key| {
        omni_control::settings_value::get(&settings, key)
            .map(omni_control::settings_value::shallow)
            .unwrap_or(Value::Null)
    };
    let retention = json!({"keepLatest":setting("snapshotKeepLatest"),"maxAgeDays":setting("snapshotMaxAgeDays")});
    let file = size_of(&path);
    let wal = size_of(Path::new(&format!("{}-wal", path.display())));
    let bodies = dir_bytes(&dir.join("request_bodies"));
    let disk = rustix::fs::statfs(dir)
        .ok()
        .map(|s| s.f_bavail * (s.f_bsize as u64));
    let total = snaps
        .iter()
        .filter_map(|s| s["sizeBytes"].as_u64())
        .sum::<u64>();
    let latest = snaps.first().and_then(|s| s["createdAt"].as_i64());
    let data = json!({"engine":"sqlite","location":path,"stats":{"pageSize":size,"pageCount":pages,"freelistCount":free,"schemaVersion":version},"logicalBytes":size*pages,"freePageBytes":size*free,"retention":retention,"tables":tables,"fileBytes":file,"walBytes":wal,"bodiesBytes":bodies,"freeDiskBytes":disk,"snapshots":{"count":snaps.len(),"totalBytes":total,"latestAt":latest}});
    if flags.contains_key("json") {
        return Ok(omni_ir::jsjson::to_string_pretty(&data));
    }
    let fields = vec![
        ("database", path.display().to_string()),
        ("size", bytes(file)),
        ("write-ahead log", bytes(wal)),
        (
            "captured bodies",
            format!("{} (never snapshotted)", bytes(bodies)),
        ),
        (
            "free pages",
            format!("{} — reclaimed by omni db vacuum", bytes(size * free)),
        ),
        ("schema version", version.to_string()),
        (
            "snapshots",
            format!(
                "{} ({}), latest {}",
                snaps.len(),
                bytes(total),
                time(latest)
            ),
        ),
        (
            "retention",
            format!(
                "keep {}, up to {} days",
                omni_ir::jsjson::to_string(&retention["keepLatest"]),
                omni_ir::jsjson::to_string(&retention["maxAgeDays"])
            ),
        ),
        ("free disk", disk.map(bytes).unwrap_or("unknown".into())),
    ];
    let width = fields.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    Ok(format!(
        "{}\n\n{}",
        fields
            .iter()
            .map(|(k, v)| format!("{k:width$}  {v}"))
            .collect::<Vec<_>>()
            .join("\n"),
        table(
            &["TABLE", "SIZE", "ROWS"],
            &tables
                .iter()
                .map(|t| vec![
                    t["name"].as_str().unwrap_or("").into(),
                    bytes(t["bytes"].as_u64().unwrap_or(0)),
                    t["rows"].to_string()
                ])
                .collect::<Vec<_>>(),
            &[1, 2]
        )
    ))
}
fn snapshots(dir: &Path) -> Vec<Value> {
    let files = omni_control::database_fs::readdir(dir);
    let mut out = Vec::new();
    for f in files {
        let name = f.file_name().to_string_lossy().into_owned();
        let Some(rest) = name
            .strip_prefix("db_")
            .and_then(|s| s.strip_suffix(".sqlite"))
        else {
            continue;
        };
        let Some((stamp, reason)) = rest.split_once('_') else {
            continue;
        };
        if stamp.len() != 24
            || reason.is_empty()
            || !reason.bytes().all(|b| b.is_ascii_alphabetic())
        {
            continue;
        }
        if !stamp.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 | 13 | 16 | 19 => b == b'-',
            10 => b == b'T',
            23 => b == b'Z',
            _ => b.is_ascii_digit(),
        }) {
            continue;
        }
        let iso = format!(
            "{}:{}:{}.{}",
            &stamp[..13],
            &stamp[14..16],
            &stamp[17..19],
            &stamp[20..]
        );
        let Some(at) = crate::date::parse(&iso) else {
            continue;
        };
        out.push(json!({"id":name,"filename":name,"createdAt":at,"sizeBytes":size_of(&f.path()),"reason":reason}));
    }
    // Stable sort: ties retain directory enumeration order.
    out.sort_by_key(|s| std::cmp::Reverse(s["createdAt"].as_i64()));
    out
}
fn size_of(p: &Path) -> u64 {
    omni_control::database_fs::stat(p).map_or(0, |s| s.len())
}
fn dir_bytes(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| {
            let Ok(t) = e.file_type() else {
                return 0;
            };
            if t.is_dir() {
                dir_bytes(&e.path())
            } else {
                size_of(&e.path())
            }
        })
        .sum()
}
fn bytes(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1048576 {
        format!("{} KB", fixed_tenth(n, 1024))
    } else {
        format!("{} MB", fixed_tenth(n, 1048576))
    }
}
fn fixed_tenth(n: u64, divisor: u128) -> String {
    // JS first converts the byte count to Number. Powers-of-two divisors
    // are exact, so integer rounding reproduces toFixed's ties upwards.
    let value = (n as f64) as u128;
    let tenths = (value * 10 + divisor / 2) / divisor;
    format!("{}.{:01}", tenths / 10, tenths % 10)
}
fn time(at: Option<i64>) -> String {
    at.and_then(chrono::DateTime::from_timestamp_millis)
        .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or("—".into())
}
pub(crate) fn confirm(question: &str) -> Result<(), String> {
    use std::io::{BufRead, IsTerminal, Write};
    if !std::io::stdin().is_terminal() {
        return Err(format!("{question} — refusing without --yes"));
    }
    eprint!("{question} [y/N] ");
    std::io::stderr().flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    eprintln!();
    if !matches!(
        omni_ir::js::trim(&line).to_lowercase().as_str(),
        "y" | "yes"
    ) {
        return Err("cancelled".into());
    }
    Ok(())
}

fn preview_table(preview: &Value) -> String {
    let mut names = ["snapshot", "live"]
        .iter()
        .filter_map(|side| preview[side].as_object())
        .flat_map(|counts| counts.keys().cloned())
        .collect::<Vec<_>>();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names.dedup();
    let rows = names
        .into_iter()
        .map(|name| {
            let cell = |side: &str| {
                preview[side]
                    .get(&name)
                    .map(Value::to_string)
                    .unwrap_or_else(|| "—".into())
            };
            vec![name.clone(), cell("snapshot"), cell("live")]
        })
        .collect::<Vec<_>>();
    let body = table(&["TABLE", "SNAPSHOT", "LIVE"], &rows, &[1, 2]);
    if preview["live"].is_null() {
        format!("{body}\n\nthe live database could not be read, so the LIVE column is unknown")
    } else {
        body
    }
}

fn table(headers: &[&str], rows: &[Vec<String>], right: &[usize]) -> String {
    let widths = headers
        .iter()
        .enumerate()
        .map(|(i, h)| {
            rows.iter()
                .map(|r| r[i].encode_utf16().count())
                .max()
                .unwrap_or(0)
                .max(h.len())
        })
        .collect::<Vec<_>>();
    std::iter::once(headers.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        .chain(rows.iter().cloned())
        .map(|r| {
            r.iter()
                .enumerate()
                .map(|(i, s)| {
                    let pad = " ".repeat(widths[i] - s.encode_utf16().count());
                    if right.contains(&i) {
                        format!("{pad}{s}")
                    } else {
                        format!("{s}{pad}")
                    }
                })
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
