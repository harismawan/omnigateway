use std::{
    collections::HashMap,
    io::{IsTerminal, Read},
    process::{Command, Stdio},
};

// stty owns the platform termios boundary; no unsafe FFI in the CLI.
struct Terminal(String);
impl Drop for Terminal {
    fn drop(&mut self) {
        drop(
            Command::new("stty")
                .arg(&self.0)
                .stdin(Stdio::inherit())
                .status(),
        );
    }
}
fn secret(question: &str) -> Result<String, String> {
    let saved = Command::new("stty")
        .arg("-g")
        .stdin(Stdio::inherit())
        .output()
        .map_err(|e| e.to_string())?;
    if !saved.status.success() {
        return Err("could not read terminal settings".into());
    }
    let _terminal = Terminal(String::from_utf8_lossy(&saved.stdout).trim().into());
    if !Command::new("stty")
        .args(["-icanon", "-echo", "-isig", "min", "1", "time", "0"])
        .stdin(Stdio::inherit())
        .status()
        .map_err(|e| e.to_string())?
        .success()
    {
        return Err("could not configure terminal".into());
    }
    let mut pending = Vec::new();
    let mut line: Vec<u16> = Vec::new();
    let mut first = true;
    eprintln!("{question}");
    let mut input = std::io::stdin().lock();
    let result: Result<(), String> = loop {
        let mut b = [0];
        if input.read(&mut b).map_err(|e| e.to_string())? == 0 {
            break Ok(());
        }
        pending.push(b[0]);
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
                    decoded.push_str(std::str::from_utf8(&pending[..valid]).expect("valid prefix"));
                    pending.drain(..valid);
                    if let Some(len) = e.error_len() {
                        decoded.push('\u{fffd}');
                        pending.drain(..len);
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
    eprintln!();
    Ok(omni_ir::js::trim(&String::from_utf16_lossy(&line)).into())
}
pub fn run(flags: &HashMap<String, String>) -> Result<String, String> {
    let store = crate::context::open(flags)?;
    let password = if std::io::stdin().is_terminal() {
        let password = secret("New admin password: ")?;
        let again = secret("Repeat it: ")?;
        if again != password {
            return Err("the two passwords do not match".into());
        }
        password
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
