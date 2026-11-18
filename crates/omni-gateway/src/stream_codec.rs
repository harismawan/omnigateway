//! Bounded RFC 6455 server codec. No extensions are negotiated.
use base64::{Engine, engine::general_purpose::STANDARD};
use sha1::{Digest, Sha1};

pub const MAX_PAYLOAD: usize = 16 * 1024 * 1024;

pub fn accept(key: &str) -> String {
    let mut hash = Sha1::new();
    hash.update(key.as_bytes());
    hash.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    STANDARD.encode(hash.finalize())
}

pub fn encode(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 10);
    out.push(128 | opcode);
    match payload.len() {
        0..=125 => out.push(payload.len() as u8),
        126..=65535 => {
            out.push(126);
            out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        _ => {
            out.push(127);
            out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
    }
    out.extend_from_slice(payload);
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close(Vec<u8>),
}

pub struct Codec {
    input: Vec<u8>,
    offset: usize,
    fragment: Option<(u8, Vec<u8>)>,
    max: usize,
    pub error_reason: &'static str,
}

impl Codec {
    pub fn new(max: usize) -> Self {
        Self {
            input: Vec::new(),
            offset: 0,
            fragment: None,
            max,
            error_reason: "",
        }
    }

    /// Feed bounded transport reads, draining events between reads.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<(), u16> {
        if self.offset != 0 {
            self.input.drain(..self.offset);
            self.offset = 0;
        }
        if self.input.len().saturating_add(bytes.len())
            > self.max.saturating_add(14).max(139).saturating_add(8192)
        {
            return Err(1009);
        }
        self.input.extend_from_slice(bytes);
        Ok(())
    }

    pub fn next_event(&mut self) -> Result<Option<Event>, u16> {
        self.error_reason = "";
        loop {
            let b = &self.input[self.offset..];
            if b.len() < 2 {
                return Ok(None);
            }
            let fin = b[0] & 128 != 0;
            let op = b[0] & 15;
            let control = op >= 8;
            if b[0] & 112 != 0 {
                self.error_reason = if b[0] & 48 != 0 {
                    "Received unexpected RSV2 or RSV3 bit"
                } else {
                    "Received unexpected RSV1 bit"
                };
                return Err(1002);
            }
            if b[1] & 128 == 0 {
                self.error_reason = "Received an incorrectly masked frame";
                return Err(1002);
            }
            if !matches!(op, 0 | 1 | 2 | 8 | 9 | 10) {
                self.error_reason = "Received invalid opcode";
                return Err(1002);
            }
            if control && !fin {
                self.error_reason = "Received fragmented control frame";
                return Err(1002);
            }
            let short = b[1] & 127;
            if control && short > 125 {
                self.error_reason = "Received too big control frame";
                return Err(1002);
            }
            let (len, at) = match short {
                126 => {
                    if b.len() < 4 {
                        return Ok(None);
                    }
                    let n = u16::from_be_bytes([b[2], b[3]]) as u64;
                    if n < 126 {
                        return Err(1002);
                    }
                    (n, 4)
                }
                127 => {
                    if b.len() < 10 {
                        return Ok(None);
                    }
                    let n = u64::from_be_bytes(b[2..10].try_into().expect("eight bytes"));
                    if n >> 63 != 0 {
                        return Err(1009);
                    }
                    if n < 65536 {
                        return Err(1002);
                    }
                    (n, 10)
                }
                n => (n as u64, 2),
            };
            if !control {
                if (op == 0) != self.fragment.is_some() {
                    self.error_reason = if op == 0 {
                        "Received continuation frame outside a fragmented message"
                    } else {
                        "Received new message inside a fragmented message"
                    };
                    return Err(1002);
                }
                let held = self.fragment.as_ref().map_or(0, |(_, data)| data.len());
                if len > self.max.saturating_sub(held) as u64 {
                    return Err(1009);
                }
            }
            let len = usize::try_from(len).map_err(|_| 1009u16)?;
            let end = at + 4 + len;
            if b.len() < end {
                return Ok(None);
            }
            let mask = &b[at..at + 4];
            let payload: Vec<u8> = b[at + 4..end]
                .iter()
                .enumerate()
                .map(|(i, v)| v ^ mask[i % 4])
                .collect();
            self.offset += end;
            match op {
                8 => {
                    if payload.len() == 1 {
                        self.error_reason = "Received invalid close payload";
                        return Err(1002);
                    }
                    if payload.len() >= 2 {
                        let code = u16::from_be_bytes([payload[0], payload[1]]);
                        if !(matches!(code, 1000..=1003 | 1007..=1014)
                            || (3000..=4999).contains(&code))
                        {
                            self.error_reason = "Received invalid close code";
                            return Err(1002);
                        }
                        self.error_reason = "Received invalid UTF-8";
                        std::str::from_utf8(&payload[2..]).map_err(|_| 1007u16)?;
                    }
                    return Ok(Some(Event::Close(payload)));
                }
                9 => return Ok(Some(Event::Ping(payload))),
                10 => return Ok(Some(Event::Pong(payload))),
                _ => {
                    let (kind, data) = if op == 0 {
                        let (kind, mut data) = self.fragment.take().expect("checked fragment");
                        data.extend_from_slice(&payload);
                        (kind, data)
                    } else {
                        (op, payload)
                    };
                    if !fin {
                        self.fragment = Some((kind, data));
                        continue;
                    }
                    return Ok(Some(if kind == 1 {
                        self.error_reason = "Received invalid UTF-8";
                        Event::Text(String::from_utf8(data).map_err(|_| 1007u16)?)
                    } else {
                        Event::Binary(data)
                    }));
                }
            }
        }
    }
}
