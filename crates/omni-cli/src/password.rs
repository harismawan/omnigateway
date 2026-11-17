use std::{
    collections::HashMap,
    io::{IsTerminal, Read, Write},
};

use rustix::termios::{OptionalActions, Termios, tcgetattr, tcsetattr};
struct Terminal(Termios);
impl Drop for Terminal {
    fn drop(&mut self) {
        let _restored = tcsetattr(std::io::stdin(), OptionalActions::Now, &self.0);
    }
}
pub(crate) fn secret(question: &str) -> Result<Vec<u16>, String> {
    let saved = tcgetattr(std::io::stdin()).map_err(|e| e.to_string())?;
    let mut raw = saved.clone();
    raw.make_raw();
    // libuv raw mode preserves output processing (including terminal CRLF).
    raw.output_modes = saved.output_modes;
    let _terminal = Terminal(saved);
    tcsetattr(std::io::stdin(), OptionalActions::Now, &raw).map_err(|e| e.to_string())?;
    let mut pending = Vec::new();
    let mut line: Vec<u16> = Vec::new();
    let mut first = true;
    writeln!(std::io::stderr().lock(), "{question}").map_err(|e| e.to_string())?;
    let mut input = std::io::stdin().lock();
    let result: Result<(), String> = loop {
        let mut b = [0];
        if input.read(&mut b).map_err(|e| e.to_string())? == 0 {
            break Ok(());
        }
        let [byte] = b;
        pending.push(byte);
        let mut decoded = String::new();
        loop {
            match std::str::from_utf8(&pending) {
                Ok(s) => {
                    decoded.push_str(s);
                    pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    let prefix = pending.get(..valid).ok_or("invalid UTF8 prefix length")?;
                    decoded.push_str(std::str::from_utf8(prefix).map_err(|e| e.to_string())?);
                    pending = pending
                        .get(valid..)
                        .ok_or("invalid UTF8 prefix length")?
                        .to_vec();
                    if let Some(len) = e.error_len() {
                        decoded.push('\u{fffd}');
                        pending = pending
                            .get(len..)
                            .ok_or("invalid UTF8 error length")?
                            .to_vec();
                    } else {
                        break;
                    }
                }
            }
        }
        let mut done = false;
        for c in decoded.chars() {
            if first {
                first = false;
                if c == '\u{feff}' {
                    continue;
                }
            }
            match c {
                '\r' | '\n' => {
                    done = true;
                    break;
                }
                '\u{3}' => return Err("cancelled".into()),
                '\u{8}' | '\u{7f}' => {
                    line.pop();
                }
                c => {
                    let mut buf = [0; 2];
                    line.extend_from_slice(c.encode_utf16(&mut buf));
                }
            }
        }
        if done {
            break Ok(());
        }
    };
    drop(_terminal);
    result?;
    writeln!(std::io::stderr().lock()).map_err(|e| e.to_string())?;
    let whitespace = |u: &u16| {
        char::from_u32(u32::from(*u)).is_some_and(|c| {
            let mut buf = [0; 4];
            omni_ir::js::trim(c.encode_utf8(&mut buf)).is_empty()
        })
    };
    let start = line
        .iter()
        .position(|u| !whitespace(u))
        .unwrap_or(line.len());
    let end = line
        .iter()
        .rposition(|u| !whitespace(u))
        .map_or(start, |i| i + 1);
    Ok(line[start..end].to_vec())
}
pub fn run(flags: &HashMap<String, String>) -> Result<String, String> {
    let store = crate::context::open(flags)?;
    let password = if std::io::stdin().is_terminal() {
        let password = secret("New admin password: ")?;
        let again = secret("Repeat it: ")?;
        if again != password {
            return Err("the two passwords do not match".into());
        }
        String::from_utf16_lossy(&password)
    } else {
        let mut bytes = Vec::new();
        std::io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        omni_ir::js::trim(&String::from_utf8_lossy(&bytes)).into()
    };
    omni_control::admin_password::set_admin_password(&store, &password)
        .map_err(|e| e.to_string())?;
    if flags.contains_key("json") {
        Ok("{\n  \"ok\": true\n}".into())
    } else {
        eprintln!("restart the gateway to end sessions signed in with the old password");
        Ok("admin password set".into())
    }
}
