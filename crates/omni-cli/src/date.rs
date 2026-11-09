//! CLI Date.parse compatibility. ISO dates are UTC; offset-free datetimes and
//! legacy dates use the process local timezone, as the frozen Bun command does.
use chrono::{Local, NaiveDate, TimeZone};

fn local(naive: &chrono::NaiveDateTime) -> Option<i64> {
    if let Some(date) = Local.from_local_datetime(naive).earliest() {
        let mut stamp = date.timestamp_millis();
        // Some host local-time adapters return a single side of a fold.
        // Validate earlier candidates by roundtripping through the timezone.
        for minutes in 1..=1440 {
            let candidate = stamp - i64::from(minutes) * 60000;
            if Local
                .timestamp_millis_opt(candidate)
                .single()
                .is_some_and(|d| d.naive_local() == *naive)
            {
                stamp = candidate;
                break;
            }
        }
        return Some(stamp);
    }
    // Date's compatible disambiguation advances through a DST gap using the
    // offset before the transition; folds choose the earlier instant above.
    for minutes in 1..=1440 {
        let before = naive.checked_sub_signed(chrono::Duration::minutes(minutes))?;
        if let Some(date) = Local.from_local_datetime(&before).earliest() {
            return Some(
                naive.and_utc().timestamp_millis()
                    - i64::from(date.offset().local_minus_utc()) * 1000,
            );
        }
    }
    None
}

fn civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    (era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + day - 1 - 719468)
        * 86400000
}

pub fn parse(raw: &str) -> Option<i64> {
    let result = iso(raw).or_else(|| legacy(raw))?;
    (result.abs() <= 8_640_000_000_000_000).then_some(result)
}

fn iso(raw: &str) -> Option<i64> {
    if !raw.is_ascii() {
        return None;
    }
    let (date, time) = raw
        .split_once('T')
        .map_or((raw, None), |(d, t)| (d, Some(t)));
    let n = if date.starts_with(['+', '-']) { 7 } else { 4 };
    let year: i64 = date.get(..n)?.parse().ok()?;
    if !date
        .get(usize::from(n == 7)..n)?
        .bytes()
        .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    if date.starts_with("-000000") {
        return None;
    }
    let tail = date.get(n..)?;
    let parts: Vec<_> = tail.split('-').collect();
    let (month, day) = match parts.as_slice() {
        [""] => (1, 1),
        ["", m] if m.len() == 2 => (m.parse::<i64>().ok()?, 1),
        ["", m, d] if m.len() == 2 && d.len() == 2 => {
            (m.parse::<i64>().ok()?, d.parse::<i64>().ok()?)
        }
        _ => return None,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let base = civil(year, month, day);
    let Some(time) = time else {
        return Some(base);
    };
    if parts.len() != 3 {
        return None;
    }
    let (clock, offset) = if let Some(t) = time.strip_suffix('Z') {
        (t, Some(0))
    } else if let Some(i) = time.find(['+', '-']) {
        let zone = &time[i + 1..];
        if !(zone.len() == 4 && zone.bytes().all(|b| b.is_ascii_digit())
            || zone.len() == 5
                && zone.as_bytes()[2] == b':'
                && zone
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| i == 2 || b.is_ascii_digit()))
        {
            return None;
        }
        let zone = zone.replace(':', "");
        if zone.len() != 4 {
            return None;
        }
        let h: i64 = zone[..2].parse().ok()?;
        let m: i64 = zone[2..].parse().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        (
            &time[..i],
            Some((h * 60 + m) * 60000 * if time.as_bytes()[i] == b'+' { 1 } else { -1 }),
        )
    } else {
        (time, None)
    };
    let p: Vec<_> = clock.split(':').collect();
    if !clock
        .bytes()
        .all(|b| b.is_ascii_digit() || b == b':' || b == b'.')
    {
        return None;
    }
    if !(2..=3).contains(&p.len()) || p[0].len() != 2 || p[1].len() != 2 {
        return None;
    }
    let h: i64 = p[0].parse().ok()?;
    let m: i64 = p[1].parse().ok()?;
    let (s, ms) = if let Some(sec) = p.get(2) {
        let (s, f) = sec.split_once('.').unwrap_or((*sec, ""));
        if s.len() != 2
            || (sec.contains('.') && f.is_empty())
            || !f.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let fraction = format!("{f}000");
        (s.parse::<i64>().ok()?, fraction[..3].parse::<i64>().ok()?)
    } else {
        (0, 0)
    };
    if h > 24 || m > 59 || s > 59 || h == 24 && (m != 0 || s != 0 || ms != 0) {
        return None;
    }
    let stamp = base + ((h * 60 + m) * 60 + s) * 1000 + ms;
    match offset {
        Some(offset) => Some(stamp - offset),
        None => {
            let naive = chrono::DateTime::from_timestamp_millis(stamp)?.naive_utc();
            local(&naive)
        }
    }
}

fn legacy(raw: &str) -> Option<i64> {
    let raw = omni_ir::js::trim(raw);
    let slash: Vec<_> = raw.split('/').collect();
    if slash.len() == 3
        && slash
            .iter()
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
    {
        let a: i32 = slash[0].parse().ok()?;
        let b: u32 = slash[1].parse().ok()?;
        let c: i32 = slash[2].parse().ok()?;
        let (y, m, d) = if a >= 100 {
            (a, b, c as u32)
        } else {
            (
                if c < 50 {
                    2000 + c
                } else if c < 100 {
                    1900 + c
                } else {
                    c
                },
                a as u32,
                b,
            )
        };
        return local(&NaiveDate::from_ymd_opt(y, m, d)?.and_hms_opt(0, 0, 0)?);
    }
    if let Some(tail) = raw.strip_prefix("-000000-") {
        return legacy(&format!("2001-{tail}"));
    }
    for format in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(date) = chrono::NaiveDateTime::parse_from_str(raw, format) {
            return local(&date);
        }
    }
    if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        let n: i32 = raw.parse().ok()?;
        let (year, month) = match n {
            0 => (2000, 1),
            1..=12 => (2001, n as u32),
            13..=31 => return None,
            32..=49 => (2000 + n, 1),
            50..=99 => (1900 + n, 1),
            _ => (n, 1),
        };
        return local(&NaiveDate::from_ymd_opt(year, month, 1)?.and_hms_opt(0, 0, 0)?);
    }
    for format in ["%a, %d %b %Y %H:%M:%S %Z", "%d %b %Y %H:%M:%S %Z"] {
        if let Ok(d) = chrono::NaiveDateTime::parse_from_str(raw, format)
            && (raw.ends_with("GMT") || raw.ends_with("UTC"))
        {
            return Some(d.and_utc().timestamp_millis());
        }
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc2822(raw) {
        return Some(d.timestamp_millis());
    }
    for format in ["%Y-%m-%d", "%m/%d/%Y", "%B %d, %Y", "%b %d, %Y", "%B %d %Y"] {
        if let Ok(date) = NaiveDate::parse_from_str(raw, format) {
            return local(&date.and_hms_opt(0, 0, 0)?);
        }
    }
    None
}
