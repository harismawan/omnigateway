use omni_ir::text::Text;

#[test]
fn text_concatenation_matches_javascript_utf16() {
    let run = std::process::Command::new("bun")
        .args(["-e", r#"console.log(JSON.stringify([['a\ud800','b'],['\ud83d','\ude00'],['\udfff','\ud800'],['😀','é'],['','\ud800']].map(parts=>({parts:parts.map(s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i))),json:JSON.stringify(parts.join(''))}))))"#])
        .output().expect("bun");
    assert!(run.status.success());
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("oracle");
    for row in rows.as_array().expect("rows") {
        let mut text = Text::default();
        for part in row["parts"].as_array().expect("parts") {
            let units = part
                .as_array()
                .expect("units")
                .iter()
                .map(|v| u16::try_from(v.as_u64().expect("unit")).expect("u16"))
                .collect();
            text.push(&Text::from_utf16(units));
        }
        let mut json = String::new();
        text.write_json(&mut json);
        assert_eq!(json, row["json"].as_str().expect("JSON string"));
    }
}

#[test]
fn repaired_pairs_equal_utf8_without_losing_literal_escapes() {
    let mut split = Text::from_utf16(vec![0xd83d]);
    split.push(&Text::from_utf16(vec![0xde00]));
    assert_eq!(split, Text::from("😀"));
    let mut json = String::new();
    Text::from(r"\ud800").write_json(&mut json);
    assert_eq!(json, r#""\\ud800""#);
}
