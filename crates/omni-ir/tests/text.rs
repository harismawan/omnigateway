use omni_ir::text::Text;

#[test]
fn repaired_pairs_equal_utf8_without_losing_literal_escapes() {
    let mut split = Text::from_utf16(vec![0xd83d]);
    split.push(&Text::from_utf16(vec![0xde00]));
    assert_eq!(split, Text::from("😀"));
    let mut json = String::new();
    Text::from(r"\ud800").write_json(&mut json);
    assert_eq!(json, r#""\\ud800""#);
}
