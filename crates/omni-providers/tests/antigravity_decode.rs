use omni_providers::{codec::{DecodeError, Flow, StreamDecoder}, sse::SseParser};
use std::collections::VecDeque;
// RED baseline until the decoder is implemented.
type AntigravityDecoder = omni_providers::anthropic::decode::AnthropicDecoder;
#[test]
fn frozen_corpus() { compare(""); }
#[test]
#[ignore = "X1: lone UTF-16 text/tool JSON surrogates and overflow numbers"]
fn x1_retained_red() { compare("--x1"); }
fn compare(mode: &str) {
 let run=std::process::Command::new("bun").args(["--no-env-file","tests/antigravity_decode-reference.ts",mode]).current_dir(env!("CARGO_MANIFEST_DIR")).output().expect("bun");
 assert!(run.status.success(),"{}",String::from_utf8_lossy(&run.stderr));
 let rows:serde_json::Value=serde_json::from_slice(&run.stdout).expect("rows");let mut red=0;
 for row in rows.as_array().unwrap() {
  let mut decoder=AntigravityDecoder::default();let mut parser=SseParser::new();let mut messages=Vec::new();
  for chunk in row["chunks"].as_array().unwrap(){parser.push(&chunk.as_array().unwrap().iter().map(|v|v.as_u64().unwrap() as u8).collect::<Vec<_>>(),&mut messages).unwrap();}if let Some(m)=parser.finish(){messages.push(m);}
  let mut out=VecDeque::new();let mut stopped=false;let mut threw=false;
  for msg in messages{match decoder.message(&msg,&mut out){Ok(Flow::Continue)=>{},Ok(Flow::Stop)=>{stopped=true;break},Err(DecodeError::Throw(_))=>{threw=true;stopped=true;break},Err(e)=>panic!("{e:?}")}}
  if !stopped{decoder.finish(&mut out);}
  let actual=serde_json::Value::Array(out.iter().map(|e|serde_json::from_str(&e.to_json()).unwrap()).collect());
  if actual!=row["events"] || threw!=!row["thrown"].is_null(){red+=1;eprintln!("RED {}: actual {actual} threw={threw}; expected {}",row["name"],row["events"]);}
 }
 let total=rows.as_array().unwrap().len();eprintln!("decoder corpus: {} green / {red} red / {total} total",total-red);assert_eq!(red,0);
}
