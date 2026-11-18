#![allow(clippy::unwrap_used)]
use omni_gateway::stream_codec::{Codec, Event, accept, encode};

fn frame(op: u8, fin: bool, data: &[u8]) -> Vec<u8> {
    let mut out = encode(op, data);
    out[0] = op | if fin { 128 } else { 0 };
    out[1] |= 128;
    let at = match data.len() {
        0..=125 => 2,
        126..=65535 => 4,
        _ => 10,
    };
    out.splice(at..at, [1, 2, 3, 4]);
    for (i, b) in out[at + 4..].iter_mut().enumerate() {
        *b ^= [1, 2, 3, 4][i % 4];
    }
    out
}

#[test]
fn handshake() {
    assert_eq!(
        accept("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
}

#[test]
fn lengths_and_incremental() {
    let mut c = Codec::new(125);
    let mut joined = frame(1, true, &[b'x'; 125]);
    joined.extend(frame(9, true, b"p"));
    c.feed(&joined).unwrap();
    assert!(matches!(c.next_event().unwrap(), Some(Event::Text(_))));
    assert_eq!(c.next_event().unwrap(), Some(Event::Ping(b"p".to_vec())));
    for n in [0, 1, 125, 126, 65535, 65536] {
        let payload = vec![b'x'; n];
        let wire = frame(1, true, &payload);
        let mut c = Codec::new(100000);
        for b in &wire[..wire.len() - 1] {
            c.feed(&[*b]).unwrap();
            assert!(c.next_event().unwrap().is_none());
        }
        c.feed(&wire[wire.len() - 1..]).unwrap();
        assert_eq!(
            c.next_event().unwrap(),
            Some(Event::Text(String::from_utf8(payload).unwrap()))
        );
    }
}

#[test]
fn fragmentation_and_controls() {
    let mut c = Codec::new(100);
    for (op, fin, data, event) in [
        (1, false, &b"\xe2"[..], None),
        (9, true, &b"ping"[..], Some(Event::Ping(b"ping".to_vec()))),
        (0, true, &b"\x82\xac"[..], Some(Event::Text("€".into()))),
        (10, true, &b""[..], Some(Event::Pong(vec![]))),
        (2, true, &b"abc"[..], Some(Event::Binary(b"abc".to_vec()))),
        (
            8,
            true,
            &b"\x03\xe8bye"[..],
            Some(Event::Close(b"\x03\xe8bye".to_vec())),
        ),
    ] {
        c.feed(&frame(op, fin, data)).unwrap();
        assert_eq!(c.next_event().unwrap(), event);
    }
}

#[test]
fn malformed() {
    let cases = [
        (encode(1, b"unmasked"), 1002),
        (frame(3, true, b""), 1002),
        (frame(0, true, b""), 1002),
        (frame(9, false, b""), 1002),
        (frame(9, true, &[0; 126]), 1002),
        (frame(1, true, b"\xff"), 1007),
        (frame(8, true, b"x"), 1002),
        (frame(8, true, b"\x03\xed"), 1002),
        (frame(8, true, b"\x03\xe8\xff"), 1007),
        (vec![0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0], 1009),
        (vec![0x81, 0xfe, 0, 1], 1002),
    ];
    for (wire, code) in cases {
        let mut c = Codec::new(1000);
        c.feed(&wire).unwrap();
        assert_eq!(c.next_event().unwrap_err(), code);
    }
    let mut c = Codec::new(2);
    c.feed(&frame(1, true, b"abc")).unwrap();
    assert_eq!(c.next_event().unwrap_err(), 1009);
    let mut c = Codec::new(3);
    c.feed(&frame(1, false, b"ab")).unwrap();
    assert_eq!(c.next_event().unwrap(), None);
    c.feed(&frame(0, true, b"cd")).unwrap();
    assert_eq!(c.next_event().unwrap_err(), 1009);
    let mut c = Codec::new(10);
    c.feed(&frame(1, false, b"a")).unwrap();
    c.next_event().unwrap();
    c.feed(&frame(1, true, b"b")).unwrap();
    assert_eq!(c.next_event().unwrap_err(), 1002);
    let mut c = Codec::new(10);
    let mut wire = frame(1, true, b"x");
    wire[0] |= 64;
    c.feed(&wire).unwrap();
    assert_eq!(c.next_event().unwrap_err(), 1002);
}

#[test]
fn frozen_close_reasons() {
    for (wire, code, reason) in [
        (
            encode(1, b"x"),
            1002,
            "Received an incorrectly masked frame",
        ),
        (frame(3, true, b""), 1002, "Received invalid opcode"),
        (
            frame(9, false, b""),
            1002,
            "Received fragmented control frame",
        ),
        (
            frame(9, true, &[0; 126]),
            1002,
            "Received too big control frame",
        ),
        (frame(1, true, b"\xff"), 1007, "Received invalid UTF-8"),
        (
            frame(8, true, b"\x03\xed"),
            1002,
            "Received invalid close code",
        ),
    ] {
        let mut codec = Codec::new(1000);
        codec.feed(&wire).unwrap();
        assert_eq!(codec.next_event().unwrap_err(), code);
        assert_eq!(codec.error_reason, reason);
    }
    // A successful text decode must not leave a reason for a later,
    // unrelated protocol error on the same connection.
    let mut codec = Codec::new(1000);
    codec.feed(&frame(1, true, b"ok")).unwrap();
    codec.next_event().unwrap();
    codec.feed(&frame(0, true, b"")).unwrap();
    assert_eq!(codec.next_event().unwrap_err(), 1002);
    assert_eq!(
        codec.error_reason,
        "Received continuation frame outside a fragmented message"
    );
}

#[test]
fn additional_frozen_reason_bytes() {
    for (raw, reason) in [
        (vec![0xc1, 128, 1, 2, 3, 4], "Received unexpected RSV1 bit"),
        (
            vec![0xa1, 128, 1, 2, 3, 4],
            "Received unexpected RSV2 or RSV3 bit",
        ),
        (
            vec![0x80, 128, 1, 2, 3, 4],
            "Received continuation frame outside a fragmented message",
        ),
        (
            vec![0x88, 129, 1, 2, 3, 4, 0],
            "Received invalid close payload",
        ),
    ] {
        let mut codec = omni_gateway::stream_codec::Codec::new(1024);
        codec.feed(&raw).expect("bounded feed");
        assert_eq!(codec.next_event(), Err(1002));
        assert_eq!(codec.error_reason, reason);
    }
}
