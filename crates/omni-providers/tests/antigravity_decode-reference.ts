import { decodeAntigravityStream } from '../../../packages/providers/src/antigravity/decode.ts';
import { parseSse } from '../../../packages/providers/src/sse.ts';
const enc=new TextEncoder(), cases:any[]=[], rows:any[]=[];
const raw=(name:string,ss:string[],cloak:any[]=[])=>cases.push({name,chunks:ss.map(s=>Array.from(enc.encode(s))),cloak});
const frame=(x:any)=>`data: ${JSON.stringify(x)}\n\n`;
const add=(name:string,...xs:any[])=>raw(name,xs.map(frame));
const r=(x:any)=>({response:x}), c=(x:any)=>r({candidates:[x]}), p=(x:any)=>c({content:{parts:x},finishReason:'STOP'});
const text=c({content:{parts:[{text:'before'}]}});
raw('empty',[]);raw('done',['data: [DONE]\n\n']);raw('invalid',['data: {\n\n']);
const values=[undefined,null,false,true,0,2,-1,1.5,1e21,-0,'','x','ab',[],[null],{}, {length:0},{length:2},{toString:null}];
for(const [i,v] of values.entries()) {
 add(`frame/${i}`,v);add(`error/${i}`,{error:v});add(`wrapped-error/${i}`,{error:null,response:{error:v}});add(`response/${i}`,r(v));
 for(const k of ['promptFeedback','candidates','usageMetadata','responseId','modelVersion'])add(`${k}/${i}`,r({[k]:v}));
 add(`final-usageMetadata/${i}`,r({candidates:[{finishReason:'STOP'}],usageMetadata:v}));
 add(`candidate-length/${i}`,r({candidates:{length:v,0:{finishReason:'STOP'}}}));
 add(`error-precedence/${i}`,{error:v,response:{error:{status:'UNAUTHENTICATED'}}});
 add(`candidate/${i}`,r({candidates:[v]}));add(`content/${i}`,c({content:v,finishReason:'STOP'}));add(`parts/${i}`,c({content:{parts:v},finishReason:'STOP'}));add(`part/${i}`,p([v]));add(`functionCall/${i}`,p([{functionCall:v,text:'fallback'}]));
 for(const k of ['name','id','args'])add(`${k}/${i}`,p([{functionCall:{name:'wire',[k]:v},text:'fallback'}]));
 for(const k of ['text','thought'])add(`${k}/${i}`,p([{text:'',[k]:v}]));
 add(`finishReason/${i}`,text,c({finishReason:v}));
 for(const k of ['status','message'])add(`failure-${k}/${i}`,text,{error:{[k]:v}});
 for(const k of ['promptTokenCount','candidatesTokenCount','thoughtsTokenCount','cachedContentTokenCount'])add(`count-${k}/${i}`,r({candidates:[{finishReason:'STOP'}],usageMetadata:{[k]:v}}));
 for(const candidates of [undefined,[],[{}],0,'',{}, {length:0}])for(const prefix of [[],[text]])add(`blocked/${i}/${JSON.stringify(candidates)}/${prefix.length}`,...prefix,r({promptFeedback:{blockReason:v},candidates}));
}
for(const s of ['STOP','MAX_TOKENS','SAFETY','PROHIBITED_CONTENT','SPII','BLOCKLIST','RECITATION','MALFORMED_FUNCTION_CALL','unknown','toString','__proto__','constructor','hasOwnProperty']) {
 add(`stop/${s}`,text,c({finishReason:s}),{response:null});
 add(`tool-stop/${s}`,c({content:{parts:[{functionCall:{name:'wire'}}]},finishReason:s}));
}
for(const s of ['RESOURCE_EXHAUSTED','UNAUTHENTICATED','PERMISSION_DENIED','INVALID_ARGUMENT','FAILED_PRECONDITION','UNAVAILABLE','INTERNAL','DEADLINE_EXCEEDED','unknown','toString','__proto__','constructor','hasOwnProperty']) {
 add(`error-code/${s}`,text,{error:{status:s,message:'bad'}},{response:null});add(`wrapped-code/${s}`,r({error:{status:s}}));
}
add('alternation',p([{text:'a'},{text:''},{text:'b',thought:true},{text:'c'},{functionCall:{name:'wire'}},{text:'d'},{functionCall:{name:'unknown',id:''}},{functionCall:{name:'wire',id:'given'}}]));
raw('cloak',[frame(p([{functionCall:{name:'wire'}},{functionCall:{name:'unknown'}}]))],[['wire','original / tool']]);
add('two-candidates',r({candidates:[{},{}]}));
add('cross-frame-block',text,text,c({finishReason:'STOP'}));
for(const v of [{toString:{}},{toString:[]},{toString:'x'},{toString:null,valueOf:2},['STOP'],{valueOf:null}]) {
 for(const k of ['responseId','modelVersion'])add(`coercion/${k}/${JSON.stringify(v)}`,r({[k]:v}));
 for(const k of ['status','message'])add(`coercion/${k}/${JSON.stringify(v)}`,text,{error:{[k]:v}});
 add(`coercion/finish/${JSON.stringify(v)}`,text,c({finishReason:v}));
}
add('nonfinal-usage',r({usageMetadata:{promptTokenCount:99}}),r({candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:8,cachedContentTokenCount:3,candidatesTokenCount:2,thoughtsTokenCount:4}}));
for(const args of ['-0','1e21','1E2','9007199254740993','1.0','{"b":1,"2":2,"a":3,"b":4,"__proto__":5}','"\\n\\t\\\""'])raw(`raw-args/${args}`,[`data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":${args}}}]},"finishReason":"STOP"}]}}\n\n`]);
const bytes=enc.encode(frame(p([{text:'é😀'}])));
for(let i=0;i<=bytes.length;i++)cases.push({name:`split/${i}`,chunks:[Array.from(bytes.slice(0,i)),Array.from(bytes.slice(i))],cloak:[]});
raw('crlf',[frame(p([{text:'hi'}])).replaceAll('\n','\r\n')]);raw('multiline',[': comment\nevent: ignored\ndata: {"response":\ndata: {"candidates":[{"finishReason":"STOP"}]}}\n\n']);raw('no-data',['event: ignored\n\n']);raw('unterminated',[frame(p([])).trimEnd()]);
if(process.argv.includes('--depth')){cases.length=0;for(const n of [100,1000,5000,10000,39990])raw(`depth/${n}`,[`data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":${'['.repeat(n)}0${']'.repeat(n)}}}]},"finishReason":"STOP"}]}}\n\n`]);}
if(process.argv.includes('--bounded-depth')) {
 cases.length=0;
 const nested=(n:number)=>'['.repeat(n)+'0'+']'.repeat(n);
 const frames=[
  ['ignored',`{"response":{"candidates":[{"finishReason":"STOP"}],"ignored":${nested(39999)}}}`],
  ['usageMetadata',`{"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":${nested(39999)}}}`],
  ['error',`{"error":${nested(40000)}}`],
  ['args',`{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":${nested(39993)}}}]},"finishReason":"STOP"}]}}`],
  ['args-stringify',`{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":${nested(40001)}}}]},"finishReason":"STOP"}]}}`],
 ];
 for(const [position,json] of frames) for(const prior of [false,true]) {
  raw(`bounded-depth/${position}/${prior?'after-text':'first'}`,[...(prior?[frame(text)]:[]),`data: ${json}\n\n`]);
 }
}
if(process.argv.includes('--x1')){cases.length=0;
 raw('X1/text-surrogate',['data: {"response":{"candidates":[{"content":{"parts":[{"text":"\\ud800"}]},"finishReason":"STOP"}]}}\n\n']);
 raw('X1/args-surrogate',['data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":"\\ud800"}}]},"finishReason":"STOP"}]}}\n\n']);
 raw('X1/overflow',['data: {"response":{"responseId":1e309,"candidates":[{"finishReason":"STOP"}]}}\n\n']);}
for(const x of cases){if(process.argv.some(a=>a.startsWith('X1/'))&&!process.argv.includes(x.name))continue;const events:any[]=[];let thrown:any=null;const body=new ReadableStream<Uint8Array>({start(controller){for(const b of x.chunks)controller.enqueue(new Uint8Array(b));controller.close();}});
 try{for await(const e of decodeAntigravityStream(parseSse(body),{cloak:{fromWire:new Map(x.cloak),toWire:new Map()}}))events.push(e);}catch(e){thrown={name:(e as Error).name,message:(e as Error).message,guard:'antigravity codec decode threw'};}
 rows.push({...x,events,thrown});}
console.log(JSON.stringify(rows));
