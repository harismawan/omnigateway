use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn numbers_match_real_bun_including_shortest_ties() {
    let mut values = vec![2.0f64.powi(-25), -0.0, f64::MIN_POSITIVE, f64::MAX];
    let mut bits = 0x9271_afbe_1234_5678u64;
    for _ in 0..20_000 {
        bits ^= bits << 13;
        bits ^= bits >> 7;
        bits ^= bits << 17;
        let value = f64::from_bits(bits);
        if value.is_finite() {
            values.push(value);
        }
    }
    let input = values
        .iter()
        .map(|v| v.to_bits().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let mut child = Command::new("bun").args(["-e", "const a=new ArrayBuffer(8), d=new DataView(a);for(const x of (await Bun.stdin.text()).trim().split('\\n')){d.setBigUint64(0,BigInt(x));console.log(JSON.stringify(d.getFloat64(0)))}"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("Bun oracle required");
    let mut stdin = child.stdin.take().expect("piped stdin");
    let writer = std::thread::spawn(move || {
        stdin
            .write_all(input.as_bytes())
            .expect("write oracle input")
    });
    let output = child.wait_with_output().expect("wait oracle");
    writer.join().expect("input writer");
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).expect("oracle UTF-8");
    assert_eq!(text.lines().count(), values.len());
    for (value, expected) in values.into_iter().zip(text.lines()) {
        let mut actual = String::new();
        omni_ir::jsjson::write_number(value, &mut actual);
        assert_eq!(actual, expected, "bits={:016x}", value.to_bits());
    }
}
